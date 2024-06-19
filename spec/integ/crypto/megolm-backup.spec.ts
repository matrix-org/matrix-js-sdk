/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import fetchMock from "fetch-mock-jest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { Mocked } from "jest-mock";

import {
    createClient,
    Crypto,
    CryptoEvent,
    ICreateClientOpts,
    IEvent,
    IMegolmSessionData,
    MatrixClient,
    TypedEventEmitter,
} from "../../../src";
import { SyncResponder } from "../../test-utils/SyncResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import {
    advanceTimersUntil,
    awaitDecryption,
    CRYPTO_BACKENDS,
    InitCrypto,
    syncPromise,
} from "../../test-utils/test-utils";
import * as testData from "../../test-utils/test-data";
import { KeyBackupInfo, KeyBackupSession } from "../../../src/crypto-api/keybackup";
import { IKeyBackup } from "../../../src/crypto/backup";
import { flushPromises } from "../../test-utils/flushPromises";
import { defer, IDeferred } from "../../../src/utils";
import { DecryptionFailureCode } from "../../../src/crypto-api";

const ROOM_ID = testData.TEST_ROOM_ID;

/** The homeserver url that we give to the test client, and where we intercept /sync, /keys, etc requests. */
const TEST_HOMESERVER_URL = "https://alice-server.com";

const TEST_USER_ID = "@alice:localhost";
const TEST_DEVICE_ID = "xzcvb";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

enum MockKeyUploadEvent {
    KeyUploaded = "KeyUploaded",
}

type MockKeyUploadEventHandlerMap = {
    [MockKeyUploadEvent.KeyUploaded]: (roomId: string, sessionId: string, backupVersion: string) => void;
};

/*
 * Test helper. Returns an event emitter that will emit an event every time fetchmock sees a request to backup a key.
 */
function mockUploadEmitter(
    expectedVersion: string,
): TypedEventEmitter<MockKeyUploadEvent, MockKeyUploadEventHandlerMap> {
    const emitter = new TypedEventEmitter();
    fetchMock.put(
        "path:/_matrix/client/v3/room_keys/keys",
        (url, request) => {
            const version = new URLSearchParams(new URL(url).search).get("version");
            if (version != expectedVersion) {
                return {
                    status: 403,
                    body: {
                        current_version: expectedVersion,
                        errcode: "M_WRONG_ROOM_KEYS_VERSION",
                        error: "Wrong backup version.",
                    },
                };
            }
            const uploadPayload: IKeyBackup = JSON.parse(request.body?.toString() ?? "{}");
            let count = 0;
            for (const [roomId, value] of Object.entries(uploadPayload.rooms)) {
                for (const sessionId of Object.keys(value.sessions)) {
                    emitter.emit(MockKeyUploadEvent.KeyUploaded, roomId, sessionId, version);
                    count++;
                }
            }
            return {
                status: 200,
                body: {
                    count: count,
                    etag: "abcdefg",
                },
            };
        },
        {
            overwriteRoutes: true,
        },
    );
    return emitter;
}

describe.each(Object.entries(CRYPTO_BACKENDS))("megolm-keys backup (%s)", (backend: string, initCrypto: InitCrypto) => {
    // oldBackendOnly is an alternative to `it` or `test` which will skip the test if we are running against the
    // Rust backend. Once we have full support in the rust sdk, it will go away.
    // const oldBackendOnly = backend === "rust-sdk" ? test.skip : test;
    // const newBackendOnly = backend === "libolm" ? test.skip : test;

    let aliceClient: MatrixClient;
    /** an object which intercepts `/sync` requests on the test homeserver */
    let syncResponder: SyncResponder;

    /** an object which intercepts `/keys/upload` requests on the test homeserver */
    let e2eKeyReceiver: E2EKeyReceiver;
    /** an object which intercepts `/keys/query` requests on the test homeserver */
    let e2eKeyResponder: E2EKeyResponder;

    beforeEach(async () => {
        // We want to use fake timers, but the wasm bindings of matrix-sdk-crypto rely on a working `queueMicrotask`.
        jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

        // anything that we don't have a specific matcher for silently returns a 404
        fetchMock.catch(404);
        fetchMock.config.warnOnFallback = false;

        mockInitialApiRequests(TEST_HOMESERVER_URL);
        syncResponder = new SyncResponder(TEST_HOMESERVER_URL);
        e2eKeyReceiver = new E2EKeyReceiver(TEST_HOMESERVER_URL);
        e2eKeyResponder = new E2EKeyResponder(TEST_HOMESERVER_URL);
        e2eKeyResponder.addDeviceKeys(testData.SIGNED_TEST_DEVICE_DATA);
        e2eKeyResponder.addKeyReceiver(TEST_USER_ID, e2eKeyReceiver);
    });

    afterEach(async () => {
        if (aliceClient !== undefined) {
            await aliceClient.stopClient();
        }

        // Allow in-flight things to complete before we tear down the test
        await jest.runAllTimersAsync();

        fetchMock.mockReset();
        jest.restoreAllMocks();
    });

    async function initTestClient(opts: Partial<ICreateClientOpts> = {}): Promise<MatrixClient> {
        const client = createClient({
            baseUrl: TEST_HOMESERVER_URL,
            userId: TEST_USER_ID,
            accessToken: "akjgkrgjs",
            deviceId: TEST_DEVICE_ID,
            ...opts,
        });
        await initCrypto(client);

        return client;
    }

    describe("Key backup check on UTD message", () => {
        // sync response which contains an encrypted event
        const SYNC_RESPONSE = {
            next_batch: 1,
            rooms: { join: { [ROOM_ID]: { timeline: { events: [testData.ENCRYPTED_EVENT] } } } },
        };

        const EXPECTED_URL =
            [
                "https://alice-server.com/_matrix/client/v3/room_keys/keys",
                encodeURIComponent(testData.TEST_ROOM_ID),
                encodeURIComponent(testData.MEGOLM_SESSION_DATA.session_id),
            ].join("/") + "?version=1";

        /** Flush promises enough times to get the crypto stacks to make the backup request */
        async function flushBackupRequest() {
            // we have to run flushPromises lots of times. It seems like each time the rust code touches indexeddb,
            // it needs another round of flushPromises to progress, or something.
            for (let i = 0; i < 10; i++) {
                await flushPromises();
            }
        }

        beforeEach(
            async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

                // ignore requests to send room key requests
                fetchMock.put("express:/_matrix/client/v3/sendToDevice/m.room_key_request/:request_id", {});

                aliceClient = await initTestClient();
                const aliceCrypto = aliceClient.getCrypto()!;
                await aliceCrypto.storeSessionBackupPrivateKey(
                    Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                    testData.SIGNED_BACKUP_DATA.version!,
                );

                // start after saving the private key
                await aliceClient.startClient();

                // tell Alice to trust the dummy device that signed the backup, and re-check the backup.
                // XXX: should we automatically re-check after a device becomes verified?
                await waitForDeviceList();
                await aliceClient.getCrypto()!.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);
                await aliceClient.getCrypto()!.checkKeyBackupAndEnable();
            } /* it can take a while to initialise the crypto library on the first pass, so bump up the timeout. */,
            10000,
        );

        it("Alice checks key backups when receiving a message she can't decrypt", async () => {
            fetchMock.get("express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id", (url, request) => {
                // check that the version is correct
                const version = new URLSearchParams(new URL(url).search).get("version");
                if (version == "1") {
                    return testData.CURVE25519_KEY_BACKUP_DATA;
                } else {
                    return {
                        status: 403,
                        body: {
                            current_version: "1",
                            errcode: "M_WRONG_ROOM_KEYS_VERSION",
                            error: "Wrong backup version.",
                        },
                    };
                }
            });

            // Send Alice a message that she won't be able to decrypt, and check that she fetches the key from the backup.
            syncResponder.sendOrQueueSyncResponse(SYNC_RESPONSE);
            await syncPromise(aliceClient);

            const room = aliceClient.getRoom(ROOM_ID)!;
            const event = room.getLiveTimeline().getEvents()[0];

            // On the first decryption attempt, decryption fails.
            await awaitDecryption(event);
            expect(event.decryptionFailureReason).toEqual(
                backend === "libolm"
                    ? DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID
                    : DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP,
            );

            // Eventually, decryption succeeds.
            await awaitDecryption(event, { waitOnDecryptionFailure: true });
            expect(event.getContent()).toEqual(testData.CLEAR_EVENT.content);
        });

        it("handles error on backup query gracefully", async () => {
            jest.spyOn(console, "error").mockImplementation(() => {});

            fetchMock.get(
                "express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id",
                { status: 404, body: { errcode: "M_NOT_FOUND" } },
                { name: "getKey" },
            );

            // Send Alice a message that she won't be able to decrypt
            syncResponder.sendOrQueueSyncResponse(SYNC_RESPONSE);
            await flushBackupRequest();

            const calls = fetchMock.calls("getKey");
            expect(calls.length).toEqual(1);
            expect(calls[0][0]).toEqual(EXPECTED_URL);

            await flushBackupRequest();

            // we should not have logged an error.
            // eslint-disable-next-line no-console
            expect(console.error).not.toHaveBeenCalled();
        });

        it("Only queries once", async () => {
            fetchMock.get(
                "express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id",
                { status: 404, body: { errcode: "M_NOT_FOUND" } },
                { name: "getKey" },
            );

            // Send Alice a message that she won't be able to decrypt
            syncResponder.sendOrQueueSyncResponse(SYNC_RESPONSE);
            await flushBackupRequest();
            const calls = fetchMock.calls("getKey");
            expect(calls.length).toEqual(1);
            expect(calls[0][0]).toEqual(EXPECTED_URL);

            fetchMock.resetHistory();

            // another message
            const event2 = { ...testData.ENCRYPTED_EVENT, event_id: "$event2" };
            const syncResponse2 = {
                next_batch: 1,
                rooms: { join: { [ROOM_ID]: { timeline: { events: [event2] } } } },
            };
            syncResponder.sendOrQueueSyncResponse(syncResponse2);
            await flushBackupRequest();
            expect(fetchMock.calls("getKey").length).toEqual(0);
        });
    });

    describe("recover from backup", () => {
        let aliceCrypto: Crypto.CryptoApi;

        beforeEach(async () => {
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            aliceClient = await initTestClient();
            aliceCrypto = aliceClient.getCrypto()!;
            await aliceClient.startClient();

            // tell Alice to trust the dummy device that signed the backup
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);
        });

        it("can restore from backup (Curve25519 version)", async function () {
            const fullBackup = {
                rooms: {
                    [ROOM_ID]: {
                        sessions: {
                            [testData.MEGOLM_SESSION_DATA.session_id]: testData.CURVE25519_KEY_BACKUP_DATA,
                        },
                    },
                },
            };

            fetchMock.get("express:/_matrix/client/v3/room_keys/keys", fullBackup);

            const check = await aliceCrypto.checkKeyBackupAndEnable();

            let onKeyCached: () => void;
            const awaitKeyCached = new Promise<void>((resolve) => {
                onKeyCached = resolve;
            });

            const result = await advanceTimersUntil(
                aliceClient.restoreKeyBackupWithRecoveryKey(
                    testData.BACKUP_DECRYPTION_KEY_BASE58,
                    undefined,
                    undefined,
                    check!.backupInfo!,
                    {
                        cacheCompleteCallback: () => onKeyCached(),
                    },
                ),
            );

            expect(result.imported).toStrictEqual(1);

            await awaitKeyCached;

            // The key should be now cached
            const afterCache = await advanceTimersUntil(
                aliceClient.restoreKeyBackupWithCache(undefined, undefined, check!.backupInfo!),
            );

            expect(afterCache.imported).toStrictEqual(1);
        });

        /**
         * Creates a mock backup response of a GET `room_keys/keys` with a given number of keys per room.
         * @param keysPerRoom The number of keys per room
         */
        function createBackupDownloadResponse(keysPerRoom: number[]) {
            const response: {
                rooms: {
                    [roomId: string]: {
                        sessions: {
                            [sessionId: string]: KeyBackupSession;
                        };
                    };
                };
            } = { rooms: {} };

            const expectedTotal = keysPerRoom.reduce((a, b) => a + b, 0);
            for (let i = 0; i < keysPerRoom.length; i++) {
                const roomId = `!room${i}:example.com`;
                response.rooms[roomId] = { sessions: {} };
                for (let j = 0; j < keysPerRoom[i]; j++) {
                    const sessionId = `session${j}`;
                    // Put the same fake session data, not important for that test
                    response.rooms[roomId].sessions[sessionId] = testData.CURVE25519_KEY_BACKUP_DATA;
                }
            }
            return { response, expectedTotal };
        }

        it("Should import full backup in chunks", async function () {
            const importMockImpl = jest.fn();
            // @ts-ignore - mock a private method for testing purpose
            aliceCrypto.importBackedUpRoomKeys = importMockImpl;

            // We need several rooms with several sessions to test chunking
            const { response, expectedTotal } = createBackupDownloadResponse([45, 300, 345, 12, 130]);

            fetchMock.get("express:/_matrix/client/v3/room_keys/keys", response);

            const check = await aliceCrypto.checkKeyBackupAndEnable();

            const progressCallback = jest.fn();
            const result = await aliceClient.restoreKeyBackupWithRecoveryKey(
                testData.BACKUP_DECRYPTION_KEY_BASE58,
                undefined,
                undefined,
                check!.backupInfo!,
                {
                    progressCallback,
                },
            );

            expect(result.imported).toStrictEqual(expectedTotal);
            // Should be called 5 times: 200*4 plus one chunk with the remaining 32
            expect(importMockImpl).toHaveBeenCalledTimes(5);
            for (let i = 0; i < 4; i++) {
                expect(importMockImpl.mock.calls[i][0].length).toEqual(200);
            }
            expect(importMockImpl.mock.calls[4][0].length).toEqual(32);

            expect(progressCallback).toHaveBeenCalledWith({
                stage: "fetch",
            });

            // Should be called 4 times and report 200/400/600/800
            for (let i = 0; i < 4; i++) {
                expect(progressCallback).toHaveBeenCalledWith({
                    total: expectedTotal,
                    successes: (i + 1) * 200,
                    stage: "load_keys",
                    failures: 0,
                });
            }

            // The last chunk
            expect(progressCallback).toHaveBeenCalledWith({
                total: expectedTotal,
                successes: 832,
                stage: "load_keys",
                failures: 0,
            });
        });

        it("Should continue to process backup if a chunk import fails and report failures", async function () {
            // @ts-ignore - mock a private method for testing purpose
            aliceCrypto.importBackedUpRoomKeys = jest
                .fn()
                .mockImplementationOnce(() => {
                    // Fail to import first chunk
                    throw new Error("test error");
                })
                // Ok for other chunks
                .mockResolvedValue(undefined);

            const { response, expectedTotal } = createBackupDownloadResponse([100, 300]);

            fetchMock.get("express:/_matrix/client/v3/room_keys/keys", response);

            const check = await aliceCrypto.checkKeyBackupAndEnable();

            const progressCallback = jest.fn();
            const result = await aliceClient.restoreKeyBackupWithRecoveryKey(
                testData.BACKUP_DECRYPTION_KEY_BASE58,
                undefined,
                undefined,
                check!.backupInfo!,
                {
                    progressCallback,
                },
            );

            expect(result.total).toStrictEqual(expectedTotal);
            // A chunk failed to import
            expect(result.imported).toStrictEqual(200);

            expect(progressCallback).toHaveBeenCalledWith({
                total: expectedTotal,
                successes: 0,
                stage: "load_keys",
                failures: 200,
            });

            expect(progressCallback).toHaveBeenCalledWith({
                total: expectedTotal,
                successes: 200,
                stage: "load_keys",
                failures: 200,
            });
        });

        it("Should continue if some keys fails to decrypt", async function () {
            // @ts-ignore - mock a private method for testing purpose
            aliceCrypto.importBackedUpRoomKeys = jest.fn();

            const decryptionFailureCount = 2;

            const mockDecryptor = {
                // DecryptSessions does not reject on decryption failure, but just skip the key
                decryptSessions: jest.fn().mockImplementation((sessions) => {
                    // simulate fail to decrypt 2 keys out of all
                    const decrypted = [];
                    const keys = Object.keys(sessions);
                    for (let i = 0; i < keys.length - decryptionFailureCount; i++) {
                        decrypted.push({
                            session_id: keys[i],
                        } as unknown as Mocked<IMegolmSessionData>);
                    }
                    return decrypted;
                }),
                free: jest.fn(),
            };

            // @ts-ignore - mock a private method for testing purpose
            aliceCrypto.getBackupDecryptor = jest.fn().mockResolvedValue(mockDecryptor);

            const { response, expectedTotal } = createBackupDownloadResponse([100]);

            fetchMock.get("express:/_matrix/client/v3/room_keys/keys", response);

            const check = await aliceCrypto.checkKeyBackupAndEnable();

            const result = await aliceClient.restoreKeyBackupWithRecoveryKey(
                testData.BACKUP_DECRYPTION_KEY_BASE58,
                undefined,
                undefined,
                check!.backupInfo!,
            );

            expect(result.total).toStrictEqual(expectedTotal);
            // A chunk failed to import
            expect(result.imported).toStrictEqual(expectedTotal - decryptionFailureCount);
        });

        it("recover specific session from backup", async function () {
            fetchMock.get(
                "express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id",
                testData.CURVE25519_KEY_BACKUP_DATA,
            );

            const check = await aliceCrypto.checkKeyBackupAndEnable();

            const result = await advanceTimersUntil(
                aliceClient.restoreKeyBackupWithRecoveryKey(
                    testData.BACKUP_DECRYPTION_KEY_BASE58,
                    ROOM_ID,
                    testData.MEGOLM_SESSION_DATA.session_id,
                    check!.backupInfo!,
                ),
            );

            expect(result.imported).toStrictEqual(1);
        });

        it("Fails on bad recovery key", async function () {
            const fullBackup = {
                rooms: {
                    [ROOM_ID]: {
                        sessions: {
                            [testData.MEGOLM_SESSION_DATA.session_id]: testData.CURVE25519_KEY_BACKUP_DATA,
                        },
                    },
                },
            };

            fetchMock.get("express:/_matrix/client/v3/room_keys/keys", fullBackup);

            const check = await aliceCrypto.checkKeyBackupAndEnable();

            await expect(
                aliceClient.restoreKeyBackupWithRecoveryKey(
                    "EsTx A7Xn aNFF k3jH zpV3 MQoN LJEg mscC HecF 982L wC77 mYQD",
                    undefined,
                    undefined,
                    check!.backupInfo!,
                ),
            ).rejects.toThrow();
        });
    });

    describe("backupLoop", () => {
        it("Alice should upload known keys when backup is enabled", async function () {
            // 404 means that there is no active backup
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", 404);

            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;
            await aliceClient.startClient();

            // tell Alice to trust the dummy device that signed the backup
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            // check that signalling is working
            const remainingZeroPromise = new Promise<void>((resolve, reject) => {
                aliceClient.on(CryptoEvent.KeyBackupSessionsRemaining, (remaining) => {
                    if (remaining == 0) {
                        resolve();
                    }
                });
            });

            const someRoomKeys = testData.MEGOLM_SESSION_DATA_ARRAY;

            const uploadMockEmitter = mockUploadEmitter(testData.SIGNED_BACKUP_DATA.version!);

            const uploadPromises = someRoomKeys.map((data) => {
                new Promise<void>((resolve) => {
                    uploadMockEmitter.on(MockKeyUploadEvent.KeyUploaded, (roomId, sessionId, version) => {
                        if (
                            data.room_id == roomId &&
                            data.session_id == sessionId &&
                            version == testData.SIGNED_BACKUP_DATA.version
                        ) {
                            resolve();
                        }
                    });
                });
            });

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA, {
                overwriteRoutes: true,
            });

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();

            await aliceCrypto.importRoomKeys(someRoomKeys);

            // The backup loop is waiting a random amount of time to avoid different clients firing at the same time.
            jest.runAllTimers();

            await Promise.all(uploadPromises);

            // Wait until all keys are backed up to ensure that when a new key is received the loop is restarted
            await remainingZeroPromise;

            // A new key import should trigger a new upload.
            const newKey = testData.MEGOLM_SESSION_DATA;

            const newKeyUploadPromise = new Promise<void>((resolve) => {
                uploadMockEmitter.on(MockKeyUploadEvent.KeyUploaded, (roomId, sessionId, version) => {
                    if (
                        newKey.room_id == roomId &&
                        newKey.session_id == sessionId &&
                        version == testData.SIGNED_BACKUP_DATA.version
                    ) {
                        resolve();
                    }
                });
            });

            await aliceCrypto.importRoomKeys([newKey]);

            jest.runAllTimers();
            await newKeyUploadPromise;
        });

        it("Alice should re-upload all keys if a new trusted backup is available", async function () {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;
            await aliceClient.startClient();

            // tell Alice to trust the dummy device that signed the backup
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            // check that signalling is working
            const remainingZeroPromise = new Promise<void>((resolve) => {
                aliceClient.on(CryptoEvent.KeyBackupSessionsRemaining, (remaining) => {
                    if (remaining == 0) {
                        resolve();
                    }
                });
            });

            const someRoomKeys = testData.MEGOLM_SESSION_DATA_ARRAY;

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA, {
                overwriteRoutes: true,
            });

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();

            mockUploadEmitter(testData.SIGNED_BACKUP_DATA.version!);
            await aliceCrypto.importRoomKeys(someRoomKeys);

            // The backup loop is waiting a random amount of time to avoid different clients firing at the same time.
            jest.runAllTimers();

            // wait for all keys to be backed up
            await remainingZeroPromise;

            const newBackupVersion = "2";
            const uploadMockEmitter = mockUploadEmitter(newBackupVersion);
            const newBackup = JSON.parse(JSON.stringify(testData.SIGNED_BACKUP_DATA));
            newBackup.version = newBackupVersion;

            // Let's simulate that a new backup is available by returning error code on key upload

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", newBackup, {
                overwriteRoutes: true,
            });

            // If we import a new key the loop will try to upload to old version, it will
            // fail then check the current version and switch if trusted
            const uploadPromises = someRoomKeys.map((data) => {
                new Promise<void>((resolve) => {
                    uploadMockEmitter.on(MockKeyUploadEvent.KeyUploaded, (roomId, sessionId, version) => {
                        if (data.room_id == roomId && data.session_id == sessionId && version == newBackupVersion) {
                            resolve();
                        }
                    });
                });
            });

            const disableOldBackup = new Promise<void>((resolve) => {
                aliceClient.on(CryptoEvent.KeyBackupFailed, (errCode) => {
                    if (errCode == "M_WRONG_ROOM_KEYS_VERSION") {
                        resolve();
                    }
                });
            });

            const enableNewBackup = new Promise<void>((resolve) => {
                aliceClient.on(CryptoEvent.KeyBackupStatus, (enabled) => {
                    if (enabled) {
                        resolve();
                    }
                });
            });

            // A new key import should trigger a new upload.
            const newKey = testData.MEGOLM_SESSION_DATA;

            const newKeyUploadPromise = new Promise<void>((resolve) => {
                uploadMockEmitter.on(MockKeyUploadEvent.KeyUploaded, (roomId, sessionId, version) => {
                    if (newKey.room_id == roomId && newKey.session_id == sessionId && version == newBackupVersion) {
                        resolve();
                    }
                });
            });

            await aliceCrypto.importRoomKeys([newKey]);

            jest.runAllTimers();

            await disableOldBackup;
            await enableNewBackup;

            jest.runAllTimers();

            await Promise.all(uploadPromises);
            await newKeyUploadPromise;
        });

        it("Backup loop should be resistant to network failures", async function () {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;
            await aliceClient.startClient();

            // tell Alice to trust the dummy device that signed the backup
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA, {
                overwriteRoutes: true,
            });

            // on the first key upload attempt, simulate a network failure
            const failurePromise = new Promise((resolve) => {
                fetchMock.put(
                    "path:/_matrix/client/v3/room_keys/keys",
                    () => {
                        resolve(undefined);
                        throw new TypeError(`Failed to fetch`);
                    },
                    {
                        overwriteRoutes: true,
                    },
                );
            });

            // kick the import loop off and wait for the failed request
            const someRoomKeys = testData.MEGOLM_SESSION_DATA_ARRAY;
            await aliceCrypto.importRoomKeys(someRoomKeys);

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();
            jest.advanceTimersByTime(10 * 60 * 1000);
            await failurePromise;

            // Fix the endpoint to do successful uploads
            const successPromise = new Promise((resolve) => {
                fetchMock.put(
                    "path:/_matrix/client/v3/room_keys/keys",
                    () => {
                        resolve(undefined);
                        return {
                            status: 200,
                            body: {
                                count: 2,
                                etag: "abcdefg",
                            },
                        };
                    },
                    {
                        overwriteRoutes: true,
                    },
                );
            });

            // check that a `KeyBackupSessionsRemaining` event is emitted with `remaining == 0`
            const allKeysUploadedPromise = new Promise((resolve) => {
                aliceClient.on(CryptoEvent.KeyBackupSessionsRemaining, (remaining) => {
                    if (remaining == 0) {
                        resolve(undefined);
                    }
                });
            });

            // run the timers, which will make the backup loop redo the request
            await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
            await successPromise;
            await allKeysUploadedPromise;
        });
    });

    it("getActiveSessionBackupVersion() should give correct result", async function () {
        // 404 means that there is no active backup
        fetchMock.get("express:/_matrix/client/v3/room_keys/version", 404);

        aliceClient = await initTestClient();
        const aliceCrypto = aliceClient.getCrypto()!;
        await aliceClient.startClient();

        // tell Alice to trust the dummy device that signed the backup
        await waitForDeviceList();
        await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);
        await aliceCrypto.checkKeyBackupAndEnable();

        // At this point there is no backup
        let backupStatus: string | null;
        backupStatus = await aliceCrypto.getActiveSessionBackupVersion();
        expect(backupStatus).toBeNull();

        // Serve a backup with no trusted signature
        const unsignedBackup = JSON.parse(JSON.stringify(testData.SIGNED_BACKUP_DATA));
        delete unsignedBackup.auth_data.signatures;
        fetchMock.get("express:/_matrix/client/v3/room_keys/version", unsignedBackup, {
            overwriteRoutes: true,
        });

        const checked = await aliceCrypto.checkKeyBackupAndEnable();
        expect(checked?.backupInfo?.version).toStrictEqual(unsignedBackup.version);
        expect(checked?.trustInfo?.trusted).toBeFalsy();

        backupStatus = await aliceCrypto.getActiveSessionBackupVersion();
        expect(backupStatus).toBeNull();

        // Add a valid signature to the backup
        fetchMock.get("express:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA, {
            overwriteRoutes: true,
        });

        // check that signalling is working
        const backupPromise = new Promise<void>((resolve, reject) => {
            aliceClient.on(CryptoEvent.KeyBackupStatus, (enabled) => {
                if (enabled) {
                    resolve();
                }
            });
        });

        const validCheck = await aliceCrypto.checkKeyBackupAndEnable();
        expect(validCheck?.trustInfo?.trusted).toStrictEqual(true);

        await backupPromise;

        backupStatus = await aliceCrypto.getActiveSessionBackupVersion();
        expect(backupStatus).toStrictEqual(testData.SIGNED_BACKUP_DATA.version);
    });

    describe("isKeyBackupTrusted", () => {
        it("does not trust a backup signed by an untrusted device", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // download the device list, to match the trusted case
            await aliceClient.startClient();
            await waitForDeviceList();

            const result = await aliceCrypto.isKeyBackupTrusted(testData.SIGNED_BACKUP_DATA);
            expect(result).toEqual({ trusted: false, matchesDecryptionKey: false });
        });

        it("trusts a backup signed by a trusted device", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // tell Alice to trust the dummy device that signed the backup
            await aliceClient.startClient();
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            const result = await aliceCrypto.isKeyBackupTrusted(testData.SIGNED_BACKUP_DATA);
            expect(result).toEqual({ trusted: true, matchesDecryptionKey: false });
        });

        it("recognises a backup which matches the decryption key", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            await aliceClient.startClient();
            await aliceCrypto.storeSessionBackupPrivateKey(
                Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                testData.SIGNED_BACKUP_DATA.version!,
            );

            const result = await aliceCrypto.isKeyBackupTrusted(testData.SIGNED_BACKUP_DATA);
            expect(result).toEqual({ trusted: false, matchesDecryptionKey: true });
        });

        it("is not fooled by a backup which matches the decryption key but uses a different algorithm", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            await aliceClient.startClient();
            await aliceCrypto.storeSessionBackupPrivateKey(
                Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                testData.SIGNED_BACKUP_DATA.version!,
            );

            const backup: KeyBackupInfo = JSON.parse(JSON.stringify(testData.SIGNED_BACKUP_DATA));
            backup.algorithm = "m.megolm_backup.v1.aes-hmac-sha2";
            const result = await aliceCrypto.isKeyBackupTrusted(backup);
            expect(result).toEqual({ trusted: false, matchesDecryptionKey: false });
        });
    });

    describe("checkKeyBackupAndEnable", () => {
        it("enables a backup signed by a trusted device", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // tell Alice to trust the dummy device that signed the backup
            await aliceClient.startClient();
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();
            expect(result!.trustInfo).toEqual({ trusted: true, matchesDecryptionKey: false });
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toEqual(testData.SIGNED_BACKUP_DATA.version);
        });

        it("does not enable a backup signed by an untrusted device", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // download the device list, to match the trusted case
            await aliceClient.startClient();
            await waitForDeviceList();

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();
            expect(result!.trustInfo).toEqual({ trusted: false, matchesDecryptionKey: false });
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toBeNull();
        });

        it("disables backup when a new untrusted backup is available", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // tell Alice to trust the dummy device that signed the backup
            await aliceClient.startClient();
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toEqual(testData.SIGNED_BACKUP_DATA.version);

            const unsignedBackup = JSON.parse(JSON.stringify(testData.SIGNED_BACKUP_DATA));
            delete unsignedBackup.auth_data.signatures;
            unsignedBackup.version = "2";

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", unsignedBackup, {
                overwriteRoutes: true,
            });

            await aliceCrypto.checkKeyBackupAndEnable();
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toBeNull();
        });

        it("switches backup when a new trusted backup is available", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // tell Alice to trust the dummy device that signed the backup
            await aliceClient.startClient();
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toEqual(testData.SIGNED_BACKUP_DATA.version);

            const newBackupVersion = "2";
            const newBackup = JSON.parse(JSON.stringify(testData.SIGNED_BACKUP_DATA));
            newBackup.version = newBackupVersion;

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", newBackup, {
                overwriteRoutes: true,
            });

            await aliceCrypto.checkKeyBackupAndEnable();
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toEqual(newBackupVersion);
        });

        it("Disables when backup is deleted", async () => {
            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;

            // tell Alice to trust the dummy device that signed the backup
            await aliceClient.startClient();
            await waitForDeviceList();
            await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            const result = await aliceCrypto.checkKeyBackupAndEnable();
            expect(result).toBeTruthy();
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toEqual(testData.SIGNED_BACKUP_DATA.version);

            fetchMock.get(
                "path:/_matrix/client/v3/room_keys/version",
                {
                    status: 404,
                    body: {
                        errcode: "M_NOT_FOUND",
                        error: "No backup found",
                    },
                },
                {
                    overwriteRoutes: true,
                },
            );
            const noResult = await aliceCrypto.checkKeyBackupAndEnable();
            expect(noResult).toBeNull();
            expect(await aliceCrypto.getActiveSessionBackupVersion()).toBeNull();
        });
    });

    describe("Backup Changed from other sessions", () => {
        beforeEach(async () => {
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

            // ignore requests to send room key requests
            fetchMock.put("express:/_matrix/client/v3/sendToDevice/m.room_key_request/:request_id", {});

            aliceClient = await initTestClient();
            const aliceCrypto = aliceClient.getCrypto()!;
            await aliceCrypto.storeSessionBackupPrivateKey(
                Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                testData.SIGNED_BACKUP_DATA.version!,
            );

            // start after saving the private key
            await aliceClient.startClient();

            // tell Alice to trust the dummy device that signed the backup, and re-check the backup.
            // XXX: should we automatically re-check after a device becomes verified?
            await waitForDeviceList();
            await aliceClient.getCrypto()!.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);
            await aliceClient.getCrypto()!.checkKeyBackupAndEnable();
        });

        // let aliceClient: MatrixClient;

        const SYNC_RESPONSE = {
            next_batch: 1,
            rooms: { join: { [ROOM_ID]: { timeline: { events: [testData.ENCRYPTED_EVENT] } } } },
        };

        it("If current backup has changed, the manager should switch to the new one on UTD", async () => {
            // =====
            // First ensure that the client checks for keys using the backup version 1
            /// =====

            fetchMock.get(
                "express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id",
                (url, request) => {
                    // check that the version is correct
                    const version = new URLSearchParams(new URL(url).search).get("version");
                    if (version == "1") {
                        return testData.CURVE25519_KEY_BACKUP_DATA;
                    } else {
                        return {
                            status: 403,
                            body: {
                                current_version: "1",
                                errcode: "M_WRONG_ROOM_KEYS_VERSION",
                                error: "Wrong backup version.",
                            },
                        };
                    }
                },
                { overwriteRoutes: true },
            );

            // Send Alice a message that she won't be able to decrypt, and check that she fetches the key from the backup.
            syncResponder.sendOrQueueSyncResponse(SYNC_RESPONSE);
            await syncPromise(aliceClient);

            const room = aliceClient.getRoom(ROOM_ID)!;
            const event = room.getLiveTimeline().getEvents()[0];
            await advanceTimersUntil(awaitDecryption(event, { waitOnDecryptionFailure: true }));

            expect(event.getContent()).toEqual(testData.CLEAR_EVENT.content);

            // =====
            // Second suppose now that the backup has changed to version 2
            /// =====

            const newBackup = {
                ...testData.SIGNED_BACKUP_DATA,
                version: "2",
            };

            fetchMock.get("path:/_matrix/client/v3/room_keys/version", newBackup, { overwriteRoutes: true });
            // suppose the new key is now known
            const aliceCrypto = aliceClient.getCrypto()!;
            await aliceCrypto.storeSessionBackupPrivateKey(
                Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                newBackup.version,
            );

            // A check backup should happen at some point
            await aliceCrypto.checkKeyBackupAndEnable();

            const awaitHasQueriedNewBackup: IDeferred<void> = defer<void>();

            fetchMock.get(
                "express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id",
                (url, request) => {
                    // check that the version is correct
                    const version = new URLSearchParams(new URL(url).search).get("version");
                    if (version == newBackup.version) {
                        awaitHasQueriedNewBackup.resolve();
                        return testData.CURVE25519_KEY_BACKUP_DATA;
                    } else {
                        // awaitHasQueriedOldBackup.resolve();
                        return {
                            status: 403,
                            body: {
                                current_version: "2",
                                errcode: "M_WRONG_ROOM_KEYS_VERSION",
                                error: "Wrong backup version.",
                            },
                        };
                    }
                },
                { overwriteRoutes: true },
            );

            // Send Alice a message that she won't be able to decrypt, and check that she fetches the key from the new backup.
            const newMessage: Partial<IEvent> = {
                type: "m.room.encrypted",
                room_id: "!room:id",
                sender: "@alice:localhost",
                content: {
                    algorithm: "m.megolm.v1.aes-sha2",
                    ciphertext:
                        "AwgAEpABKvf9FqPW52zeHfeVTn90a3jlBLlx7g6VDEkc2089RQUJoWpSJRiK13E83rN41wgGFJccyfoCr7ZDGJeuGYMGETTrgnLQhLs6JmyPf37JYkzxW8uS8rGUKEqTFQriKhibHVLvVacOlSIObUiKU/V3r176XuixqZF/4eyK9A22JNpInbgI10ZUT6LnApH9LR3FpZbE2zImf1uNPuvp7r0xQbW7CcJjqpH+qTPBD5zFdFnMkc2SnbXCsIOaX11Dm0krWfQz7iA26ZnI1nyZnyh7XPrCnJCRsuQH",
                    device_id: "WVMJGTSSVB",
                    sender_key: "E5RiY/YCIrHWaF4u416CqvblC6udK2jt9SJ/h1QeLS0",
                    session_id: "ybnW+LGdUhoS4fHm1DAEphukO3sZ1GCqZD7UQz7L+GA",
                },
                event_id: "$event2",
                origin_server_ts: 1507753887000,
            };

            const nextSyncResponse = {
                next_batch: 2,
                rooms: { join: { [ROOM_ID]: { timeline: { events: [newMessage] } } } },
            };
            syncResponder.sendOrQueueSyncResponse(nextSyncResponse);
            await syncPromise(aliceClient);

            await awaitHasQueriedNewBackup.promise;
        });
    });

    /** make sure that the client knows about the dummy device */
    async function waitForDeviceList(): Promise<void> {
        // Completing the initial sync will make the device list download outdated device lists (of which our own
        // user will be one).
        syncResponder.sendOrQueueSyncResponse({});
        // DeviceList has a sleep(5) which we need to make happen
        await jest.advanceTimersByTimeAsync(10);

        // The client should now know about the dummy device
        const devices = await aliceClient.getCrypto()!.getUserDeviceInfo([TEST_USER_ID]);
        expect(devices.get(TEST_USER_ID)!.keys()).toContain(TEST_DEVICE_ID);
    }
});
