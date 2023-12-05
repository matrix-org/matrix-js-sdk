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
import { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";
import fetchMock from "fetch-mock-jest";

import {
    KeyDownloaderEvent,
    KeyDownloadError,
    PerSessionKeyBackupDownloader,
} from "../../../src/rust-crypto/PerSessionKeyBackupDownloader";
import { logger } from "../../../src/logger";
import { defer } from "../../../src/utils";
import { RustBackupCryptoEventMap, RustBackupCryptoEvents, RustBackupManager } from "../../../src/rust-crypto/backup";
import * as TestData from "../../test-utils/test-data";
import {
    ConnectionError,
    CryptoEvent,
    HttpApiEvent,
    HttpApiEventHandlerMap,
    IHttpOpts,
    IMegolmSessionData,
    MatrixHttpApi,
    TypedEventEmitter,
} from "../../../src";
import * as testData from "../../test-utils/test-data";
import { BackupDecryptor } from "../../../src/common-crypto/CryptoBackend";
import { KeyBackupSession } from "../../../src/crypto-api/keybackup";

describe("PerSessionKeyBackupDownloader", () => {
    /** The downloader under test */
    let downloader: PerSessionKeyBackupDownloader;

    const mockCipherKey: Mocked<KeyBackupSession> = {} as unknown as Mocked<KeyBackupSession>;
    // let delegate: Mocked<OnDemandBackupDelegate>;

    const BACKOFF_TIME = 2000;

    const mockEmitter = new TypedEventEmitter() as TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap>;

    let mockHttp: MatrixHttpApi<IHttpOpts & { onlyData: true }>;
    let mockRustBackupManager: Mocked<RustBackupManager>;
    let mockOlmMachine: Mocked<OlmMachine>;
    let mockBackupDecryptor: Mocked<BackupDecryptor>;

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

    function mockClearSession(sessionId: string): Mocked<IMegolmSessionData> {
        return {
            session_id: sessionId,
        } as unknown as Mocked<IMegolmSessionData>;
    }

    beforeEach(async () => {
        mockHttp = new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
            baseUrl: "http://server/",
            prefix: "",
            onlyData: true,
        });

        mockBackupDecryptor = {
            decryptSessions: jest.fn(),
        } as unknown as Mocked<BackupDecryptor>;

        mockBackupDecryptor.decryptSessions.mockImplementation(async (ciphertexts) => {
            const sessionId = Object.keys(ciphertexts)[0];
            return [mockClearSession(sessionId)];
        });

        mockRustBackupManager = {
            getActiveBackupVersion: jest.fn(),
            getBackupDecryptionKey: jest.fn(),
            requestKeyBackupVersion: jest.fn(),
            importRoomKeys: jest.fn(),
            createBackupDecryptor: jest.fn().mockReturnValue(mockBackupDecryptor),
        } as unknown as Mocked<RustBackupManager>;

        mockOlmMachine = {
            getBackupKeys: jest.fn(),
        } as unknown as Mocked<OlmMachine>;

        downloader = new PerSessionKeyBackupDownloader(
            mockRustBackupManager,
            mockOlmMachine,
            mockHttp,
            mockEmitter,
            logger,
            BACKOFF_TIME,
        );

        jest.useFakeTimers();
    });

    afterEach(() => {
        downloader.stop();
        fetchMock.mockReset();
        jest.useRealTimers();
    });

    describe("Given valid backup available", () => {
        beforeEach(async () => {
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            mockRustBackupManager.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
        });

        it("Should download and import a missing key from backup", async () => {
            const awaitKeyImported = defer<void>();
            const roomId = "!roomId";
            const sessionId = "sessionId";
            const expectAPICall = new Promise<void>((resolve) => {
                fetchMock.get(`path:/_matrix/client/v3/room_keys/keys/${roomId}/${sessionId}`, (url, request) => {
                    resolve();
                    return TestData.CURVE25519_KEY_BACKUP_DATA;
                });
            });
            mockRustBackupManager.importRoomKeys.mockImplementation(async (keys) => {
                awaitKeyImported.resolve();
            });
            mockBackupDecryptor.decryptSessions.mockResolvedValue([TestData.MEGOLM_SESSION_DATA]);

            downloader.onDecryptionKeyMissingError(roomId, sessionId);

            await expectAPICall;
            await awaitKeyImported.promise;
            expect(mockRustBackupManager.createBackupDecryptor).toHaveBeenCalledTimes(1);
        });

        it("Should not hammer the backup if the key is requested repeatedly", async () => {
            const blockOnServerRequest = defer<void>();

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/!roomId/:session_id`, async (url, request) => {
                await blockOnServerRequest.promise;
                return [mockCipherKey];
            });

            const awaitKey2Imported = defer<void>();

            mockRustBackupManager.importRoomKeys.mockImplementation(async (keys) => {
                if (keys[0].session_id === "sessionId2") {
                    awaitKey2Imported.resolve();
                }
            });

            const spy = jest.spyOn(downloader, "queryKeyBackup");

            // Call 3 times for same key
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            // Call again for a different key
            downloader.onDecryptionKeyMissingError("!roomId", "sessionId2");

            // Allow the first server request to complete
            blockOnServerRequest.resolve();

            await awaitKey2Imported.promise;
            expect(spy).toHaveBeenCalledTimes(2);
        });

        it("should continue to next key if current not in backup", async () => {
            fetchMock.get(`path:/_matrix/client/v3/room_keys/keys/!roomA/sessionA0`, {
                status: 404,
                body: {
                    errcode: "M_NOT_FOUND",
                    error: "No backup found",
                },
            });
            fetchMock.get(`path:/_matrix/client/v3/room_keys/keys/!roomA/sessionA1`, mockCipherKey);

            const expectImported = expectSessionImported("!roomA", "sessionA1");
            const expectNotFound = expectConfigurationError(KeyDownloadError.MISSING_DECRYPTION_KEY);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");

            await expectNotFound;
            await expectImported;
        });

        it("Should not query repeatedly for a key not in backup", async () => {
            fetchMock.get(`path:/_matrix/client/v3/room_keys/keys/!roomA/sessionA0`, {
                status: 404,
                body: {
                    errcode: "M_NOT_FOUND",
                    error: "No backup found",
                },
            });

            const spy = jest.spyOn(downloader, "queryKeyBackup");

            const expectNotFound = expectConfigurationError(KeyDownloadError.MISSING_DECRYPTION_KEY);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await expectNotFound;

            // Should not query again for a key not in backup
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            expect(spy).toHaveBeenCalledTimes(1);

            // advance time to retry
            jest.advanceTimersByTime(BACKOFF_TIME + 10);

            const expectNotFoundSecondAttempt = expectConfigurationError(KeyDownloadError.MISSING_DECRYPTION_KEY);
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            expect(spy).toHaveBeenCalledTimes(2);

            await expectNotFoundSecondAttempt;
        });

        it("Should stop properly", async () => {
            // Simulate a call to stop while request is in flight
            const blockOnServerRequest = defer<void>();
            const requestRoomKeyCalled = defer<void>();

            let callCount = 0;
            // Mock the request to block
            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, async (url, request) => {
                requestRoomKeyCalled.resolve();
                await blockOnServerRequest.promise;
                callCount++;
                return mockCipherKey;
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
            expect(mockRustBackupManager.importRoomKeys).not.toHaveBeenCalled();
            expect(callCount).toStrictEqual(1);
        });
    });

    describe("Given no usable backup available", () => {
        let loopPausedPromise: Promise<void>;
        let configurationErrorPromise: Promise<void>;

        beforeEach(async () => {
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(null);
            mockOlmMachine.getBackupKeys.mockResolvedValue(null);

            loopPausedPromise = expectLoopStatus(false);

            configurationErrorPromise = expectConfigurationError(KeyDownloadError.CONFIGURATION_ERROR);
        });

        afterEach(async () => {
            fetchMock.mockClear();
        });

        it("Should not query server if no backup", async () => {
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                status: 404,
                body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
            });

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should not query server if backup not active", async () => {
            // there is a backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            // but it's not trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should stop if backup key is not cached", async () => {
            // there is a backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
            // it is trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // but the key is not cached
            mockOlmMachine.getBackupKeys.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should stop if backup key cached as wrong version", async () => {
            // there is a backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
            // it is trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // but the cached key has the wrong version
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: "0",
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await loopPausedPromise;
            await configurationErrorPromise;
        });

        it("Should stop if backup key version does not match the active one", async () => {
            // there is a backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
            // The sdk is out of sync, the trusted version is the old one
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue("0");
            // key for old backup cached
            mockOlmMachine.getBackupKeys.mockResolvedValue({
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
            mockRustBackupManager.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);

            // but at this point it's not trusted and we don't have the key
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(null);
            mockOlmMachine.getBackupKeys.mockResolvedValue(null);

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey);

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
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

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
            mockRustBackupManager.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // It's trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });

            const a0Imported = expectSessionImported("!roomA", "sessionA0");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await a0Imported;

            // Now some other session resets the backup and there is a new version
            // the room_keys/keys endpoint will throw
            fetchMock.get(
                `express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`,
                {
                    status: 404,
                    body: {
                        errcode: "M_NOT_FOUND",
                        error: "Unknown backup version",
                    },
                },
                { overwriteRoutes: true },
            );

            const loopPausedPromise = expectLoopStatus(false);
            const expectMismatch = expectConfigurationError(KeyDownloadError.VERSION_MISMATCH);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");

            await loopPausedPromise;
            await expectMismatch;

            // The new backup is detected, the loop should resume but the cached key is still the old one
            const configurationError = expectConfigurationError(KeyDownloadError.CONFIGURATION_ERROR);

            // there is a backup
            mockRustBackupManager.requestKeyBackupVersion.mockResolvedValue({
                ...TestData.SIGNED_BACKUP_DATA,
                version: "2",
            });
            // It's trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue("2");

            mockEmitter.emit(CryptoEvent.KeyBackupStatus, true);

            // await loopResumed;
            await configurationError;

            // Now the new key is cached
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: "2",
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });

            const a1Imported = expectSessionImported("!roomA", "sessionA1");

            mockEmitter.emit(CryptoEvent.KeyBackupStatus, true);

            await a1Imported;
        });
    });

    describe("Error cases", () => {
        beforeEach(async () => {
            // there is a backup
            mockRustBackupManager.requestKeyBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // It's trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("Should wait on rate limit error", async () => {
            // simulate rate limit error
            fetchMock.get(
                `express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`,
                {
                    status: 429,
                    body: {
                        errcode: "M_LIMIT_EXCEEDED",
                        error: "Too many requests",
                        retry_after_ms: 5000,
                    },
                },
                { overwriteRoutes: true },
            );

            const errorPromise = expectConfigurationError(KeyDownloadError.RATE_LIMITED);
            const keyImported = expectSessionImported("!roomA", "sessionA0");

            const spy = jest.spyOn(downloader, "queryKeyBackup");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await errorPromise;

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });

            // The loop should resume after the retry_after_ms
            jest.advanceTimersByTime(5000 + 100);
            await jest.runAllTimersAsync();

            expect(spy).toHaveBeenCalledTimes(2);
            await keyImported;
        });

        it("After a network error the same key is retried", async () => {
            // simulate connectivity error
            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, () => {
                throw new ConnectionError("fetch failed", new Error("fetch failed"));
            });

            const errorPromise = expectConfigurationError(KeyDownloadError.NETWORK_ERROR);
            const keyImported = expectSessionImported("!roomA", "sessionA0");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await errorPromise;

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });
            // The loop should resume after the retry_after_ms
            jest.advanceTimersByTime(BACKOFF_TIME + 100);
            await jest.runAllTimersAsync();

            await keyImported;
        });

        it("On Unknown error on import skip the key and continue", async () => {
            mockRustBackupManager.importRoomKeys
                .mockImplementationOnce(async () => {
                    throw new Error("Didn't work");
                })
                .mockImplementationOnce(async () => {
                    return;
                });

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
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
