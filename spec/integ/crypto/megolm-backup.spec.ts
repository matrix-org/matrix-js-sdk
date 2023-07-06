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

import { logger } from "../../../src/logger";
import { decodeRecoveryKey } from "../../../src/crypto/recoverykey";
import { IKeyBackupInfo, IKeyBackupSession } from "../../../src/crypto/keybackup";
import { createClient, ICreateClientOpts, IEvent, MatrixClient } from "../../../src";
import { MatrixEvent, MatrixEventEvent } from "../../../src/models/event";
import { CRYPTO_BACKENDS, InitCrypto, syncPromise } from "../../test-utils/test-utils";
import { SyncResponder } from "../../test-utils/SyncResponder";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";

const ROOM_ID = "!ROOM:ID";

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

const CURVE25519_BACKUP_INFO: IKeyBackupInfo = {
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    version: "1",
    auth_data: {
        public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
        // Will be updated with correct value on the fly
        signatures: {
            "@alice:localhost": {
                "ed25519:BGVSTTXKZB":
                    "RNUIJIcDrsyvKV4MReMzllZ6yx05803tR0/tdO8poS62wUsVNOgxglC2VPwGSxji/hxv7c7D8FTuQ3uQWcR1DQ",
            },
        },
    },
};
/** The homeserver url that we give to the test client, and where we intercept /sync, /keys, etc requests. */
const TEST_HOMESERVER_URL = "https://alice-server.com";

const RECOVERY_KEY = "EsTc LW2K PGiF wKEA 3As5 g5c4 BXwk qeeJ ZJV8 Q9fu gUMN UE4d";

// jest.useFakeTimers();

beforeAll(async () => {
    // we use the libolm primitives in the test, so init the Olm library
    await global.Olm.init();
});

// load the rust library. This can take a few seconds on a slow GH worker.
beforeAll(async () => {
    const RustSdkCryptoJs = await require("@matrix-org/matrix-sdk-crypto-js");
    await RustSdkCryptoJs.initAsync();
}, 10000);

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

const TEST_USER_ID = "@alice:localhost";
const TEST_DEVICE_ID = "xzcvb";

/**
 * Integration tests for cross-signing functionality.
 *
 * These tests work by intercepting HTTP requests via fetch-mock rather than mocking out bits of the client, so as
 * to provide the most effective integration tests possible.
 */
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
        fetchMock.post("express:/_matrix/client/r0/keys/upload", {
            one_time_key_counts: {
                curve25519: 100,
                signed_curve25519: 100,
            },
        });
        // mock for the outgoing key requests that will be sent
        fetchMock.put("express:/_matrix/client/r0/sendToDevice/m.room_key_request/:txid", {});

        fetchMock.get("express:/_matrix/client/v3/room_keys/version", CURVE25519_BACKUP_INFO);

        aliceClient = await initTestClient();

        // we need the backup to be trusted for the test to work
        await aliceClient.getCrypto()?.signObject(CURVE25519_BACKUP_INFO.auth_data);
        fetchMock.get("express:/_matrix/client/v3/room_keys/version", CURVE25519_BACKUP_INFO, {
            overwriteRoutes: true,
        });

        await aliceClient.getCrypto()?.storeSessionBackupPrivateKey(decodeRecoveryKey(RECOVERY_KEY));
        await aliceClient.getCrypto()?.getBackupManager()?.checkAndStart();

        // start after saving the private key
        await aliceClient.startClient();

        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;

        const event = room.getLiveTimeline().getEvents()[0];

        const decryptPromise: Promise<MatrixEvent> = new Promise((resolve, reject) => {
            event.once(MatrixEventEvent.Decrypted, (ev) => {
                logger.log(`${Date.now()} event ${event.getId()} now decrypted`);
                resolve(ev);
            });
        });
        const decryptedEvent = await decryptPromise;

        expect(decryptedEvent.getContent()).toEqual("testytest");
    });
});
