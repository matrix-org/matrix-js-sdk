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

import { IKeyBackupSession } from "../../../src/crypto/keybackup";
import { createClient, CryptoEvent, ICreateClientOpts, IEvent, MatrixClient, TypedEventEmitter } from "../../../src";
import { SyncResponder } from "../../test-utils/SyncResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import { awaitDecryption, CRYPTO_BACKENDS, InitCrypto, syncPromise } from "../../test-utils/test-utils";
import * as testData from "../../test-utils/test-data";
import { KeyBackupInfo } from "../../../src/crypto-api/keybackup";
import { IKeyBackup } from "../../../src/crypto/backup";

const ROOM_ID = "!ROOM:ID";

/** The homeserver url that we give to the test client, and where we intercept /sync, /keys, etc requests. */
const TEST_HOMESERVER_URL = "https://alice-server.com";

const SESSION_ID = "o+21hSjP+mgEmcfdslPsQdvzWnkdt0Wyo00Kp++R8Kc";

const ENCRYPTED_EVENT: Partial<IEvent> = {
    type: "m.room.encrypted",
    content: {
        algorithm: "m.megolm.v1.aes-sha2",
        sender_key: "SENDER_CURVE25519",
        session_id: SESSION_ID,
        ciphertext:
            "AwgAEjD+VwXZ7PoGPRS/H4kwpAsMp/g+WPvJVtPEKE8fmM9IcT/N" +
            "CiwPb8PehecDKP0cjm1XO88k6Bw3D17aGiBHr5iBoP7oSw8CXULXAMTkBl" +
            "mkufRQq2+d0Giy1s4/Cg5n13jSVrSb2q7VTSv1ZHAFjUCsLSfR0gxqcQs",
    },
    room_id: "!ROOM:ID",
    event_id: "$event1",
    origin_server_ts: 1507753886000,
};

const CURVE25519_KEY_BACKUP_DATA: IKeyBackupSession = {
    first_message_index: 0,
    forwarded_count: 0,
    is_verified: false,
    session_data: {
        ciphertext:
            "2z2M7CZ+azAiTHN1oFzZ3smAFFt+LEOYY6h3QO3XXGdw" +
            "6YpNn/gpHDO6I/rgj1zNd4FoTmzcQgvKdU8kN20u5BWRHxaHTZ" +
            "Slne5RxE6vUdREsBgZePglBNyG0AogR/PVdcrv/v18Y6rLM5O9" +
            "SELmwbV63uV9Kuu/misMxoqbuqEdG7uujyaEKtjlQsJ5MGPQOy" +
            "Syw7XrnesSwF6XWRMxcPGRV0xZr3s9PI350Wve3EncjRgJ9IGF" +
            "ru1bcptMqfXgPZkOyGvrphHoFfoK7nY3xMEHUiaTRfRIjq8HNV" +
            "4o8QY1qmWGnxNBQgOlL8MZlykjg3ULmQ3DtFfQPj/YYGS3jzxv" +
            "C+EBjaafmsg+52CTeK3Rswu72PX450BnSZ1i3If4xWAUKvjTpe" +
            "Ug5aDLqttOv1pITolTJDw5W/SD+b5rjEKg1CFCHGEGE9wwV3Nf" +
            "QHVCQL+dfpd7Or0poy4dqKMAi3g0o3Tg7edIF8d5rREmxaALPy" +
            "iie8PHD8mj/5Y0GLqrac4CD6+Mop7eUTzVovprjg",
        mac: "5lxYBHQU80M",
        ephemeral: "/Bn0A4UMFwJaDDvh0aEk1XZj3k1IfgCxgFY9P9a0b14",
    },
};

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
    const oldBackendOnly = backend === "rust-sdk" ? test.skip : test;

    let aliceClient: MatrixClient;
    /** an object which intercepts `/sync` requests on the test homeserver */
    let syncResponder: SyncResponder;

    /** an object which intercepts `/keys/upload` requests on the test homeserver */
    let e2eKeyReceiver: E2EKeyReceiver;
    /** an object which intercepts `/keys/query` requests on the test homeserver */
    let e2eKeyResponder: E2EKeyResponder;

    jest.useFakeTimers();

    beforeEach(async () => {
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

    oldBackendOnly("Alice checks key backups when receiving a message she can't decrypt", async function () {
        const syncResponse = {
            next_batch: 1,
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: {
                            events: [ENCRYPTED_EVENT],
                        },
                    },
                },
            },
        };

        fetchMock.get("express:/_matrix/client/v3/room_keys/keys/:room_id/:session_id", CURVE25519_KEY_BACKUP_DATA);
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);

        aliceClient = await initTestClient();
        const aliceCrypto = aliceClient.getCrypto()!;
        await aliceCrypto.storeSessionBackupPrivateKey(Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"));

        // start after saving the private key
        await aliceClient.startClient();

        // tell Alice to trust the dummy device that signed the backup, and re-check the backup.
        // XXX: should we automatically re-check after a device becomes verified?
        await waitForDeviceList();
        await aliceCrypto.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);
        await aliceClient.checkKeyBackup();

        // Now, send Alice a message that she won't be able to decrypt, and check that she fetches the key from the backup.
        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        const event = room.getLiveTimeline().getEvents()[0];
        await awaitDecryption(event, { waitOnDecryptionFailure: true });
        expect(event.getContent()).toEqual("testytest");
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
            jest.runAllTimers();
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
            await jest.runAllTimersAsync();
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
