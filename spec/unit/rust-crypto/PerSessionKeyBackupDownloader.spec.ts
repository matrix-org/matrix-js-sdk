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

import { Mocked, SpyInstance } from "jest-mock";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";
import fetchMock from "fetch-mock-jest";

import { PerSessionKeyBackupDownloader } from "../../../src/rust-crypto/PerSessionKeyBackupDownloader";
import { logger } from "../../../src/logger";
import { defer, IDeferred } from "../../../src/utils";
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

    // matches the const in PerSessionKeyBackupDownloader
    const BACKOFF_TIME = 5000;

    let mockEmitter: TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap>;
    let mockHttp: MatrixHttpApi<IHttpOpts & { onlyData: true }>;
    let mockRustBackupManager: Mocked<RustBackupManager>;
    let mockOlmMachine: Mocked<OlmMachine>;
    let mockBackupDecryptor: Mocked<BackupDecryptor>;

    let expectedSession: { [roomId: string]: { [sessionId: string]: IDeferred<void> } };

    function expectSessionImported(roomId: string, sessionId: string) {
        const deferred = defer<void>();
        if (!expectedSession[roomId]) {
            expectedSession[roomId] = {};
        }
        expectedSession[roomId][sessionId] = deferred;
        return deferred.promise;
    }

    function mockClearSession(sessionId: string): Mocked<IMegolmSessionData> {
        return {
            session_id: sessionId,
        } as unknown as Mocked<IMegolmSessionData>;
    }

    beforeEach(async () => {
        mockEmitter = new TypedEventEmitter() as TypedEventEmitter<RustBackupCryptoEvents, RustBackupCryptoEventMap>;

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
            getServerBackupInfo: jest.fn(),
            importBackedUpRoomKeys: jest.fn(),
            createBackupDecryptor: jest.fn().mockReturnValue(mockBackupDecryptor),
            on: jest.fn().mockImplementation((event, listener) => {
                mockEmitter.on(event, listener);
            }),
            off: jest.fn().mockImplementation((event, listener) => {
                mockEmitter.off(event, listener);
            }),
        } as unknown as Mocked<RustBackupManager>;

        mockOlmMachine = {
            getBackupKeys: jest.fn(),
        } as unknown as Mocked<OlmMachine>;

        downloader = new PerSessionKeyBackupDownloader(logger, mockOlmMachine, mockHttp, mockRustBackupManager);

        expectedSession = {};
        mockRustBackupManager.importBackedUpRoomKeys.mockImplementation(async (keys) => {
            const roomId = keys[0].room_id;
            const sessionId = keys[0].session_id;
            const deferred = expectedSession[roomId] && expectedSession[roomId][sessionId];
            if (deferred) {
                deferred.resolve();
            }
        });

        jest.useFakeTimers();
    });

    afterEach(() => {
        expectedSession = {};
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

            mockRustBackupManager.getServerBackupInfo.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
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
            mockRustBackupManager.importBackedUpRoomKeys.mockImplementation(async (keys) => {
                awaitKeyImported.resolve();
            });
            mockBackupDecryptor.decryptSessions.mockResolvedValue([TestData.MEGOLM_SESSION_DATA]);

            downloader.onDecryptionKeyMissingError(roomId, sessionId);

            // `isKeyBackupDownloadConfigured` is false until the config is proven.
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);
            await expectAPICall;
            await awaitKeyImported.promise;
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(true);
            expect(mockRustBackupManager.createBackupDecryptor).toHaveBeenCalledTimes(1);
        });

        it("Should not hammer the backup if the key is requested repeatedly", async () => {
            const blockOnServerRequest = defer<void>();

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/!roomId/:session_id`, async (url, request) => {
                await blockOnServerRequest.promise;
                return [mockCipherKey];
            });

            const awaitKey2Imported = defer<void>();

            mockRustBackupManager.importBackedUpRoomKeys.mockImplementation(async (keys) => {
                if (keys[0].session_id === "sessionId2") {
                    awaitKey2Imported.resolve();
                }
            });

            // @ts-ignore access to private function
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

            // @ts-ignore access to private function
            const spy: SpyInstance = jest.spyOn(downloader, "queryKeyBackup");

            const expectImported = expectSessionImported("!roomA", "sessionA1");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            await jest.runAllTimersAsync();
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveLastReturnedWith(Promise.resolve({ ok: false, error: "MISSING_DECRYPTION_KEY" }));

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");
            await jest.runAllTimersAsync();
            expect(spy).toHaveBeenCalledTimes(2);

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

            // @ts-ignore access to private function
            const spy: SpyInstance = jest.spyOn(downloader, "queryKeyBackup");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            await jest.runAllTimersAsync();

            expect(spy).toHaveBeenCalledTimes(1);
            const returnedPromise = spy.mock.results[0].value;
            await expect(returnedPromise).rejects.toThrow("Failed to get key from backup: MISSING_DECRYPTION_KEY");

            // Should not query again for a key not in backup
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            await jest.runAllTimersAsync();

            expect(spy).toHaveBeenCalledTimes(1);

            // advance time to retry
            jest.advanceTimersByTime(BACKOFF_TIME + 10);

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            await jest.runAllTimersAsync();

            expect(spy).toHaveBeenCalledTimes(2);
            await expect(spy.mock.results[1].value).rejects.toThrow(
                "Failed to get key from backup: MISSING_DECRYPTION_KEY",
            );
        });

        it("Should stop properly", async () => {
            // Simulate a call to stop while request is in flight
            const blockOnServerRequest = defer<void>();
            const requestRoomKeyCalled = defer<void>();

            // Mock the request to block
            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, async (url, request) => {
                requestRoomKeyCalled.resolve();
                await blockOnServerRequest.promise;
                return mockCipherKey;
            });

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA2");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA3");

            await requestRoomKeyCalled.promise;
            downloader.stop();

            blockOnServerRequest.resolve();

            // let the first request complete
            await jest.runAllTimersAsync();

            expect(mockRustBackupManager.importBackedUpRoomKeys).not.toHaveBeenCalled();
            expect(
                fetchMock.calls(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`).length,
            ).toStrictEqual(1);
        });
    });

    describe("Given no usable backup available", () => {
        let getConfigSpy: SpyInstance;

        beforeEach(async () => {
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(null);
            mockOlmMachine.getBackupKeys.mockResolvedValue(null);

            // @ts-ignore access to private function
            getConfigSpy = jest.spyOn(downloader, "getOrCreateBackupConfiguration");
        });

        it("Should not query server if no backup", async () => {
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                status: 404,
                body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
            });

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await jest.runAllTimersAsync();

            expect(getConfigSpy).toHaveBeenCalledTimes(1);
            expect(getConfigSpy).toHaveReturnedWith(Promise.resolve(null));

            // isKeyBackupDownloadConfigured remains false
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);
        });

        it("Should not query server if backup not active", async () => {
            // there is a backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            // but it's not trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await jest.runAllTimersAsync();

            expect(getConfigSpy).toHaveBeenCalledTimes(1);
            expect(getConfigSpy).toHaveReturnedWith(Promise.resolve(null));

            // isKeyBackupDownloadConfigured remains false
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);
        });

        it("Should stop if backup key is not cached", async () => {
            // there is a backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
            // it is trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // but the key is not cached
            mockOlmMachine.getBackupKeys.mockResolvedValue(null);

            downloader.onDecryptionKeyMissingError("!roomId", "sessionId");

            await jest.runAllTimersAsync();

            expect(getConfigSpy).toHaveBeenCalledTimes(1);
            expect(getConfigSpy).toHaveReturnedWith(Promise.resolve(null));

            // isKeyBackupDownloadConfigured remains false
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);
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

            await jest.runAllTimersAsync();

            expect(getConfigSpy).toHaveBeenCalledTimes(1);
            expect(getConfigSpy).toHaveReturnedWith(Promise.resolve(null));

            // isKeyBackupDownloadConfigured remains false
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);
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

            await jest.runAllTimersAsync();

            expect(getConfigSpy).toHaveBeenCalledTimes(1);
            expect(getConfigSpy).toHaveReturnedWith(Promise.resolve(null));

            // isKeyBackupDownloadConfigured remains false
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);
        });
    });

    describe("Given Backup state update", () => {
        it("After initial sync, when backup becomes trusted it should request keys for past requests", async () => {
            // there is a backup
            mockRustBackupManager.getServerBackupInfo.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);

            // but at this point it's not trusted and we don't have the key
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(null);
            mockOlmMachine.getBackupKeys.mockResolvedValue(null);

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey);

            const a0Imported = expectSessionImported("!roomA", "sessionA0");
            const a1Imported = expectSessionImported("!roomA", "sessionA1");
            const b1Imported = expectSessionImported("!roomB", "sessionB1");
            const c1Imported = expectSessionImported("!roomC", "sessionC1");

            // During initial sync several keys are requested
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");
            downloader.onDecryptionKeyMissingError("!roomB", "sessionB1");
            downloader.onDecryptionKeyMissingError("!roomC", "sessionC1");
            await jest.runAllTimersAsync();

            // @ts-ignore access to private property
            expect(downloader.hasConfigurationProblem).toEqual(true);
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(false);

            // Now the backup becomes trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);

            // In that case the sdk would fire a backup status update
            mockEmitter.emit(CryptoEvent.KeyBackupStatus, true);

            await jest.runAllTimersAsync();
            expect(downloader.isKeyBackupDownloadConfigured()).toBe(true);

            await a0Imported;
            await a1Imported;
            await b1Imported;
            await c1Imported;
        });
    });

    describe("Error cases", () => {
        beforeEach(async () => {
            // there is a backup
            mockRustBackupManager.getServerBackupInfo.mockResolvedValue(TestData.SIGNED_BACKUP_DATA);
            // It's trusted
            mockRustBackupManager.getActiveBackupVersion.mockResolvedValue(TestData.SIGNED_BACKUP_DATA.version!);
            // And we have the key in cache
            mockOlmMachine.getBackupKeys.mockResolvedValue({
                backupVersion: TestData.SIGNED_BACKUP_DATA.version!,
                decryptionKey: RustSdkCryptoJs.BackupDecryptionKey.fromBase64(TestData.BACKUP_DECRYPTION_KEY_BASE64),
            } as unknown as RustSdkCryptoJs.BackupKeys);
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

            const keyImported = expectSessionImported("!roomA", "sessionA0");

            // @ts-ignore
            const originalImplementation = downloader.queryKeyBackup.bind(downloader);

            // @ts-ignore access to private function
            const keyQuerySpy: SpyInstance = jest.spyOn(downloader, "queryKeyBackup");
            const rateDeferred = defer<void>();

            keyQuerySpy.mockImplementation(
                // @ts-ignore
                async (targetRoomId: string, targetSessionId: string, configuration: any) => {
                    try {
                        return await originalImplementation(targetRoomId, targetSessionId, configuration);
                    } catch (err: any) {
                        if (err.name === "KeyDownloadRateLimitError") {
                            rateDeferred.resolve();
                        }
                        throw err;
                    }
                },
            );
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");

            await rateDeferred.promise;
            expect(keyQuerySpy).toHaveBeenCalledTimes(1);
            await expect(keyQuerySpy.mock.results[0].value).rejects.toThrow(
                "Failed to get key from backup: rate limited",
            );

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });

            // Advance less than the retry_after_ms
            jest.advanceTimersByTime(100);
            // let any pending callbacks in PromiseJobs run
            await Promise.resolve();
            // no additional call should have been made
            expect(keyQuerySpy).toHaveBeenCalledTimes(1);

            // The loop should resume after the retry_after_ms
            jest.advanceTimersByTime(5000);
            // let any pending callbacks in PromiseJobs run
            await Promise.resolve();

            await keyImported;
            expect(keyQuerySpy).toHaveBeenCalledTimes(2);
        });

        it("After a network error the same key is retried", async () => {
            // simulate connectivity error
            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, () => {
                throw new ConnectionError("fetch failed", new Error("fetch failed"));
            });

            // @ts-ignore
            const originalImplementation = downloader.queryKeyBackup.bind(downloader);

            // @ts-ignore
            const keyQuerySpy: SpyInstance = jest.spyOn(downloader, "queryKeyBackup");
            const errorDeferred = defer<void>();

            keyQuerySpy.mockImplementation(
                // @ts-ignore
                async (targetRoomId: string, targetSessionId: string, configuration: any) => {
                    try {
                        return await originalImplementation(targetRoomId, targetSessionId, configuration);
                    } catch (err: any) {
                        if (err.name === "KeyDownloadError") {
                            errorDeferred.resolve();
                        }
                        throw err;
                    }
                },
            );
            const keyImported = expectSessionImported("!roomA", "sessionA0");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            await errorDeferred.promise;
            await Promise.resolve();

            await expect(keyQuerySpy.mock.results[0].value).rejects.toThrow(
                "Failed to get key from backup: NETWORK_ERROR",
            );

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });

            // Advance less than the retry_after_ms
            jest.advanceTimersByTime(100);
            // let any pending callbacks in PromiseJobs run
            await Promise.resolve();
            // no additional call should have been made
            expect(keyQuerySpy).toHaveBeenCalledTimes(1);

            // The loop should resume after the retry_after_ms
            jest.advanceTimersByTime(BACKOFF_TIME + 100);
            await Promise.resolve();

            await keyImported;
        });

        it("On Unknown error on import skip the key and continue", async () => {
            const keyImported = defer<void>();
            mockRustBackupManager.importBackedUpRoomKeys
                .mockImplementationOnce(async () => {
                    throw new Error("Didn't work");
                })
                .mockImplementationOnce(async (sessions) => {
                    const roomId = sessions[0].room_id;
                    const sessionId = sessions[0].session_id;
                    if (roomId === "!roomA" && sessionId === "sessionA1") {
                        keyImported.resolve();
                    }
                    return;
                });

            fetchMock.get(`express:/_matrix/client/v3/room_keys/keys/:roomId/:sessionId`, mockCipherKey, {
                overwriteRoutes: true,
            });

            // @ts-ignore access to private function
            const keyQuerySpy: SpyInstance = jest.spyOn(downloader, "queryKeyBackup");

            downloader.onDecryptionKeyMissingError("!roomA", "sessionA0");
            downloader.onDecryptionKeyMissingError("!roomA", "sessionA1");
            await jest.runAllTimersAsync();

            await keyImported.promise;

            expect(keyQuerySpy).toHaveBeenCalledTimes(2);
            expect(mockRustBackupManager.importBackedUpRoomKeys).toHaveBeenCalledTimes(2);
        });
    });
});
