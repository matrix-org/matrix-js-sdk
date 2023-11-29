/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Mocked } from "jest-mock";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    KeyDownloaderEvent,
    KeyDownloadError,
    OnDemandBackupDelegate,
    PerSessionKeyBackupDownloader,
} from "../../../src/rust-crypto/PerSessionKeyBackupDownloader";
import { logger } from "../../../src/logger";
import { defer } from "../../../src/utils";
import { RustBackupCryptoEventMap, RustBackupCryptoEvents, RustBackupDecryptor } from "../../../src/rust-crypto/backup";
import * as TestData from "../../test-utils/test-data";
import { ConnectionError, CryptoEvent, MatrixError, TypedEventEmitter } from "../../../src";

describe("PerSessionKeyBackupDownloader", () => {
    /** The downloader under test */
    let downloader: PerSessionKeyBackupDownloader;

    let delegate: Mocked<OnDemandBackupDelegate>;

    const BACKOFF_TIME = 2000;

    const mockEmitter = new TypedEventEmitter() as TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap>;

    async function expectConfigurationError(error: KeyDownloadError): Promise<void> {
        return new Promise<void>((resolve) => {
            downloader.on(KeyDownloaderEvent.QueryKeyError, (err) => {
                if (err === error) {
                    resolve();
                }
            });
        });
    }
    async function expectLoopStatus(expectedLoopRunning: boolean): Promise<void> {
        return new Promise<void>((resolve) => {
            downloader.on(KeyDownloaderEvent.DownloadLoopStateUpdate, (loopRunning) => {
                if (expectedLoopRunning == loopRunning) {
                    resolve();
                }
            });
        });
    }

    async function expectSessionImported(roomId: string, sessionId: string): Promise<void> {
        return new Promise<void>((resolve) => {
            downloader.on(KeyDownloaderEvent.KeyImported, (r, s) => {
                if (roomId == r && sessionId == s) {
                    resolve();
                }
            });
        });
    }

    beforeEach(async () => {
        delegate = {
            getActiveBackupVersion: jest.fn(),
            getBackupDecryptionKey: jest.fn(),
            requestRoomKeyFromBackup: jest.fn(),
            importRoomKeys: jest.fn(),
            createBackupDecryptor: jest.fn(),
            requestKeyBackupVersion: jest.fn(),
            getCryptoEventEmitter: jest.fn(),
        } as unknown as Mocked<OnDemandBackupDelegate>;

        delegate.getCryptoEventEmitter.mockReturnValue(mockEmitter);

        downloader = new PerSessionKeyBackupDownloader(delegate, logger, BACKOFF_TIME);

        jest.useFakeTimers();
    });

    afterEach(() => {
        downloader.stop();
        jest.useRealTimers();
    });

    describe("Given valid backup available", () => {
        beforeEach(async () => {
            delegate.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);
            delegate.createBackupDecryptor.mockReturnValue({
                decryptSessions: jest.fn().mockResolvedValue([TestData.MEGOLM_SESSION_DATA]),
            } as unknown as RustBackupDecryptor);
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
        });

        it("Should download and import a missing key from backup", async () => {
            const awaitKeyImported = defer<void>();

            delegate.requestRoomKeyFromBackup.mockResolvedValue(TestData.CURVE25519_KEY_BACKUP_DATA);
            delegate.importRoomKeys.mockImplementation(async (keys) => {
                awaitKeyImported.resolve();
            });

            downloader.onDecryptionKeyMissingError("roomId", "sessionId");

            await awaitKeyImported.promise;

            expect(delegate.requestRoomKeyFromBackup).toHaveBeenCalledWith("1", "roomId", "sessionId");
            expect(delegate.createBackupDecryptor).toHaveBeenCalledTimes(1);
        });

        it("Should not hammer the backup if the key is requested repeatedly", async () => {
            const blockOnServerRequest = defer<void>();
            // simulate a key not being in the backup
            delegate.requestRoomKeyFromBackup.mockImplementation(async (version, room, session) => {
                await blockOnServerRequest.promise;
                return TestData.CURVE25519_KEY_BACKUP_DATA;
            });

            // Call 3 times
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId2");

            const session2Imported = new Promise<void>((resolve) => {
                downloader.on(KeyDownloaderEvent.KeyImported, (roomId, sessionId) => {
                    if (sessionId === "sessionId2") {
                        resolve();
                    }
                });
            });
            blockOnServerRequest.resolve();

            await session2Imported;
            expect(delegate.requestRoomKeyFromBackup).toHaveBeenCalledTimes(2);
        });

        it("should continue to next key if current not in backup", async () => {
            delegate.requestRoomKeyFromBackup.mockResolvedValue(TestData.CURVE25519_KEY_BACKUP_DATA);

            delegate.requestRoomKeyFromBackup.mockImplementation(async (version, room, session) => {
                if (session == "sessionA0") {
                    throw new MatrixError(
                        {
                            errcode: "M_NOT_FOUND",
                            error: "No room_keys found",
                        },
                        404,
                    );
                } else if (session == "sessionA1") {
                    return TestData.CURVE25519_KEY_BACKUP_DATA;
                }
            });

            const expectImported = expectSessionImported("!roomA", "sessionA1");
            const expectNotFound = expectConfigurationError(KeyDownloadError.MISSING_DECRYPTION_KEY);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");

            await expectNotFound;
            await expectImported;
        });

        it("Should not query repeatedly for a key not in backup", async () => {
            delegate.requestRoomKeyFromBackup.mockResolvedValue(TestData.CURVE25519_KEY_BACKUP_DATA);

            delegate.requestRoomKeyFromBackup.mockRejectedValue(
                new MatrixError(
                    {
                        errcode: "M_NOT_FOUND",
                        error: "No room_keys found",
                    },
                    404,
                ),
            );

            const expectNotFound = expectConfigurationError(KeyDownloadError.MISSING_DECRYPTION_KEY);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await expectNotFound;

            const currentCallCount = delegate.requestRoomKeyFromBackup.mock.calls.length;

            // Should not query again for a key not in backup

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            expect(delegate.requestRoomKeyFromBackup).toHaveBeenCalledTimes(currentCallCount);

            // advance time to retry
            jest.advanceTimersByTime(BACKOFF_TIME + 10);

            const expectNotFoundSecondAttempt = expectConfigurationError(KeyDownloadError.MISSING_DECRYPTION_KEY);
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            await expectNotFoundSecondAttempt;
        });

        it("Should stop properly", async () => {
            // Simulate a call to stop while request is in flight
            const blockOnServerRequest = defer<void>();
            const requestRoomKeyCalled = defer<void>();

            // Mock the request to block
            delegate.requestRoomKeyFromBackup.mockImplementation(async (version, room, session) => {
                requestRoomKeyCalled.resolve();
                await blockOnServerRequest.promise;
                return TestData.CURVE25519_KEY_BACKUP_DATA;
            });

            const expectStopped = expectConfigurationError(KeyDownloadError.STOPPED);
            const expectLoopStarted = expectLoopStatus(true);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA2");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA3");

            await expectLoopStarted;
            await requestRoomKeyCalled.promise;
            downloader.stop();

            blockOnServerRequest.resolve();
            await expectStopped;
            expect(delegate.importRoomKeys).not.toHaveBeenCalled();
            expect(delegate.requestRoomKeyFromBackup).toHaveBeenCalledTimes(1);
        });
    });

    describe("Given no usable backup available", () => {
        let loopPausedPromise: Promise<void>;
        let configurationErrorPromise: Promise<void>;

        beforeEach(async () => {
            delegate.getActiveBackupVersion.mockResolvedValue(null);
            delegate.getBackupDecryptionKey.mockResolvedValue(null);

            loopPausedPromise = expectLoopStatus(false);

            configurationErrorPromise = expectConfigurationError(KeyDownloadError.CONFIGURATION_ERROR);
        });

        it("Should not query server if no backup", async () => {
            delegate.requestKeyBackupVersion.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should not query server if backup not active", async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // but it's not active
            delegate.getActiveBackupVersion.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should stop if backup key is not cached", async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // it is active
            delegate.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // but the key is not cached
            delegate.getBackupDecryptionKey.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should stop if backup key cached as wrong version", async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // it is active
            delegate.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // but the cached key has the wrong version
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: "0",
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should stop if backup key version does not match the active one", async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // it is active
            delegate.getActiveBackupVersion.mockResolvedValue("0");
            // key for old backup cached
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: "0",
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });
    });

    describe("Given Backup state update", () => {
        it("After initial sync, when backup become trusted it should request keys for past requests", async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);

            // but at this point it's not trusted and we don't have the key
            delegate.getActiveBackupVersion.mockResolvedValue(null);
            delegate.getBackupDecryptionKey.mockResolvedValue(null);

            const configErrorPromise = expectConfigurationError(KeyDownloadError.CONFIGURATION_ERROR);

            const a0Imported = expectSessionImported("!roomA", "sessionA0");
            const a1Imported = expectSessionImported("!roomA", "sessionA1");
            const b1Imported = expectSessionImported("!roomB", "sessionB1");
            const c1Imported = expectSessionImported("!roomC", "sessionC1");

            // During initial sync several keys are requested
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");
            downloader.onDecryptionKeyMissingError("!roomB", "sessionB1");
            downloader.onDecryptionKeyMissingError("!roomC", "sessionC1");

            await configErrorPromise;

            // Now the backup becomes trusted
            delegate.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            delegate.createBackupDecryptor.mockReturnValue({
                decryptSessions: jest.fn().mockResolvedValue([TestData.MEGOLM_SESSION_DATA]),
            } as unknown as RustBackupDecryptor);

            const loopShouldResume = expectLoopStatus(true);
            // In that case the sdk would fire a backup status update
            mockEmitter.emit(CryptoEvent.KeyBackupStatus, true);

            await loopShouldResume;

            await a0Imported;
            await a1Imported;
            await b1Imported;
            await c1Imported;
        });

        it("If reset from other session, loop should stop until new decryption key is known", async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // It's trusted
            delegate.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            delegate.createBackupDecryptor.mockReturnValue({
                decryptSessions: jest.fn().mockResolvedValue([TestData.MEGOLM_SESSION_DATA]),
            } as unknown as RustBackupDecryptor);

            const a0Imported = expectSessionImported("!roomA", "sessionA0");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await a0Imported;

            // Now some other session resets the backup and there is a new version
            // the room_keys/keys endpoint will throw
            delegate.requestRoomKeyFromBackup.mockRejectedValue(
                new MatrixError(
                    {
                        errcode: "M_NOT_FOUND",
                        error: "Unknown backup version",
                    },
                    404,
                ),
            );

            const loopPausedPromise = expectLoopStatus(false);
            const expectMismatch = expectConfigurationError(KeyDownloadError.VERSION_MISMATCH);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");

            await loopPausedPromise;
            await expectMismatch;

            // The new backup is detected, the loop should resume but the cached key is still the old one

            const loopResumed = expectLoopStatus(false);
            const cacheMismatch = expectConfigurationError(KeyDownloadError.VERSION_MISMATCH);

            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue({ version: "2", ...TestData.SIGNED_BACKUP_DATA });
            // It's trusted
            delegate.getActiveBackupVersion.mockResolvedValue("2");

            mockEmitter.emit(CryptoEvent.KeyBackupStatus, true);

            await loopResumed;
            await cacheMismatch;

            // Now the new key is cached
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: "2",
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            delegate.requestRoomKeyFromBackup.mockResolvedValue(TestData.CURVE25519_KEY_BACKUP_DATA);

            const a1Imported = expectSessionImported("!roomA", "sessionA1");

            mockEmitter.emit(CryptoEvent.KeyBackupStatus, true);

            await a1Imported;
        });
    });

    describe("Error cases", () => {
        beforeEach(async () => {
            // there is a backup
            delegate.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // It's trusted
            delegate.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            delegate.getBackupDecryptionKey.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            delegate.createBackupDecryptor.mockReturnValue({
                decryptSessions: jest.fn().mockResolvedValue([TestData.MEGOLM_SESSION_DATA]),
            } as unknown as RustBackupDecryptor);

            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("Should wait on rate limit error", async () => {
            // simulate rate limit error
            delegate.requestRoomKeyFromBackup
                .mockImplementationOnce(async () => {
                    throw new MatrixError(
                        {
                            errcode: "M_LIMIT_EXCEEDED",
                            error: "Too many requests",
                            retry_after_ms: 5000,
                        },
                        429,
                    );
                })
                .mockImplementationOnce(async () => TestData.CURVE25519_KEY_BACKUP_DATA);

            const errorPromise = expectConfigurationError(KeyDownloadError.RATE_LIMITED);
            const keyImported = expectSessionImported("!roomA", "sessionA0");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await errorPromise;
            // The loop should resume after the retry_after_ms
            jest.advanceTimersByTime(5000 + 100);
            await jest.runAllTimersAsync();

            await keyImported;
        });

        it("After a network error the same key is retried", async () => {
            // simulate connectivity error
            delegate.requestRoomKeyFromBackup
                .mockImplementationOnce(async () => {
                    throw new ConnectionError("fetch failed", new Error("fetch failed"));
                })
                .mockImplementationOnce(async () => TestData.CURVE25519_KEY_BACKUP_DATA);

            const errorPromise = expectConfigurationError(KeyDownloadError.NETWORK_ERROR);
            const keyImported = expectSessionImported("!roomA", "sessionA0");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await errorPromise;
            // The loop should resume after the retry_after_ms
            jest.advanceTimersByTime(BACKOFF_TIME + 100);
            await jest.runAllTimersAsync();

            await keyImported;
        });

        it("On Unknown error on import skip the key and continue", async () => {
            delegate.importRoomKeys
                .mockImplementationOnce(async () => {
                    throw new Error("Didn't work");
                })
                .mockImplementationOnce(async () => {
                    return;
                });

            const errorPromise = expectConfigurationError(KeyDownloadError.UNKNOWN_ERROR);
            const keyImported = expectSessionImported("!roomA", "sessionA1");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");

            await errorPromise;

            await keyImported;
        });
    });
});
