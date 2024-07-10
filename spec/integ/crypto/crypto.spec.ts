/*
Copyright 2016 OpenMarket Ltd
Copyright 2019-2023 The Matrix.org Foundation C.I.C.

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

import anotherjson from "another-json";
import fetchMock from "fetch-mock-jest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import FetchMock from "fetch-mock";
import Olm from "@matrix-org/olm";

import * as testUtils from "../../test-utils/test-utils";
import {
    advanceTimersUntil,
    CRYPTO_BACKENDS,
    emitPromise,
    getSyncResponse,
    InitCrypto,
    mkEventCustom,
    mkMembershipCustom,
    syncPromise,
} from "../../test-utils/test-utils";
import * as testData from "../../test-utils/test-data";
import {
    BOB_SIGNED_CROSS_SIGNING_KEYS_DATA,
    BOB_SIGNED_TEST_DEVICE_DATA,
    BOB_TEST_USER_ID,
    SIGNED_CROSS_SIGNING_KEYS_DATA,
    SIGNED_TEST_DEVICE_DATA,
    TEST_ROOM_ID,
    TEST_ROOM_ID as ROOM_ID,
    TEST_USER_ID,
} from "../../test-utils/test-data";
import { TestClient } from "../../TestClient";
import { logger } from "../../../src/logger";
import {
    Category,
    ClientEvent,
    createClient,
    CryptoEvent,
    HistoryVisibility,
    IClaimOTKsResult,
    IContent,
    IDownloadKeyResult,
    IEvent,
    IndexedDBCryptoStore,
    IStartClientOpts,
    MatrixClient,
    MatrixEvent,
    MatrixEventEvent,
    MsgType,
    PendingEventOrdering,
    Room,
    RoomMember,
    RoomStateEvent,
} from "../../../src/matrix";
import { DeviceInfo } from "../../../src/crypto/deviceinfo";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { ISyncResponder, SyncResponder } from "../../test-utils/SyncResponder";
import { defer, escapeRegExp } from "../../../src/utils";
import { downloadDeviceToJsDevice } from "../../../src/rust-crypto/device-converter";
import { flushPromises } from "../../test-utils/flushPromises";
import {
    mockInitialApiRequests,
    mockSetupCrossSigningRequests,
    mockSetupMegolmBackupRequests,
} from "../../test-utils/mockEndpoints";
import { SecretStorageKeyDescription } from "../../../src/secret-storage";
import {
    CrossSigningKey,
    CryptoCallbacks,
    DecryptionFailureCode,
    EventShieldColour,
    EventShieldReason,
    KeyBackupInfo,
} from "../../../src/crypto-api";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { IKeyBackup } from "../../../src/crypto/backup";
import {
    createOlmAccount,
    createOlmSession,
    encryptGroupSessionKey,
    encryptMegolmEvent,
    encryptMegolmEventRawPlainText,
    encryptOlmEvent,
    establishOlmSession,
    getTestOlmAccountKeys,
} from "./olm-utils";
import { ToDevicePayload } from "../../../src/models/ToDeviceMessage";
import { AccountDataAccumulator } from "../../test-utils/AccountDataAccumulator";
import { UNSIGNED_MEMBERSHIP_FIELD } from "../../../src/@types/event";
import { KnownMembership } from "../../../src/@types/membership";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();

    jest.useRealTimers();
});

/**
 * Expect that the client shares keys with the given recipient
 *
 * Waits for an HTTP request to send the encrypted m.room_key to-device message; decrypts it and uses it
 * to establish an Olm InboundGroupSession.
 *
 * @param recipientUserID - the user id of the expected recipient
 *
 * @param recipientOlmAccount - Olm.Account for the recipient
 *
 * @param recipientOlmSession - an Olm.Session for the recipient, which must already have exchanged pre-key
 *    messages with the sender. Alternatively, null, in which case we will expect a pre-key message.
 *
 * @returns the established inbound group session
 */
async function expectSendRoomKey(
    recipientUserID: string,
    recipientOlmAccount: Olm.Account,
    recipientOlmSession: Olm.Session | null = null,
): Promise<Olm.InboundGroupSession> {
    const Olm = global.Olm;
    const testRecipientKey = JSON.parse(recipientOlmAccount.identity_keys())["curve25519"];

    function onSendRoomKey(content: any): Olm.InboundGroupSession {
        const m = content.messages[recipientUserID].DEVICE_ID;
        const ct = m.ciphertext[testRecipientKey];

        if (!recipientOlmSession) {
            expect(ct.type).toEqual(0); // pre-key message
            recipientOlmSession = new Olm.Session();
            recipientOlmSession.create_inbound(recipientOlmAccount, ct.body);
        } else {
            expect(ct.type).toEqual(1); // regular message
        }

        const decrypted = JSON.parse(recipientOlmSession.decrypt(ct.type, ct.body));
        expect(decrypted.type).toEqual("m.room_key");
        const inboundGroupSession = new Olm.InboundGroupSession();
        inboundGroupSession.create(decrypted.content.session_key);
        return inboundGroupSession;
    }
    return await new Promise<Olm.InboundGroupSession>((resolve) => {
        fetchMock.putOnce(
            new RegExp("/sendToDevice/m.room.encrypted/"),
            (url: string, opts: RequestInit): FetchMock.MockResponse => {
                const content = JSON.parse(opts.body as string);
                resolve(onSendRoomKey(content));
                return {};
            },
            {
                // append to the list of intercepts on this path (since we have some tests that call
                // this function multiple times)
                overwriteRoutes: false,
            },
        );
    });
}

/**
 * Return the event received on rooms/{roomId}/send/m.room.encrypted endpoint.
 * See https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid
 * @returns the content of the encrypted event
 */
function expectEncryptedSendMessage() {
    return new Promise<IContent>((resolve) => {
        fetchMock.putOnce(
            new RegExp("/send/m.room.encrypted/"),
            (url, request) => {
                const content = JSON.parse(request.body as string);
                resolve(content);
                return { event_id: "$event_id" };
            },
            // append to the list of intercepts on this path (since we have some tests that call
            // this function multiple times)
            { overwriteRoutes: false },
        );
    });
}

/**
 * Expect that the client sends an encrypted event
 *
 * Waits for an HTTP request to send an encrypted message in the test room.
 *
 * @param inboundGroupSessionPromise - a promise for an Olm InboundGroupSession, which will
 *    be used to decrypt the event. We will wait for this to resolve once the HTTP request has been processed.
 *
 * @returns The content of the successfully-decrypted event
 */
async function expectSendMegolmMessage(
    inboundGroupSessionPromise: Promise<Olm.InboundGroupSession>,
): Promise<Partial<IEvent>> {
    const encryptedMessageContent = await expectEncryptedSendMessage();

    // In some of the tests, the room key is sent *after* the actual event, so we may need to wait for it now.
    const inboundGroupSession = await inboundGroupSessionPromise;

    const r: any = inboundGroupSession.decrypt(encryptedMessageContent!.ciphertext);
    logger.log("Decrypted received megolm message", r);
    return JSON.parse(r.plaintext);
}

describe.each(Object.entries(CRYPTO_BACKENDS))("crypto (%s)", (backend: string, initCrypto: InitCrypto) => {
    if (!global.Olm) {
        // currently we use libolm to implement the crypto in the tests, so need it to be present.
        logger.warn("not running megolm tests: Olm not present");
        return;
    }

    // oldBackendOnly is an alternative to `it` or `test` which will skip the test if we are running against the
    // Rust backend. Once we have full support in the rust sdk, it will go away.
    const oldBackendOnly = backend === "rust-sdk" ? test.skip : test;
    const newBackendOnly = backend !== "rust-sdk" ? test.skip : test;

    const Olm = global.Olm;

    let testOlmAccount = {} as unknown as Olm.Account;
    let testSenderKey = "";

    /** the MatrixClient under test */
    let aliceClient: MatrixClient;

    /** an object which intercepts `/keys/upload` requests from {@link #aliceClient} to catch the uploaded keys */
    let keyReceiver: E2EKeyReceiver;

    /** an object which intercepts `/sync` requests from {@link #aliceClient} */
    let syncResponder: ISyncResponder;

    async function startClientAndAwaitFirstSync(opts: IStartClientOpts = {}): Promise<void> {
        logger.log(aliceClient.getUserId() + ": starting");

        mockInitialApiRequests(aliceClient.getHomeserverUrl());

        // we let the client do a very basic initial sync, which it needs before
        // it will upload one-time keys.
        syncResponder.sendOrQueueSyncResponse({ next_batch: 1 });

        aliceClient.startClient({
            // set this so that we can get hold of failed events
            pendingEventOrdering: PendingEventOrdering.Detached,
            ...opts,
        });

        await syncPromise(aliceClient);
        logger.log(aliceClient.getUserId() + ": started");
    }

    /**
     * Set up expectations that the client will query device keys.
     *
     * We check that the query contains each of the users in `response`.
     *
     * @param response -   response to the query.
     */
    function expectAliceKeyQuery(response: IDownloadKeyResult) {
        function onQueryRequest(content: any): object {
            Object.keys(response.device_keys).forEach((userId) => {
                expect((content.device_keys! as Record<string, any>)[userId]).toEqual([]);
            });
            return response;
        }
        const rootRegexp = escapeRegExp(new URL("/_matrix/client/", aliceClient.getHomeserverUrl()).toString());
        fetchMock.postOnce(
            new RegExp(rootRegexp + "(r0|v3)/keys/query"),
            (url: string, opts: RequestInit) => onQueryRequest(JSON.parse(opts.body as string)),
            {
                // append to the list of intercepts on this path
                overwriteRoutes: false,
            },
        );
    }

    /**
     * Add an expectation for a /keys/claim request for the MatrixClient under test
     *
     * @param response - the response to return from the request. Normally an {@link IClaimOTKsResult}
     *   (or a function that returns one).
     */
    function expectAliceKeyClaim(response: FetchMock.MockResponse | FetchMock.MockResponseFunction) {
        const rootRegexp = escapeRegExp(new URL("/_matrix/client/", aliceClient.getHomeserverUrl()).toString());
        fetchMock.postOnce(new RegExp(rootRegexp + "(r0|v3)/keys/claim"), response);
    }

    /**
     * Get the device keys for testOlmAccount in a format suitable for a
     * response to /keys/query
     *
     * @param userId - The user ID to query for
     * @returns The fake query response
     */
    function getTestKeysQueryResponse(userId: string): IDownloadKeyResult {
        const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, userId, "DEVICE_ID");
        return {
            device_keys: { [userId]: { DEVICE_ID: testDeviceKeys } },
            failures: {},
        };
    }

    /**
     * Get a one-time key for testOlmAccount in a format suitable for a
     * response to /keys/claim

     * @param userId - The user ID to query for
     * @returns The fake key claim response
     */
    function getTestKeysClaimResponse(userId: string): IClaimOTKsResult {
        testOlmAccount.generate_one_time_keys(1);
        const testOneTimeKeys = JSON.parse(testOlmAccount.one_time_keys());
        testOlmAccount.mark_keys_as_published();

        const keyId = Object.keys(testOneTimeKeys.curve25519)[0];
        const oneTimeKey: string = testOneTimeKeys.curve25519[keyId];
        const unsignedKeyResult = { key: oneTimeKey };
        const j = anotherjson.stringify(unsignedKeyResult);
        const sig = testOlmAccount.sign(j);
        const keyResult = {
            ...unsignedKeyResult,
            signatures: { [userId]: { "ed25519:DEVICE_ID": sig } },
        };

        return {
            one_time_keys: { [userId]: { DEVICE_ID: { ["signed_curve25519:" + keyId]: keyResult } } },
            failures: {},
        };
    }

    /**
     * Create the {@link CryptoCallbacks}
     */
    function createCryptoCallbacks(): CryptoCallbacks {
        // Store the cached secret storage key and return it when `getSecretStorageKey` is called
        let cachedKey: { keyId: string; key: Uint8Array };
        const cacheSecretStorageKey = (keyId: string, keyInfo: SecretStorageKeyDescription, key: Uint8Array) => {
            cachedKey = {
                keyId,
                key,
            };
        };

        const getSecretStorageKey = () => Promise.resolve<[string, Uint8Array]>([cachedKey.keyId, cachedKey.key]);

        return {
            cacheSecretStorageKey,
            getSecretStorageKey,
        };
    }

    beforeEach(
        async () => {
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);
            fetchMock.config.warnOnFallback = false;

            const homeserverUrl = "https://alice-server.com";
            aliceClient = createClient({
                baseUrl: homeserverUrl,
                userId: "@alice:localhost",
                accessToken: "akjgkrgjs",
                deviceId: "xzcvb",
                cryptoCallbacks: createCryptoCallbacks(),
                logger: logger.getChild("aliceClient"),
            });

            /* set up listeners for /keys/upload and /sync */
            keyReceiver = new E2EKeyReceiver(homeserverUrl);
            syncResponder = new SyncResponder(homeserverUrl);

            await initCrypto(aliceClient);

            // create a test olm device which we will use to communicate with alice. We use libolm to implement this.
            testOlmAccount = await createOlmAccount();
            const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
            testSenderKey = testE2eKeys.curve25519;
        },
        /* it can take a while to initialise the crypto library on the first pass, so bump up the timeout. */
        10000,
    );

    afterEach(async () => {
        await aliceClient.stopClient();

        // Allow in-flight things to complete before we tear down the test
        await jest.runAllTimersAsync();

        fetchMock.mockReset();
    });

    it("MatrixClient.getCrypto returns a CryptoApi", () => {
        expect(aliceClient.getCrypto()).toHaveProperty("globalBlacklistUnverifiedDevices");
    });

    it("CryptoAPI.getOwnDeviceKeys returns plausible values", async () => {
        const deviceKeys = await aliceClient.getCrypto()!.getOwnDeviceKeys();
        // We just check for a 43-character base64 string
        expect(deviceKeys.curve25519).toMatch(/^[A-Za-z0-9+/]{43}$/);
        expect(deviceKeys.ed25519).toMatch(/^[A-Za-z0-9+/]{43}$/);
    });

    it("Alice receives a megolm message", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto.deviceList.downloadKeys = () => Promise.resolve(new Map());
            aliceClient.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, keyReceiver);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // encrypt a message with the group session
        const messageEncrypted = encryptMegolmEvent({
            senderKey: testSenderKey,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // Alice gets both the events in a single sync
        const syncResponse = {
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted],
            },
            rooms: {
                join: {
                    [ROOM_ID]: { timeline: { events: [messageEncrypted] } },
                },
            },
        };

        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.isEncrypted()).toBe(true);

        // it probably won't be decrypted yet, because it takes a while to process the olm keys
        const decryptedEvent = await testUtils.awaitDecryption(event, { waitOnDecryptionFailure: true });
        expect(decryptedEvent.getContent().body).toEqual("42");
    });

    describe("Unable to decrypt error codes", function () {
        beforeEach(() => {
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
        });

        it("Decryption fails with UISI error", async () => {
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();

            // A promise which resolves, with the MatrixEvent which wraps the event, once the decryption fails.
            const awaitDecryption = emitPromise(aliceClient, MatrixEventEvent.Decrypted);

            // Ensure that the timestamp post-dates the creation of our device
            const encryptedEvent = {
                ...testData.ENCRYPTED_EVENT,
                origin_server_ts: Date.now(),
            };

            const syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {
                        [testData.TEST_ROOM_ID]: { timeline: { events: [encryptedEvent] } },
                    },
                },
            };

            syncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);
            const ev = await awaitDecryption;
            expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID);
        });

        it("Decryption fails with Unknown Index error", async () => {
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();

            // A promise which resolves, with the MatrixEvent which wraps the event, once the decryption fails.
            const awaitDecryption = emitPromise(aliceClient, MatrixEventEvent.Decrypted);

            await aliceClient.getCrypto()!.importRoomKeys([testData.RATCHTED_MEGOLM_SESSION_DATA]);

            // Ensure that the timestamp post-dates the creation of our device
            const encryptedEvent = {
                ...testData.ENCRYPTED_EVENT,
                origin_server_ts: Date.now(),
            };

            const syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {
                        [testData.TEST_ROOM_ID]: { timeline: { events: [encryptedEvent] } },
                    },
                },
            };

            syncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);

            const ev = await awaitDecryption;
            expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX);
        });

        describe("Historical events", () => {
            async function sendEventAndAwaitDecryption(props: Partial<IEvent> = {}): Promise<MatrixEvent> {
                // A promise which resolves, with the MatrixEvent which wraps the event, once the decryption fails.
                const awaitDecryption = emitPromise(aliceClient, MatrixEventEvent.Decrypted);

                // Ensure that the timestamp pre-dates the creation of our device: set it to 24 hours ago
                const encryptedEvent = {
                    ...testData.ENCRYPTED_EVENT,
                    origin_server_ts: Date.now() - 24 * 3600 * 1000,
                    ...props,
                };

                const syncResponse = {
                    next_batch: 1,
                    rooms: {
                        join: {
                            [testData.TEST_ROOM_ID]: { timeline: { events: [encryptedEvent] } },
                        },
                    },
                };

                syncResponder.sendOrQueueSyncResponse(syncResponse);
                return await awaitDecryption;
            }

            newBackendOnly("fails with HISTORICAL_MESSAGE_BACKUP_NO_BACKUP when there is no backup", async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                    status: 404,
                    body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                });
                expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                await startClientAndAwaitFirstSync();

                const ev = await sendEventAndAwaitDecryption();
                expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP);
            });

            newBackendOnly("fails with HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED when the backup is broken", async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", {});
                expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                await startClientAndAwaitFirstSync();

                const ev = await sendEventAndAwaitDecryption();
                expect(ev.decryptionFailureReason).toEqual(
                    DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
                );
            });

            newBackendOnly("fails with HISTORICAL_MESSAGE_WORKING_BACKUP when backup is working", async () => {
                // The test backup data is signed by a dummy device. We'll need to tell Alice about the device, and
                // later, tell her to trust it, so that she trusts the backup.
                const e2eResponder = new E2EKeyResponder(aliceClient.getHomeserverUrl());
                e2eResponder.addDeviceKeys(testData.SIGNED_TEST_DEVICE_DATA);
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", testData.SIGNED_BACKUP_DATA);
                await startClientAndAwaitFirstSync();

                await aliceClient
                    .getCrypto()!
                    .storeSessionBackupPrivateKey(
                        Buffer.from(testData.BACKUP_DECRYPTION_KEY_BASE64, "base64"),
                        testData.SIGNED_BACKUP_DATA.version!,
                    );

                // Tell Alice to trust the dummy device that signed the backup
                const devices = await aliceClient.getCrypto()!.getUserDeviceInfo([TEST_USER_ID]);
                expect(devices.get(TEST_USER_ID)!.keys()).toContain(testData.TEST_DEVICE_ID);
                await aliceClient.getCrypto()!.setDeviceVerified(testData.TEST_USER_ID, testData.TEST_DEVICE_ID);

                // Tell Alice to check and enable backup
                await aliceClient.getCrypto()!.checkKeyBackupAndEnable();

                // Sanity: Alice should now have working backup.
                expect(await aliceClient.getCrypto()!.getActiveSessionBackupVersion()).toEqual(
                    testData.SIGNED_BACKUP_DATA.version,
                );

                // Finally! we can check what happens when we get an event.
                const ev = await sendEventAndAwaitDecryption();
                expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP);
            });

            newBackendOnly("fails with NOT_JOINED if user is not member of room", async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                    status: 404,
                    body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                });
                expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                await startClientAndAwaitFirstSync();

                const ev = await sendEventAndAwaitDecryption({
                    unsigned: {
                        [UNSIGNED_MEMBERSHIP_FIELD.name]: "leave",
                    },
                });
                expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED);
            });

            newBackendOnly(
                "fails with NOT_JOINED if user is not member of room (MSC4115 unstable prefix)",
                async () => {
                    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                        status: 404,
                        body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                    });
                    expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                    await startClientAndAwaitFirstSync();

                    const ev = await sendEventAndAwaitDecryption({
                        unsigned: {
                            [UNSIGNED_MEMBERSHIP_FIELD.altName!]: "leave",
                        },
                    });
                    expect(ev.decryptionFailureReason).toEqual(
                        DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED,
                    );
                },
            );

            newBackendOnly(
                "fails with another error when the server reports user was a member of the room",
                async () => {
                    // This tests that when the server reports that the user
                    // was invited at the time the event was sent, then we
                    // don't get a HISTORICAL_MESSAGE_USER_NOT_JOINED error,
                    // and instead get some other error, since the user should
                    // have gotten the key for the event.
                    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                        status: 404,
                        body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                    });
                    expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                    await startClientAndAwaitFirstSync();

                    const ev = await sendEventAndAwaitDecryption({
                        unsigned: {
                            [UNSIGNED_MEMBERSHIP_FIELD.name]: "invite",
                        },
                    });
                    expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP);
                },
            );

            newBackendOnly(
                "fails with another error when the server reports user was a member of the room (MSC4115 unstable prefix)",
                async () => {
                    // This tests that when the server reports that the user
                    // was invited at the time the event was sent, then we
                    // don't get a HISTORICAL_MESSAGE_USER_NOT_JOINED error,
                    // and instead get some other error, since the user should
                    // have gotten the key for the event.
                    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                        status: 404,
                        body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                    });
                    expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                    await startClientAndAwaitFirstSync();

                    const ev = await sendEventAndAwaitDecryption({
                        unsigned: {
                            [UNSIGNED_MEMBERSHIP_FIELD.altName!]: "invite",
                        },
                    });
                    expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP);
                },
            );

            newBackendOnly(
                "fails with another error when the server reports user was a member of the room",
                async () => {
                    // This tests that when the server reports the user's
                    // membership, and reports that the user was joined, then we
                    // don't get a HISTORICAL_MESSAGE_USER_NOT_JOINED error, and
                    // instead get some other error.
                    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                        status: 404,
                        body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                    });
                    expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                    await startClientAndAwaitFirstSync();

                    const ev = await sendEventAndAwaitDecryption({
                        unsigned: {
                            [UNSIGNED_MEMBERSHIP_FIELD.name]: "join",
                        },
                    });
                    expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP);
                },
            );

            newBackendOnly(
                "fails with another error when the server reports user was a member of the room (MSC4115 unstable prefix)",
                async () => {
                    // This tests that when the server reports the user's
                    // membership, and reports that the user was joined, then we
                    // don't get a HISTORICAL_MESSAGE_USER_NOT_JOINED error, and
                    // instead get some other error.
                    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                        status: 404,
                        body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                    });
                    expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                    await startClientAndAwaitFirstSync();

                    const ev = await sendEventAndAwaitDecryption({
                        unsigned: {
                            [UNSIGNED_MEMBERSHIP_FIELD.altName!]: "join",
                        },
                    });
                    expect(ev.decryptionFailureReason).toEqual(DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP);
                },
            );
        });

        it("Decryption fails with Unable to decrypt for other errors", async () => {
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();

            await aliceClient.getCrypto()!.importRoomKeys([testData.MEGOLM_SESSION_DATA]);

            const awaitDecryptionError = new Promise<void>((resolve) => {
                aliceClient.on(MatrixEventEvent.Decrypted, (ev) => {
                    // rust and libolm can't have an exact 1:1 mapping for all errors,
                    // but some errors are part of API and should match
                    if (
                        ev.decryptionFailureReason !== DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID &&
                        ev.decryptionFailureReason !== DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX
                    ) {
                        resolve();
                    }
                });
            });

            const malformedEvent: Partial<IEvent> = JSON.parse(JSON.stringify(testData.ENCRYPTED_EVENT));
            malformedEvent.content!.ciphertext = "AwgAEnAkBmciEAyhh1j6DCk29UXJ7kv/kvayUNfuNT0iAioLxcXjFX";

            // Alice gets both the events in a single sync
            const syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {
                        [testData.TEST_ROOM_ID]: { timeline: { events: [malformedEvent] } },
                    },
                },
            };

            syncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);

            await awaitDecryptionError;
        });
    });

    it("Alice receives a megolm message before the session keys", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto.deviceList.downloadKeys = () => Promise.resolve(new Map());
            aliceClient.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, keyReceiver);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event, but don't send it yet
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // encrypt a message with the group session
        const messageEncrypted = encryptMegolmEvent({
            senderKey: testSenderKey,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // Alice just gets the message event to start with
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 1,
            rooms: { join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } } },
        });
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        const event = room.getLiveTimeline().getEvents()[0];

        // wait for a first attempt at decryption: should fail
        await testUtils.awaitDecryption(event);
        expect(event.getContent().msgtype).toEqual("m.bad.encrypted");

        // now she gets the room_key event
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 2,
            to_device: {
                events: [roomKeyEncrypted],
            },
        });
        await syncPromise(aliceClient);

        await testUtils.awaitDecryption(event, { waitOnDecryptionFailure: true });
        expect(event.isDecryptionFailure()).toBeFalsy();
        expect(event.getContent().body).toEqual("42");
    });

    it("Alice gets a second room_key message", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto.deviceList.downloadKeys = () => Promise.resolve(new Map());
            aliceClient.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, keyReceiver);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted1 = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // encrypt a message with the group session
        const messageEncrypted = encryptMegolmEvent({
            senderKey: testSenderKey,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // make a second room_key event now that we have advanced the group
        // session.
        const roomKeyEncrypted2 = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // on the first sync, send the best room key
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted1],
            },
        });
        await syncPromise(aliceClient);

        // on the second sync, send the advanced room key, along with the
        // message.  This simulates the situation where Alice has been sent a
        // later copy of the room key and is reloading the client.
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 2,
            to_device: {
                events: [roomKeyEncrypted2],
            },
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        });
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        await room.decryptCriticalEvents();
        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.getContent().body).toEqual("42");
    });

    it("prepareToEncrypt", async () => {
        const homeserverUrl = aliceClient.getHomeserverUrl();
        const keyResponder = new E2EKeyResponder(homeserverUrl);
        keyResponder.addKeyReceiver("@alice:localhost", keyReceiver);

        const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
        keyResponder.addDeviceKeys(testDeviceKeys);

        await startClientAndAwaitFirstSync();
        aliceClient.setGlobalErrorOnUnknownDevices(false);

        // tell alice she is sharing a room with bob
        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        // Alice should claim one of Bob's OTKs
        expectAliceKeyClaim(getTestKeysClaimResponse("@bob:xyz"));

        // fire off the prepare request
        const room = aliceClient.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        const p = aliceClient.prepareToEncrypt(room!);

        // we expect to get a room key message
        await expectSendRoomKey("@bob:xyz", testOlmAccount);

        // the prepare request should complete successfully.
        await p;
    });

    it("Alice sends a megolm message with GlobalErrorOnUnknownDevices=false", async () => {
        aliceClient.setGlobalErrorOnUnknownDevices(false);
        const homeserverUrl = aliceClient.getHomeserverUrl();
        const keyResponder = new E2EKeyResponder(homeserverUrl);
        keyResponder.addKeyReceiver("@alice:localhost", keyReceiver);

        const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
        keyResponder.addDeviceKeys(testDeviceKeys);

        await startClientAndAwaitFirstSync();

        // Alice shares a room with Bob
        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        // ... and claim one of Bob's OTKs ...
        expectAliceKeyClaim(getTestKeysClaimResponse("@bob:xyz"));

        // ... and send an m.room_key message
        const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount);

        // Finally, send the message, and expect to get an `m.room.encrypted` event that we can decrypt.
        await Promise.all([
            aliceClient.sendTextMessage(ROOM_ID, "test"),
            expectSendMegolmMessage(inboundGroupSessionPromise),
        ]);
    });

    it("We should start a new megolm session after forceDiscardSession", async () => {
        aliceClient.setGlobalErrorOnUnknownDevices(false);
        const homeserverUrl = aliceClient.getHomeserverUrl();
        const keyResponder = new E2EKeyResponder(homeserverUrl);
        keyResponder.addKeyReceiver("@alice:localhost", keyReceiver);

        const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
        keyResponder.addDeviceKeys(testDeviceKeys);

        await startClientAndAwaitFirstSync();

        // Alice shares a room with Bob
        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        // ... and claim one of Bob's OTKs ...
        expectAliceKeyClaim(getTestKeysClaimResponse("@bob:xyz"));

        // ... and send an m.room_key message
        const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount);

        // Send the first message, and check we can decrypt it.
        await Promise.all([
            aliceClient.sendTextMessage(ROOM_ID, "test"),
            expectSendMegolmMessage(inboundGroupSessionPromise),
        ]);

        // Finally the interesting part: discard the session.
        aliceClient.forceDiscardSession(ROOM_ID);

        // Now when we send the next message, we should get a *new* megolm session.
        const inboundGroupSessionPromise2 = expectSendRoomKey("@bob:xyz", testOlmAccount);
        const p2 = expectSendMegolmMessage(inboundGroupSessionPromise2);
        await Promise.all([aliceClient.sendTextMessage(ROOM_ID, "test2"), p2]);
    });

    oldBackendOnly("Alice sends a megolm message", async () => {
        // TODO: do something about this for the rust backend.
        //   Currently it fails because we don't respect the default GlobalErrorOnUnknownDevices and
        //   send messages to unknown devices.

        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();
        const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        // start out with the device unknown - the send should be rejected.
        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));
        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

        await aliceClient.sendTextMessage(ROOM_ID, "test").then(
            () => {
                throw new Error("sendTextMessage failed on an unknown device");
            },
            (e) => {
                expect(e.name).toEqual("UnknownDeviceError");
            },
        );

        // mark the device as known, and resend.
        aliceClient.setDeviceKnown("@bob:xyz", "DEVICE_ID");

        const room = aliceClient.getRoom(ROOM_ID)!;
        const pendingMsg = room.getPendingEvents()[0];

        const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession);

        await Promise.all([
            aliceClient.resendEvent(pendingMsg, room),
            expectSendMegolmMessage(inboundGroupSessionPromise),
        ]);
    });

    oldBackendOnly("We shouldn't attempt to send to blocked devices", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();
        await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        logger.log("Forcing alice to download our device keys");

        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));
        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

        await aliceClient.downloadKeys(["@bob:xyz"]);

        logger.log("Telling alice to block our device");
        aliceClient.setDeviceBlocked("@bob:xyz", "DEVICE_ID");

        logger.log("Telling alice to send a megolm message");
        fetchMock.putOnce({ url: new RegExp("/send/"), name: "send-event" }, { event_id: "$event_id" });
        fetchMock.putOnce({ url: new RegExp("/sendToDevice/m.room_key.withheld/"), name: "send-withheld" }, {});

        await aliceClient.sendTextMessage(ROOM_ID, "test");

        // check that the event and withheld notifications were both sent
        expect(fetchMock.done("send-event")).toBeTruthy();
        expect(fetchMock.done("send-withheld")).toBeTruthy();
    });

    describe("get|setGlobalErrorOnUnknownDevices", () => {
        it("should raise an error if crypto is disabled", () => {
            aliceClient["cryptoBackend"] = undefined;
            expect(() => aliceClient.setGlobalErrorOnUnknownDevices(true)).toThrow("encryption disabled");
            expect(() => aliceClient.getGlobalErrorOnUnknownDevices()).toThrow("encryption disabled");
        });

        oldBackendOnly("should permit sending to unknown devices", async () => {
            expect(aliceClient.getGlobalErrorOnUnknownDevices()).toBeTruthy();

            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
            const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

            syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
            await syncPromise(aliceClient);

            // start out with the device unknown - the send should be rejected.
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

            await aliceClient.sendTextMessage(ROOM_ID, "test").then(
                () => {
                    throw new Error("sendTextMessage failed on an unknown device");
                },
                (e) => {
                    expect(e.name).toEqual("UnknownDeviceError");
                },
            );

            // enable sending to unknown devices, and resend
            aliceClient.setGlobalErrorOnUnknownDevices(false);
            expect(aliceClient.getGlobalErrorOnUnknownDevices()).toBeFalsy();

            const room = aliceClient.getRoom(ROOM_ID)!;
            const pendingMsg = room.getPendingEvents()[0];

            const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession);

            await Promise.all([
                aliceClient.resendEvent(pendingMsg, room),
                expectSendMegolmMessage(inboundGroupSessionPromise),
            ]);
        });
    });

    describe("get|setGlobalBlacklistUnverifiedDevices", () => {
        it("should raise an error if crypto is disabled", () => {
            aliceClient["cryptoBackend"] = undefined;
            expect(() => aliceClient.setGlobalBlacklistUnverifiedDevices(true)).toThrow("encryption disabled");
            expect(() => aliceClient.getGlobalBlacklistUnverifiedDevices()).toThrow("encryption disabled");
        });

        oldBackendOnly("should disable sending to unverified devices", async () => {
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
            const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

            // tell alice we share a room with bob
            syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
            await syncPromise(aliceClient);

            logger.log("Forcing alice to download our device keys");
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

            await aliceClient.downloadKeys(["@bob:xyz"]);

            logger.log("Telling alice to block messages to unverified devices");
            expect(aliceClient.getGlobalBlacklistUnverifiedDevices()).toBeFalsy();
            aliceClient.setGlobalBlacklistUnverifiedDevices(true);
            expect(aliceClient.getGlobalBlacklistUnverifiedDevices()).toBeTruthy();

            logger.log("Telling alice to send a megolm message");
            fetchMock.putOnce(new RegExp("/send/"), { event_id: "$event_id" });
            fetchMock.putOnce(new RegExp("/sendToDevice/m.room_key.withheld/"), {});

            await aliceClient.sendTextMessage(ROOM_ID, "test");

            // Now, let's mark the device as verified, and check that keys are sent to it.

            logger.log("Marking the device as verified");
            // XXX: this is an integration test; we really ought to do this via the cross-signing dance
            const d = aliceClient.crypto!.deviceList.getStoredDevice("@bob:xyz", "DEVICE_ID")!;
            d.verified = DeviceInfo.DeviceVerification.VERIFIED;
            aliceClient.crypto?.deviceList.storeDevicesForUser("@bob:xyz", { DEVICE_ID: d });

            const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession);

            logger.log("Asking alice to re-send");
            await Promise.all([
                expectSendMegolmMessage(inboundGroupSessionPromise).then((decrypted) => {
                    expect(decrypted.type).toEqual("m.room.message");
                    expect(decrypted.content!.body).toEqual("test");
                }),
                aliceClient.sendTextMessage(ROOM_ID, "test"),
            ]);
        });

        it("should send a m.unverified code in toDevice messages to an unverified device when globalBlacklistUnverifiedDevices=true", async () => {
            aliceClient.getCrypto()!.globalBlacklistUnverifiedDevices = true;

            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
            await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

            // Tell alice we share a room with bob
            syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
            await syncPromise(aliceClient);

            // Force alice to download bob keys
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

            // Wait to receive the toDevice message and return bob device content
            const toDevicePromise = new Promise<ToDevicePayload>((resolve) => {
                fetchMock.putOnce(new RegExp("/sendToDevice/m.room_key.withheld/"), (url, request) => {
                    const content = JSON.parse(request.body as string);
                    resolve(content.messages["@bob:xyz"]["DEVICE_ID"]);
                    return {};
                });
            });

            // Mock endpoint of message sending
            fetchMock.put(new RegExp("/send/"), { event_id: "$event_id" });

            await aliceClient.sendTextMessage(ROOM_ID, "test");

            // Finally, check that the toDevice message has the m.unverified code
            const toDeviceContent = await toDevicePromise;
            expect(toDeviceContent.code).toBe("m.unverified");
        });
    });

    describe("Session should rotate according to encryption settings", () => {
        /**
         * Send a message to bob and get the encrypted message
         * @returns {Promise<IContent>} The encrypted message
         */
        async function sendEncryptedMessage(): Promise<IContent> {
            const [encryptedMessage] = await Promise.all([
                expectEncryptedSendMessage(),
                aliceClient.sendTextMessage(ROOM_ID, "test"),
            ]);
            return encryptedMessage;
        }

        newBackendOnly("should rotate the session after 2 messages", async () => {
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
            const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

            const syncResponse = getSyncResponse(["@bob:xyz"]);
            // Every 2 messages in the room, the session should be rotated
            syncResponse.rooms[Category.Join][ROOM_ID].state.events[0].content = {
                algorithm: "m.megolm.v1.aes-sha2",
                rotation_period_msgs: 2,
            };

            // Tell alice we share a room with bob
            syncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);

            // Force alice to download bob keys
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

            // Send a message to bob and get the encrypted message
            const [encryptedMessage] = await Promise.all([
                sendEncryptedMessage(),
                expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession),
            ]);

            // Check that the session id exists
            const sessionId = encryptedMessage.session_id;
            expect(sessionId).toBeDefined();

            // Send a second message to bob and get the current message
            const secondEncryptedMessage = await sendEncryptedMessage();

            // Check that the same session id is shared between the two messages
            const secondSessionId = secondEncryptedMessage.session_id;
            expect(secondSessionId).toBe(sessionId);

            // The session should be rotated, we are expecting the room key to be sent
            const [thirdEncryptedMessage] = await Promise.all([
                sendEncryptedMessage(),
                expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession),
            ]);

            // The session is rotated every 2 messages, we should have a new session id
            const thirdSessionId = thirdEncryptedMessage.session_id;
            expect(thirdSessionId).not.toBe(sessionId);
        });

        newBackendOnly("should rotate the session after 1h", async () => {
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
            const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

            // We need to fake the timers to advance the time, but the wasm bindings of matrix-sdk-crypto rely on a
            // working `queueMicrotask`
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            const syncResponse = getSyncResponse(["@bob:xyz"]);

            // The minimum rotation period is 1h
            // https://github.com/matrix-org/matrix-rust-sdk/blob/f75b2cd1d0981db42751dadb08c826740af1018e/crates/matrix-sdk-crypto/src/olm/group_sessions/outbound.rs#L410-L415
            const oneHourInMs = 60 * 60 * 1000;

            // Every 1h the session should be rotated
            syncResponse.rooms[Category.Join][ROOM_ID].state.events[0].content = {
                algorithm: "m.megolm.v1.aes-sha2",
                rotation_period_ms: oneHourInMs,
            };

            // Tell alice we share a room with bob
            syncResponder.sendOrQueueSyncResponse(syncResponse);
            await syncPromise(aliceClient);

            // Force alice to download bob keys
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

            // Send a message to bob and get the encrypted message
            const [encryptedMessage] = await Promise.all([
                sendEncryptedMessage(),
                expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession),
            ]);

            // Check that the session id exists
            const sessionId = encryptedMessage.session_id;
            expect(sessionId).toBeDefined();

            // Advance the time by 1h
            jest.advanceTimersByTime(oneHourInMs);

            // Send a second message to bob and get the encrypted message
            const [secondEncryptedMessage] = await Promise.all([
                sendEncryptedMessage(),
                expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession),
            ]);

            // The session should be rotated
            const secondSessionId = secondEncryptedMessage.session_id;
            expect(secondSessionId).not.toBe(sessionId);
        });
    });

    newBackendOnly("should rotate the session when the history visibility changes", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();
        const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

        // Tell alice we share a room with bob
        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        // Force alice to download bob keys
        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

        // Send a message to bob and get the current session id
        let [, , encryptedMessage] = await Promise.all([
            aliceClient.sendTextMessage(ROOM_ID, "test"),
            expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession),
            expectEncryptedSendMessage(),
        ]);

        // Check that the session id exists
        const sessionId = encryptedMessage.session_id;
        expect(sessionId).toBeDefined();

        // Change history visibility in sync response
        const syncResponse = getSyncResponse([]);
        syncResponse.rooms[Category.Join][ROOM_ID].timeline.events.push(
            mkEventCustom({
                sender: TEST_USER_ID,
                type: "m.room.history_visibility",
                state_key: "",
                content: {
                    history_visibility: HistoryVisibility.Invited,
                },
            }),
        );

        // Update the new visibility
        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        // Resend a message to bob and get the new session id
        [, , encryptedMessage] = await Promise.all([
            aliceClient.sendTextMessage(ROOM_ID, "test"),
            expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession),
            expectEncryptedSendMessage(),
        ]);

        // Check that the new session id exists
        const newSessionId = encryptedMessage.session_id;
        expect(newSessionId).toBeDefined();

        // Check that the session id has changed
        expect(sessionId).not.toEqual(newSessionId);
    });

    oldBackendOnly("We should start a new megolm session when a device is blocked", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();
        const p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        logger.log("Fetching bob's devices and marking known");

        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));
        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

        await aliceClient.downloadKeys(["@bob:xyz"]);
        await aliceClient.setDeviceKnown("@bob:xyz", "DEVICE_ID");

        logger.log("Telling alice to send a megolm message");

        let megolmSessionId: string;
        const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession);
        inboundGroupSessionPromise.then((igs) => {
            megolmSessionId = igs.session_id();
        });

        await Promise.all([
            aliceClient.sendTextMessage(ROOM_ID, "test"),
            expectSendMegolmMessage(inboundGroupSessionPromise),
        ]);

        logger.log("Telling alice to block our device");
        aliceClient.setDeviceBlocked("@bob:xyz", "DEVICE_ID");

        logger.log("Telling alice to send another megolm message");

        fetchMock.putOnce(
            { url: new RegExp("/send/"), name: "send-event" },
            (url: string, opts: RequestInit): FetchMock.MockResponse => {
                const content = JSON.parse(opts.body as string);
                logger.log("/send:", content);
                // make sure that a new session is used
                expect(content.session_id).not.toEqual(megolmSessionId);
                return {
                    event_id: "$event_id",
                };
            },
        );
        fetchMock.putOnce({ url: new RegExp("/sendToDevice/m.room_key.withheld/"), name: "send-withheld" }, {});

        await aliceClient.sendTextMessage(ROOM_ID, "test2");

        // check that the event and withheld notifications were both sent
        expect(fetchMock.done("send-event")).toBeTruthy();
        expect(fetchMock.done("send-withheld")).toBeTruthy();
    });

    // https://github.com/vector-im/element-web/issues/2676
    oldBackendOnly("Alice should send to her other devices", async () => {
        // for this test, we make the testOlmAccount be another of Alice's devices.
        // it ought to get included in messages Alice sends.
        expectAliceKeyQuery(getTestKeysQueryResponse(aliceClient.getUserId()!));

        await startClientAndAwaitFirstSync();
        // an encrypted room with just alice
        const syncResponse = {
            next_batch: 1,
            rooms: {
                join: {
                    [ROOM_ID]: {
                        state: {
                            events: [
                                testUtils.mkEvent({
                                    type: "m.room.encryption",
                                    skey: "",
                                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                                }),
                                testUtils.mkMembership({
                                    mship: KnownMembership.Join,
                                    sender: aliceClient.getUserId()!,
                                }),
                            ],
                        },
                    },
                },
            },
        };
        syncResponder.sendOrQueueSyncResponse(syncResponse);

        await syncPromise(aliceClient);

        // start out with the device unknown - the send should be rejected.
        try {
            await aliceClient.sendTextMessage(ROOM_ID, "test");
            throw new Error("sendTextMessage succeeded on an unknown device");
        } catch (e) {
            expect((e as any).name).toEqual("UnknownDeviceError");
            expect([...(e as any).devices.keys()]).toEqual([aliceClient.getUserId()!]);
            expect((e as any).devices.get(aliceClient.getUserId()!).has("DEVICE_ID")).toBeTruthy();
        }

        // mark the device as known, and resend.
        aliceClient.setDeviceKnown(aliceClient.getUserId()!, "DEVICE_ID");
        expectAliceKeyClaim((url: string, opts: RequestInit): FetchMock.MockResponse => {
            const content = JSON.parse(opts.body as string);
            expect(content.one_time_keys[aliceClient.getUserId()!].DEVICE_ID).toEqual("signed_curve25519");
            return getTestKeysClaimResponse(aliceClient.getUserId()!);
        });

        const inboundGroupSessionPromise = expectSendRoomKey(aliceClient.getUserId()!, testOlmAccount);

        let decrypted: Partial<IEvent> = {};

        // Grab the event that we'll need to resend
        const room = aliceClient.getRoom(ROOM_ID)!;
        const pendingEvents = room.getPendingEvents();
        expect(pendingEvents.length).toEqual(1);
        const unsentEvent = pendingEvents[0];

        await Promise.all([
            expectSendMegolmMessage(inboundGroupSessionPromise).then((d) => {
                decrypted = d;
            }),
            aliceClient.resendEvent(unsentEvent, room),
        ]);

        expect(decrypted.type).toEqual("m.room.message");
        expect(decrypted.content?.body).toEqual("test");
    });

    oldBackendOnly("Alice should wait for device list to complete when sending a megolm message", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();
        await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);

        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
        await syncPromise(aliceClient);

        // this will block
        logger.log("Forcing alice to download our device keys");
        const downloadPromise = aliceClient.downloadKeys(["@bob:xyz"]);

        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

        // so will this.
        const sendPromise = aliceClient.sendTextMessage(ROOM_ID, "test").then(
            () => {
                throw new Error("sendTextMessage failed on an unknown device");
            },
            (e) => {
                expect(e.name).toEqual("UnknownDeviceError");
            },
        );

        expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

        await Promise.all([downloadPromise, sendPromise]);
    });

    oldBackendOnly("Alice exports megolm keys and imports them to a new device", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto.deviceList.downloadKeys = () => Promise.resolve(new Map());
            aliceClient.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, keyReceiver);

        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // encrypt a message with the group session
        const messageEncrypted = encryptMegolmEvent({
            senderKey: testSenderKey,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // Alice gets both the events in a single sync
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted],
            },
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        });
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        await room.decryptCriticalEvents();

        // it probably won't be decrypted yet, because it takes a while to process the olm keys
        const decryptedEvent = await testUtils.awaitDecryption(room.getLiveTimeline().getEvents()[0], {
            waitOnDecryptionFailure: true,
        });
        expect(decryptedEvent.getContent().body).toEqual("42");

        const exported = await aliceClient.getCrypto()!.exportRoomKeysAsJson();

        // start a new client
        await aliceClient.stopClient();

        const homeserverUrl = "https://alice-server2.com";
        aliceClient = createClient({
            baseUrl: homeserverUrl,
            userId: "@alice:localhost",
            accessToken: "akjgkrgjs",
            deviceId: "xzcvb",
        });

        keyReceiver = new E2EKeyReceiver(homeserverUrl);
        syncResponder = new SyncResponder(homeserverUrl);
        await initCrypto(aliceClient);
        await aliceClient.getCrypto()!.importRoomKeysAsJson(exported);
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        aliceClient.startClient();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const syncResponse = {
            next_batch: 1,
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        };

        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.getContent().body).toEqual("42");
    });

    it("Alice receives an untrusted megolm key, only to receive the trusted one shortly after", async () => {
        const testClient = new TestClient("@alice:localhost", "device2", "access_token2");
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();
        const inboundGroupSession = new Olm.InboundGroupSession();
        inboundGroupSession.create(groupSession.session_key());
        const rawEvent = encryptMegolmEvent({
            senderKey: testSenderKey,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });
        await testClient.client.initCrypto();
        const keys = [
            {
                room_id: ROOM_ID,
                algorithm: "m.megolm.v1.aes-sha2",
                session_id: groupSession.session_id(),
                session_key: inboundGroupSession.export_session(0),
                sender_key: testSenderKey,
                forwarding_curve25519_key_chain: [],
                sender_claimed_keys: {},
            },
        ];
        await testClient.client.importRoomKeys(keys, { untrusted: true });

        const event1 = testUtils.mkEvent({
            event: true,
            ...rawEvent,
            room: ROOM_ID,
        });
        await event1.attemptDecryption(testClient.client.crypto!, { isRetry: true });
        expect(event1.isKeySourceUntrusted()).toBeTruthy();

        const event2 = testUtils.mkEvent({
            type: "m.room_key",
            content: {
                room_id: ROOM_ID,
                algorithm: "m.megolm.v1.aes-sha2",
                session_id: groupSession.session_id(),
                session_key: groupSession.session_key(),
            },
            event: true,
        });
        // @ts-ignore - private
        event2.senderCurve25519Key = testSenderKey;
        // @ts-ignore - private
        testClient.client.crypto!.onRoomKeyEvent(event2);

        const event3 = testUtils.mkEvent({
            event: true,
            ...rawEvent,
            room: ROOM_ID,
        });
        await event3.attemptDecryption(testClient.client.crypto!, { isRetry: true });
        expect(event3.isKeySourceUntrusted()).toBeFalsy();
        testClient.stop();
    });

    it("Alice can decrypt a message with falsey content", async () => {
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto.deviceList.downloadKeys = () => Promise.resolve(new Map());
            aliceClient.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, keyReceiver);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        const plaintext = {
            type: "m.room.message",
            content: undefined,
            room_id: ROOM_ID,
        };

        const messageEncrypted = encryptMegolmEventRawPlainText({
            senderKey: testSenderKey,
            groupSession: groupSession,
            plaintext: plaintext,
        });

        // Alice gets both the events in a single sync
        const syncResponse = {
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted],
            },
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        };

        syncResponder.sendOrQueueSyncResponse(syncResponse);
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.isEncrypted()).toBe(true);

        // it probably won't be decrypted yet, because it takes a while to process the olm keys
        const decryptedEvent = await testUtils.awaitDecryption(event, { waitOnDecryptionFailure: true });
        expect(decryptedEvent.getRoomId()).toEqual(ROOM_ID);
        expect(decryptedEvent.getContent()).toEqual({});
        expect(decryptedEvent.getClearContent()).toBeUndefined();
    });

    oldBackendOnly("Alice receives shared history before being invited to a room by the sharer", async () => {
        const beccaTestClient = new TestClient("@becca:localhost", "foobar", "bazquux");
        await beccaTestClient.client.initCrypto();

        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();
        await beccaTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceClient.crypto) {
            aliceClient.crypto!.deviceList.downloadKeys = () => Promise.resolve(new Map());
            aliceClient.crypto!.deviceList.getDeviceByIdentityKey = () => device;
            aliceClient.crypto!.deviceList.getUserByIdentityKey = () => beccaTestClient.client.getUserId()!;
        }

        const beccaRoom = new Room(ROOM_ID, beccaTestClient.client, "@becca:localhost", {});
        beccaTestClient.client.store.storeRoom(beccaRoom);
        await beccaTestClient.client.setRoomEncryption(ROOM_ID, { algorithm: "m.megolm.v1.aes-sha2" });

        const event = new MatrixEvent({
            type: "m.room.message",
            sender: "@becca:localhost",
            room_id: ROOM_ID,
            event_id: "$1",
            content: {
                msgtype: "m.text",
                body: "test message",
            },
        });

        await beccaTestClient.client.crypto!.encryptEvent(event, beccaRoom);
        // remove keys from the event
        // @ts-ignore private properties
        event.clearEvent = undefined;
        // @ts-ignore private properties
        event.senderCurve25519Key = null;
        // @ts-ignore private properties
        event.claimedEd25519Key = null;

        const device = new DeviceInfo(beccaTestClient.client.deviceId!);

        // Create an olm session for Becca and Alice's devices
        const aliceOtks = await keyReceiver.awaitOneTimeKeyUpload();
        const aliceOtkId = Object.keys(aliceOtks)[0];
        const aliceOtk = aliceOtks[aliceOtkId];
        const p2pSession = new global.Olm.Session();
        await beccaTestClient.client.crypto!.cryptoStore.doTxn(
            "readonly",
            [IndexedDBCryptoStore.STORE_ACCOUNT],
            (txn) => {
                beccaTestClient.client.crypto!.cryptoStore.getAccount(txn, (pickledAccount: string | null) => {
                    const account = new global.Olm.Account();
                    try {
                        account.unpickle(beccaTestClient.client.crypto!.olmDevice.pickleKey, pickledAccount!);
                        p2pSession.create_outbound(account, keyReceiver.getDeviceKey(), aliceOtk.key);
                    } finally {
                        account.free();
                    }
                });
            },
        );

        const content = event.getWireContent();
        const groupSessionKey = await beccaTestClient.client.crypto!.olmDevice.getInboundGroupSessionKey(
            ROOM_ID,
            content.sender_key,
            content.session_id,
        );
        const encryptedForwardedKey = encryptOlmEvent({
            sender: "@becca:localhost",
            senderSigningKey: beccaTestClient.getSigningKey(),
            senderKey: beccaTestClient.getDeviceKey(),
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            p2pSession: p2pSession,
            plaincontent: {
                "algorithm": "m.megolm.v1.aes-sha2",
                "room_id": ROOM_ID,
                "sender_key": content.sender_key,
                "sender_claimed_ed25519_key": groupSessionKey!.sender_claimed_ed25519_key,
                "session_id": content.session_id,
                "session_key": groupSessionKey!.key,
                "chain_index": groupSessionKey!.chain_index,
                "forwarding_curve25519_key_chain": groupSessionKey!.forwarding_curve25519_key_chain,
                "org.matrix.msc3061.shared_history": true,
            },
            plaintype: "m.forwarded_room_key",
        });

        // Alice receives shared history
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 1,
            to_device: { events: [encryptedForwardedKey] },
        });
        await syncPromise(aliceClient);

        // Alice is invited to the room by Becca
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 2,
            rooms: {
                invite: {
                    [ROOM_ID]: {
                        invite_state: {
                            events: [
                                {
                                    sender: "@becca:localhost",
                                    type: "m.room.encryption",
                                    state_key: "",
                                    content: {
                                        algorithm: "m.megolm.v1.aes-sha2",
                                    },
                                },
                                {
                                    sender: "@becca:localhost",
                                    type: "m.room.member",
                                    state_key: "@alice:localhost",
                                    content: {
                                        membership: KnownMembership.Invite,
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        });
        await syncPromise(aliceClient);

        // Alice has joined the room
        expectAliceKeyQuery({ device_keys: { "@becca:localhost": {} }, failures: {} });
        syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@alice:localhost", "@becca:localhost"]));
        await syncPromise(aliceClient);

        syncResponder.sendOrQueueSyncResponse({
            next_batch: 4,
            rooms: {
                join: {
                    [ROOM_ID]: { timeline: { events: [event.event] } },
                },
            },
        });
        await syncPromise(aliceClient);

        const room = aliceClient.getRoom(ROOM_ID)!;
        const roomEvent = room.getLiveTimeline().getEvents()[0];
        expect(roomEvent.isEncrypted()).toBe(true);
        const decryptedEvent = await testUtils.awaitDecryption(roomEvent);
        expect(decryptedEvent.getContent().body).toEqual("test message");

        await beccaTestClient.stop();
    });

    oldBackendOnly("Alice receives shared history before being invited to a room by someone else", async () => {
        const beccaTestClient = new TestClient("@becca:localhost", "foobar", "bazquux");
        await beccaTestClient.client.initCrypto();

        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        await beccaTestClient.start();

        const beccaRoom = new Room(ROOM_ID, beccaTestClient.client, "@becca:localhost", {});
        beccaTestClient.client.store.storeRoom(beccaRoom);
        await beccaTestClient.client.setRoomEncryption(ROOM_ID, { algorithm: "m.megolm.v1.aes-sha2" });

        const event = new MatrixEvent({
            type: "m.room.message",
            sender: "@becca:localhost",
            room_id: ROOM_ID,
            event_id: "$1",
            content: {
                msgtype: "m.text",
                body: "test message",
            },
        });

        await beccaTestClient.client.crypto!.encryptEvent(event, beccaRoom);
        // remove keys from the event
        // @ts-ignore private properties
        event.clearEvent = undefined;
        // @ts-ignore private properties
        event.senderCurve25519Key = null;
        // @ts-ignore private properties
        event.claimedEd25519Key = null;

        const device = new DeviceInfo(beccaTestClient.client.deviceId!);
        aliceClient.crypto!.deviceList.getDeviceByIdentityKey = () => device;

        // Create an olm session for Becca and Alice's devices
        const aliceOtks = await keyReceiver.awaitOneTimeKeyUpload();
        const aliceOtkId = Object.keys(aliceOtks)[0];
        const aliceOtk = aliceOtks[aliceOtkId];
        const p2pSession = new global.Olm.Session();
        await beccaTestClient.client.crypto!.cryptoStore.doTxn(
            "readonly",
            [IndexedDBCryptoStore.STORE_ACCOUNT],
            (txn) => {
                beccaTestClient.client.crypto!.cryptoStore.getAccount(txn, (pickledAccount: string | null) => {
                    const account = new global.Olm.Account();
                    try {
                        account.unpickle(beccaTestClient.client.crypto!.olmDevice.pickleKey, pickledAccount!);
                        p2pSession.create_outbound(account, keyReceiver.getDeviceKey(), aliceOtk.key);
                    } finally {
                        account.free();
                    }
                });
            },
        );

        const content = event.getWireContent();
        const groupSessionKey = await beccaTestClient.client.crypto!.olmDevice.getInboundGroupSessionKey(
            ROOM_ID,
            content.sender_key,
            content.session_id,
        );
        const encryptedForwardedKey = encryptOlmEvent({
            sender: "@becca:localhost",
            senderKey: beccaTestClient.getDeviceKey(),
            senderSigningKey: beccaTestClient.getSigningKey(),
            recipient: aliceClient.getUserId()!,
            recipientCurve25519Key: keyReceiver.getDeviceKey(),
            recipientEd25519Key: keyReceiver.getSigningKey(),
            p2pSession: p2pSession,
            plaincontent: {
                "algorithm": "m.megolm.v1.aes-sha2",
                "room_id": ROOM_ID,
                "sender_key": content.sender_key,
                "sender_claimed_ed25519_key": groupSessionKey!.sender_claimed_ed25519_key,
                "session_id": content.session_id,
                "session_key": groupSessionKey!.key,
                "chain_index": groupSessionKey!.chain_index,
                "forwarding_curve25519_key_chain": groupSessionKey!.forwarding_curve25519_key_chain,
                "org.matrix.msc3061.shared_history": true,
            },
            plaintype: "m.forwarded_room_key",
        });

        // Alice receives forwarded history from Becca
        expectAliceKeyQuery({ device_keys: { "@becca:localhost": {} }, failures: {} });
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 1,
            to_device: { events: [encryptedForwardedKey] },
        });
        await syncPromise(aliceClient);

        // Alice is invited to the room by Charlie
        syncResponder.sendOrQueueSyncResponse({
            next_batch: 2,
            rooms: {
                invite: {
                    [ROOM_ID]: {
                        invite_state: {
                            events: [
                                {
                                    sender: "@becca:localhost",
                                    type: "m.room.encryption",
                                    state_key: "",
                                    content: {
                                        algorithm: "m.megolm.v1.aes-sha2",
                                    },
                                },
                                {
                                    sender: "@charlie:localhost",
                                    type: "m.room.member",
                                    state_key: "@alice:localhost",
                                    content: {
                                        membership: KnownMembership.Invite,
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        });
        await syncPromise(aliceClient);

        // Alice has joined the room
        expectAliceKeyQuery({ device_keys: { "@becca:localhost": {}, "@charlie:localhost": {} }, failures: {} });
        syncResponder.sendOrQueueSyncResponse(
            getSyncResponse(["@alice:localhost", "@becca:localhost", "@charlie:localhost"]),
        );
        await syncPromise(aliceClient);

        // wait for the key/device downloads for becca and charlie to complete
        await aliceClient.downloadKeys(["@becca:localhost", "@charlie:localhost"]);

        syncResponder.sendOrQueueSyncResponse({
            next_batch: 4,
            rooms: {
                join: {
                    [ROOM_ID]: { timeline: { events: [event.event] } },
                },
            },
        });
        await syncPromise(aliceClient);

        // Decryption should fail, because Alice hasn't received any keys she can trust
        const room = aliceClient.getRoom(ROOM_ID)!;
        const roomEvent = room.getLiveTimeline().getEvents()[0];
        expect(roomEvent.isEncrypted()).toBe(true);
        const decryptedEvent = await testUtils.awaitDecryption(roomEvent);
        expect(decryptedEvent.isDecryptionFailure()).toBe(true);

        await beccaTestClient.stop();
    });

    oldBackendOnly("allows sending an encrypted event as soon as room state arrives", async () => {
        /* Empirically, clients expect to be able to send encrypted events as soon as the
         * RoomStateEvent.NewMember notification is emitted, so test that works correctly.
         */
        const testRoomId = "!testRoom:id";
        expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await startClientAndAwaitFirstSync();

        /* Alice makes the /createRoom call */
        fetchMock.postOnce(new RegExp("/createRoom"), { room_id: testRoomId });
        await aliceClient.createRoom({
            initial_state: [
                {
                    type: "m.room.encryption",
                    state_key: "",
                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                },
            ],
        });

        /* The sync arrives in two parts; first the m.room.create... */
        syncResponder.sendOrQueueSyncResponse({
            rooms: {
                join: {
                    [testRoomId]: {
                        timeline: {
                            events: [
                                {
                                    type: "m.room.create",
                                    state_key: "",
                                    event_id: "$create",
                                },
                                {
                                    type: "m.room.member",
                                    state_key: aliceClient.getUserId(),
                                    content: { membership: KnownMembership.Join },
                                    event_id: "$alijoin",
                                },
                            ],
                        },
                    },
                },
            },
        });
        await syncPromise(aliceClient);

        // ... and then the e2e event and an invite ...
        syncResponder.sendOrQueueSyncResponse({
            rooms: {
                join: {
                    [testRoomId]: {
                        timeline: {
                            events: [
                                {
                                    type: "m.room.encryption",
                                    state_key: "",
                                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                                    event_id: "$e2e",
                                },
                                {
                                    type: "m.room.member",
                                    state_key: "@other:user",
                                    content: { membership: KnownMembership.Invite },
                                    event_id: "$otherinvite",
                                },
                            ],
                        },
                    },
                },
            },
        });

        // as soon as the roomMember arrives, try to send a message
        expectAliceKeyQuery({ device_keys: { "@other:user": {} }, failures: {} });
        aliceClient.on(RoomStateEvent.NewMember, (_e, _s, member: RoomMember) => {
            if (member.userId == "@other:user") {
                aliceClient.sendMessage(testRoomId, { msgtype: MsgType.Text, body: "Hello, World" });
            }
        });

        // flush the sync and wait for the /send/ request.
        const sendEventPromise = new Promise((resolve) => {
            fetchMock.putOnce(new RegExp("/send/m.room.encrypted/"), () => {
                resolve(undefined);
                return { event_id: "asdfgh" };
            });
        });
        await syncPromise(aliceClient);
        await sendEventPromise;
    });

    describe("getEncryptionInfoForEvent", () => {
        it("handles outgoing events", async () => {
            aliceClient.setGlobalErrorOnUnknownDevices(false);
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();

            // Alice shares a room with Bob
            syncResponder.sendOrQueueSyncResponse(getSyncResponse(["@bob:xyz"]));
            await syncPromise(aliceClient);

            // Once we send the message, Alice will check Bob's device list (twice, because reasons) ...
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));
            expectAliceKeyQuery(getTestKeysQueryResponse("@bob:xyz"));

            // ... and claim one of his OTKs ...
            expectAliceKeyClaim(getTestKeysClaimResponse("@bob:xyz"));

            // ... and send an m.room_key message ...
            const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount);

            // ... and finally, send the room key. We block the response until `sendRoomMessageDefer` completes.
            const sendRoomMessageDefer = defer<FetchMock.MockResponse>();
            const reqProm = new Promise<IContent>((resolve) => {
                fetchMock.putOnce(
                    new RegExp("/send/m.room.encrypted/"),
                    async (url: string, opts: RequestInit): Promise<FetchMock.MockResponse> => {
                        resolve(JSON.parse(opts.body as string));
                        return await sendRoomMessageDefer.promise;
                    },
                    {
                        // append to the list of intercepts on this path (since we have some tests that call
                        // this function multiple times)
                        overwriteRoutes: false,
                    },
                );
            });

            // Now we start to send the message
            const sendProm = aliceClient.sendTextMessage(testData.TEST_ROOM_ID, "test");

            // and wait for the outgoing requests
            const inboundGroupSession = await inboundGroupSessionPromise;
            const encryptedMessageContent = await reqProm;
            const msg: any = inboundGroupSession.decrypt(encryptedMessageContent!.ciphertext);
            logger.log("Decrypted received megolm message", msg);

            // at this point, the request to send the room message has been made, but not completed.
            // get hold of the pending event, and see what getEncryptionInfoForEvent makes of it
            const pending = aliceClient.getRoom(testData.TEST_ROOM_ID)!.getPendingEvents();
            expect(pending.length).toEqual(1);
            const encInfo = await aliceClient.getCrypto()!.getEncryptionInfoForEvent(pending[0]);
            expect(encInfo!.shieldColour).toEqual(EventShieldColour.NONE);
            expect(encInfo!.shieldReason).toBeNull();

            // release the send request
            const resp = { event_id: "$event_id" };
            sendRoomMessageDefer.resolve(resp);
            expect(await sendProm).toEqual(resp);

            // still pending at this point
            expect(aliceClient.getRoom(testData.TEST_ROOM_ID)!.getPendingEvents().length).toEqual(1);

            // echo the event back
            const fullEvent = {
                event_id: "$event_id",
                type: "m.room.encrypted",
                sender: aliceClient.getUserId(),
                origin_server_ts: Date.now(),
                content: encryptedMessageContent,
            };
            syncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                rooms: { join: { [testData.TEST_ROOM_ID]: { timeline: { events: [fullEvent] } } } },
            });
            await syncPromise(aliceClient);

            const timelineEvents = aliceClient.getRoom(testData.TEST_ROOM_ID)!.getLiveTimeline()!.getEvents();
            const lastEvent = timelineEvents[timelineEvents.length - 1];
            expect(lastEvent.getId()).toEqual("$event_id");

            // now check getEncryptionInfoForEvent again
            const encInfo2 = await aliceClient.getCrypto()!.getEncryptionInfoForEvent(lastEvent);
            let expectedEncryptionInfo;
            if (backend === "rust-sdk") {
                // rust crypto does not trust its own device until it is cross-signed.
                expectedEncryptionInfo = {
                    shieldColour: EventShieldColour.RED,
                    shieldReason: EventShieldReason.UNSIGNED_DEVICE,
                };
            } else {
                expectedEncryptionInfo = {
                    shieldColour: EventShieldColour.NONE,
                    shieldReason: null,
                };
            }
            expect(encInfo2).toEqual(expectedEncryptionInfo);
        });
    });

    describe("Lazy-loading member lists", () => {
        let p2pSession: Olm.Session;

        beforeEach(async () => {
            // set up the aliceTestClient so that it is a room with no known members
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync({ lazyLoadMembers: true });
            aliceClient.setGlobalErrorOnUnknownDevices(false);

            syncResponder.sendOrQueueSyncResponse(getSyncResponse([]));
            await syncPromise(aliceClient);

            p2pSession = await establishOlmSession(aliceClient, keyReceiver, syncResponder, testOlmAccount);
        });

        async function expectMembershipRequest(roomId: string, members: string[]): Promise<void> {
            const membersPath = `/rooms/${encodeURIComponent(roomId)}/members\\?not_membership=leave`;
            fetchMock.getOnce(new RegExp(membersPath), {
                chunk: [
                    testUtils.mkMembershipCustom({
                        membership: KnownMembership.Join,
                        sender: "@bob:xyz",
                    }),
                ],
            });
        }

        it("Sending an event initiates a member list sync", async () => {
            const homeserverUrl = aliceClient.getHomeserverUrl();
            const keyResponder = new E2EKeyResponder(homeserverUrl);
            keyResponder.addKeyReceiver("@alice:localhost", keyReceiver);

            const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
            keyResponder.addDeviceKeys(testDeviceKeys);

            // we expect a call to the /members list...
            const memberListPromise = expectMembershipRequest(ROOM_ID, ["@bob:xyz"]);

            // then a to-device with the room_key
            const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession);

            // and finally the megolm message
            const megolmMessagePromise = expectSendMegolmMessage(inboundGroupSessionPromise);

            // kick it off
            const sendPromise = aliceClient.sendTextMessage(ROOM_ID, "test");

            await Promise.all([sendPromise, megolmMessagePromise, memberListPromise]);
        });

        it("loading the membership list inhibits a later load", async () => {
            const homeserverUrl = aliceClient.getHomeserverUrl();
            const keyResponder = new E2EKeyResponder(homeserverUrl);
            keyResponder.addKeyReceiver("@alice:localhost", keyReceiver);

            const testDeviceKeys = getTestOlmAccountKeys(testOlmAccount, "@bob:xyz", "DEVICE_ID");
            keyResponder.addDeviceKeys(testDeviceKeys);

            const room = aliceClient.getRoom(ROOM_ID)!;
            await Promise.all([room.loadMembersIfNeeded(), expectMembershipRequest(ROOM_ID, ["@bob:xyz"])]);

            // then a to-device with the room_key
            const inboundGroupSessionPromise = expectSendRoomKey("@bob:xyz", testOlmAccount, p2pSession);

            // and finally the megolm message
            const megolmMessagePromise = expectSendMegolmMessage(inboundGroupSessionPromise);

            // kick it off
            const sendPromise = aliceClient.sendTextMessage(ROOM_ID, "test");

            await Promise.all([sendPromise, megolmMessagePromise]);
        });
    });

    describe("m.room_key.withheld handling", () => {
        describe.each([
            ["m.blacklisted", "The sender has blocked you.", DecryptionFailureCode.MEGOLM_KEY_WITHHELD],
            [
                "m.unverified",
                "The sender has disabled encrypting to unverified devices.",
                DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
            ],
        ])(
            "Decryption fails with withheld error if a withheld notice with code '%s' is received",
            (withheldCode, expectedMessage, expectedErrorCode) => {
                it.each(["before", "after"])("%s the event", async (when) => {
                    expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
                    await startClientAndAwaitFirstSync();

                    // A promise which resolves, with the MatrixEvent which wraps the event, once the decryption fails.
                    let awaitDecryption = emitPromise(aliceClient, MatrixEventEvent.Decrypted);

                    // Send Alice an encrypted room event which looks like it was encrypted with a megolm session
                    async function sendEncryptedEvent() {
                        const event = {
                            ...testData.ENCRYPTED_EVENT,
                            origin_server_ts: Date.now(),
                        };
                        const syncResponse = {
                            next_batch: 1,
                            rooms: { join: { [ROOM_ID]: { timeline: { events: [event] } } } },
                        };

                        syncResponder.sendOrQueueSyncResponse(syncResponse);
                        await syncPromise(aliceClient);
                    }

                    // Send Alice a withheld notice
                    async function sendWithheldMessage() {
                        const withheldMessage = {
                            type: "m.room_key.withheld",
                            sender: "@bob:example.com",
                            content: {
                                algorithm: "m.megolm.v1.aes-sha2",
                                room_id: ROOM_ID,
                                sender_key: testData.ENCRYPTED_EVENT.content!.sender_key,
                                session_id: testData.ENCRYPTED_EVENT.content!.session_id,
                                code: withheldCode,
                                reason: "zzz",
                            },
                        };

                        syncResponder.sendOrQueueSyncResponse({
                            next_batch: 1,
                            to_device: { events: [withheldMessage] },
                        });
                        await syncPromise(aliceClient);
                    }

                    if (when === "before") {
                        await sendWithheldMessage();
                        await sendEncryptedEvent();
                    } else {
                        await sendEncryptedEvent();
                        // Make sure that the first attempt to decrypt has happened before the withheld arrives
                        await awaitDecryption;
                        awaitDecryption = emitPromise(aliceClient, MatrixEventEvent.Decrypted);
                        await sendWithheldMessage();
                    }

                    const ev = await awaitDecryption;
                    expect(ev.getContent()).toEqual({
                        body: `** Unable to decrypt: DecryptionError: ${expectedMessage} **`,
                        msgtype: "m.bad.encrypted",
                    });

                    expect(ev.decryptionFailureReason).toEqual(expectedErrorCode);

                    // `isEncryptedDisabledForUnverifiedDevices` should be true for `m.unverified` and false for other errors.
                    expect(ev.isEncryptedDisabledForUnverifiedDevices).toEqual(withheldCode === "m.unverified");
                });
            },
        );

        oldBackendOnly("does not block decryption on an 'm.unavailable' report", async function () {
            // there may be a key downloads for alice
            expectAliceKeyQuery({ device_keys: {}, failures: {} });

            await startClientAndAwaitFirstSync();

            // encrypt a message with a group session.
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();
            const messageEncryptedEvent = encryptMegolmEvent({
                senderKey: testSenderKey,
                groupSession: groupSession,
                room_id: ROOM_ID,
            });

            // Alice gets the room message, but not the key
            syncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                rooms: {
                    join: { [ROOM_ID]: { timeline: { events: [messageEncryptedEvent] } } },
                },
            });
            await syncPromise(aliceClient);

            // alice will (eventually) send a room-key request
            fetchMock.putOnce(new RegExp("/sendToDevice/m.room_key_request/"), {});

            // at this point, the message should be a decryption failure
            const room = aliceClient.getRoom(ROOM_ID)!;
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.isDecryptionFailure()).toBeTruthy();

            // we want to wait for the message to be updated, so create a promise for it
            const retryPromise = new Promise((resolve) => {
                event.once(MatrixEventEvent.Decrypted, (ev) => {
                    resolve(ev);
                });
            });

            // alice gets back a room-key-withheld notification
            syncResponder.sendOrQueueSyncResponse({
                next_batch: 2,
                to_device: {
                    events: [
                        {
                            type: "m.room_key.withheld",
                            sender: "@bob:example.com",
                            content: {
                                algorithm: "m.megolm.v1.aes-sha2",
                                room_id: ROOM_ID,
                                session_id: groupSession.session_id(),
                                sender_key: testSenderKey,
                                code: "m.unavailable",
                                reason: "",
                            },
                        },
                    ],
                },
            });
            await syncPromise(aliceClient);

            // the withheld notification should trigger a retry; wait for it
            await retryPromise;

            // finally: the message should still be a regular decryption failure, not a withheld notification.
            expect(event.getContent().body).not.toContain("withheld");
        });
    });

    describe("key upload request", () => {
        beforeEach(() => {
            // We want to use fake timers, but the wasm bindings of matrix-sdk-crypto rely on a working `queueMicrotask`.
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
        });

        function awaitKeyUploadRequest(): Promise<{ keysCount: number; fallbackKeysCount: number }> {
            return new Promise((resolve) => {
                const listener = (url: string, options: RequestInit) => {
                    const content = JSON.parse(options.body as string);
                    const keysCount = Object.keys(content?.one_time_keys || {}).length;
                    const fallbackKeysCount = Object.keys(content?.fallback_keys || {}).length;
                    if (keysCount) resolve({ keysCount, fallbackKeysCount });
                    return {
                        one_time_key_counts: {
                            // The matrix client does `/upload` requests until 50 keys are uploaded
                            // We return here 60 to avoid the `/upload` request loop
                            signed_curve25519: keysCount ? 60 : keysCount,
                        },
                    };
                };

                for (const path of ["/_matrix/client/v3/keys/upload", "/_matrix/client/v3/keys/upload"]) {
                    fetchMock.post(new URL(path, aliceClient.getHomeserverUrl()).toString(), listener, {
                        // These routes are already defined in the E2EKeyReceiver
                        // We want to overwrite the behaviour of the E2EKeyReceiver
                        overwriteRoutes: true,
                    });
                }
            });
        }

        it("should make key upload request after sync", async () => {
            let uploadPromise = awaitKeyUploadRequest();
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();

            syncResponder.sendOrQueueSyncResponse(getSyncResponse([]));

            await syncPromise(aliceClient);

            // Verify that `/upload` is called on Alice's homesever
            const { keysCount, fallbackKeysCount } = await uploadPromise;
            expect(keysCount).toBeGreaterThan(0);
            expect(fallbackKeysCount).toBe(0);

            uploadPromise = awaitKeyUploadRequest();
            syncResponder.sendOrQueueSyncResponse({
                next_batch: 2,
                device_one_time_keys_count: { signed_curve25519: 0 },
                device_unused_fallback_key_types: [],
            });

            // Advance local date to 2 minutes
            // The old crypto only runs the upload every 60 seconds
            jest.setSystemTime(Date.now() + 2 * 60 * 1000);

            await syncPromise(aliceClient);

            // After we set device_one_time_keys_count to 0
            // a `/upload` is expected
            const res = await uploadPromise;
            expect(res.keysCount).toBeGreaterThan(0);
            expect(res.fallbackKeysCount).toBeGreaterThan(0);
        });
    });

    describe("getUserDeviceInfo", () => {
        // From https://spec.matrix.org/v1.6/client-server-api/#post_matrixclientv3keysquery
        // Using extracted response from matrix.org, it needs to have real keys etc to pass old crypto verification
        const queryResponseBody = {
            device_keys: {
                "@testing_florian1:matrix.org": {
                    EBMMPAFOPU: {
                        algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                        device_id: "EBMMPAFOPU",
                        keys: {
                            "curve25519:EBMMPAFOPU": "HyhQD4mXwNViqns0noABW9NxHbCAOkriQ4QKGGndk3w",
                            "ed25519:EBMMPAFOPU": "xSQaxrFOTXH+7Zjo+iwb445hlNPFjnx1O3KaV3Am55k",
                        },
                        signatures: {
                            "@testing_florian1:matrix.org": {
                                "ed25519:EBMMPAFOPU":
                                    "XFJVq9HmO5lfJN7l6muaUt887aUHg0/poR3p9XHGXBrLUqzfG7Qllq7jjtUjtcTc5CMD7/mpsXfuC2eV+X1uAw",
                            },
                        },
                        user_id: "@testing_florian1:matrix.org",
                        unsigned: {
                            device_display_name: "display name",
                        },
                    },
                },
            },
            failures: {},
            master_keys: {
                "@testing_florian1:matrix.org": {
                    user_id: "@testing_florian1:matrix.org",
                    usage: ["master"],
                    keys: {
                        "ed25519:O5s5RoLaz93Bjf/pg55oJeCVeYYoruQhqEd0Mda6lq0":
                            "O5s5RoLaz93Bjf/pg55oJeCVeYYoruQhqEd0Mda6lq0",
                    },
                    signatures: {
                        "@testing_florian1:matrix.org": {
                            "ed25519:UKAQMJSJZC":
                                "q4GuzzuhZfTpwrlqnJ9+AEUtEfEQ0um1PO3puwp/+vidzFicw0xEPjedpJoASYQIJ8XJAAWX8Q235EKeCzEXCA",
                        },
                    },
                },
            },
            self_signing_keys: {
                "@testing_florian1:matrix.org": {
                    user_id: "@testing_florian1:matrix.org",
                    usage: ["self_signing"],
                    keys: {
                        "ed25519:YYWIHBCuKGEy9CXiVrfBVR0N1I60JtiJTNCWjiLAFzo":
                            "YYWIHBCuKGEy9CXiVrfBVR0N1I60JtiJTNCWjiLAFzo",
                    },
                    signatures: {
                        "@testing_florian1:matrix.org": {
                            "ed25519:O5s5RoLaz93Bjf/pg55oJeCVeYYoruQhqEd0Mda6lq0":
                                "yckmxgQ3JA5bb205/RunJipnpZ37ycGNf4OFzDwAad++chd71aGHqAMQ1f6D2GVfl8XdHmiRaohZf4mGnDL0AA",
                        },
                    },
                },
            },
            user_signing_keys: {
                "@testing_florian1:matrix.org": {
                    user_id: "@testing_florian1:matrix.org",
                    usage: ["user_signing"],
                    keys: {
                        "ed25519:Maa77okgZxnABGqaiChEUnV4rVsAI61WXWeL5TSEUhs":
                            "Maa77okgZxnABGqaiChEUnV4rVsAI61WXWeL5TSEUhs",
                    },
                    signatures: {
                        "@testing_florian1:matrix.org": {
                            "ed25519:O5s5RoLaz93Bjf/pg55oJeCVeYYoruQhqEd0Mda6lq0":
                                "WxNNXb13yCrBwXUQzdDWDvWSQ/qWCfwpvssOudlAgbtMzRESMbCTDkeA8sS1awaAtUmu7FrPtDb5LYfK/EE2CQ",
                        },
                    },
                },
            },
        };

        function awaitKeyQueryRequest(): Promise<Record<string, []>> {
            return new Promise((resolve) => {
                const listener = (url: string, options: RequestInit) => {
                    const content = JSON.parse(options.body as string);
                    // Resolve with request payload
                    resolve(content.device_keys);

                    // Return response of `/keys/query`
                    return queryResponseBody;
                };

                fetchMock.post(
                    new URL("/_matrix/client/v3/keys/query", aliceClient.getHomeserverUrl()).toString(),
                    listener,
                );
            });
        }

        it("Download uncached keys for known user", async () => {
            const queryPromise = awaitKeyQueryRequest();

            const user = "@testing_florian1:matrix.org";
            const devicesInfo = await aliceClient.getCrypto()!.getUserDeviceInfo([user], true);

            // Wait for `/keys/query` to be called
            const deviceKeysPayload = await queryPromise;

            expect(deviceKeysPayload).toStrictEqual({ [user]: [] });
            expect(devicesInfo.get(user)?.size).toBe(1);

            // Convert the expected device to IDevice and check
            expect(devicesInfo.get(user)?.get("EBMMPAFOPU")).toStrictEqual(
                downloadDeviceToJsDevice(queryResponseBody.device_keys[user]?.EBMMPAFOPU),
            );
        });

        it("Download uncached keys for unknown user", async () => {
            const queryPromise = awaitKeyQueryRequest();

            const user = "@bob:xyz";
            const devicesInfo = await aliceClient.getCrypto()!.getUserDeviceInfo([user], true);

            // Wait for `/keys/query` to be called
            const deviceKeysPayload = await queryPromise;

            expect(deviceKeysPayload).toStrictEqual({ [user]: [] });
            // The old crypto has an empty map for `@bob:xyz`
            // The new crypto does not have the `@bob:xyz` entry in `devicesInfo`
            expect(devicesInfo.get(user)?.size).toBeFalsy();
        });

        it("Get devices from tracked users", async () => {
            // We want to use fake timers, but the wasm bindings of matrix-sdk-crypto rely on a working `queueMicrotask`.
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
            const queryPromise = awaitKeyQueryRequest();

            const user = "@testing_florian1:matrix.org";
            // `user` will be added to the room
            syncResponder.sendOrQueueSyncResponse(getSyncResponse([user, "@bob:xyz"]));

            // Advance local date to 2 minutes
            // The old crypto only runs the upload every 60 seconds
            jest.setSystemTime(Date.now() + 2 * 60 * 1000);

            await syncPromise(aliceClient);

            // Old crypto: for alice: run over the `sleep(5)` in `doQueuedQueries` of `DeviceList`
            jest.runAllTimers();
            // Old crypto: for alice: run the `processQueryResponseForUser` in `doQueuedQueries` of `DeviceList`
            await flushPromises();

            // Wait for alice to query `user` keys
            await queryPromise;

            // Old crypto: for `user`: run over the `sleep(5)` in `doQueuedQueries` of `DeviceList`
            jest.runAllTimers();
            // Old crypto: for `user`: run the `processQueryResponseForUser` in `doQueuedQueries` of `DeviceList`
            // It will add `@testing_florian1:matrix.org` devices to the DeviceList
            await flushPromises();

            const devicesInfo = await aliceClient.getCrypto()!.getUserDeviceInfo([user]);

            // We should only have the `user` in it
            expect(devicesInfo.size).toBe(1);
            // We are expecting only the EBMMPAFOPU device
            expect(devicesInfo.get(user)!.size).toBe(1);
            expect(devicesInfo.get(user)!.get("EBMMPAFOPU")).toEqual(
                downloadDeviceToJsDevice(queryResponseBody.device_keys[user]["EBMMPAFOPU"]),
            );
        });
    });

    describe("Secret Storage and Key Backup", () => {
        let accountDataAccumulator: AccountDataAccumulator;

        /**
         * Create a fake secret storage key
         * Async because `bootstrapSecretStorage` expect an async method
         */
        const createSecretStorageKey = jest.fn().mockResolvedValue({
            keyInfo: {}, // Returning undefined here used to cause a crash
            privateKey: Uint8Array.of(32, 33),
        });

        beforeEach(async () => {
            createSecretStorageKey.mockClear();
            accountDataAccumulator = new AccountDataAccumulator();
            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
        });

        /**
         * Create a mock to respond to the PUT request `/_matrix/client/v3/user/:userId/account_data/m.cross_signing.${key}`
         * Resolved when the cross signing key is uploaded
         * https://spec.matrix.org/v1.6/client-server-api/#put_matrixclientv3useruseridaccount_datatype
         */
        async function awaitCrossSigningKeyUpload(key: string): Promise<Record<string, {}>> {
            const content = await accountDataAccumulator.interceptSetAccountData(`m.cross_signing.${key}`);
            return content.encrypted;
        }

        /**
         * Create a mock to respond to the PUT request `/_matrix/client/v3/user/:userId/account_data/:type(m.secret_storage.*)`
         * Resolved when a key is uploaded (ie in `body.content.key`)
         * https://spec.matrix.org/v1.6/client-server-api/#put_matrixclientv3useruseridaccount_datatype
         */
        async function awaitSecretStorageKeyStoredInAccountData(): Promise<string> {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const content = await accountDataAccumulator.interceptSetAccountData(":type(m.secret_storage.*)", {
                    repeat: 1,
                    overwriteRoutes: true,
                });
                accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);
                if (content.key) {
                    return content.key;
                }
            }
        }

        function awaitMegolmBackupKeyUpload(): Promise<Record<string, {}>> {
            return new Promise((resolve) => {
                // Called when the megolm backup key is uploaded
                fetchMock.put(
                    `express:/_matrix/client/v3/user/:userId/account_data/m.megolm_backup.v1`,
                    (url: string, options: RequestInit) => {
                        const content = JSON.parse(options.body as string);
                        // update account data for sync response
                        accountDataAccumulator.accountDataEvents.set("m.megolm_backup.v1", content);
                        resolve(content.encrypted);
                        return {};
                    },
                    { overwriteRoutes: true },
                );
            });
        }

        function awaitAccountDataUpdate(type: string): Promise<void> {
            return new Promise((resolve) => {
                aliceClient.on(ClientEvent.AccountData, (ev: MatrixEvent): void => {
                    if (ev.getType() === type) {
                        resolve();
                    }
                });
            });
        }

        /**
         * Add all mocks needed to setup cross-signing, key backup, 4S and then
         * configure the account to have recovery.
         *
         * @param backupVersion - The version of the created backup
         */
        async function bootstrapSecurity(backupVersion: string): Promise<void> {
            mockSetupCrossSigningRequests();
            mockSetupMegolmBackupRequests(backupVersion);

            // promise which will resolve when a `KeyBackupStatus` event is emitted with `enabled: true`
            const backupStatusUpdate = new Promise<void>((resolve) => {
                aliceClient.on(CryptoEvent.KeyBackupStatus, (enabled) => {
                    if (enabled) {
                        resolve();
                    }
                });
            });

            const setupPromises = [
                awaitCrossSigningKeyUpload("master"),
                awaitCrossSigningKeyUpload("user_signing"),
                awaitCrossSigningKeyUpload("self_signing"),
                awaitMegolmBackupKeyUpload(),
            ];

            // Before setting up secret-storage, bootstrap cross-signing, so that the client has cross-signing keys.
            await aliceClient.getCrypto()!.bootstrapCrossSigning({});

            // Now, when we bootstrap secret-storage, the cross-signing keys should be uploaded.
            const bootstrapPromise = aliceClient.getCrypto()!.bootstrapSecretStorage({
                setupNewSecretStorage: true,
                createSecretStorageKey,
                setupNewKeyBackup: true,
            });

            // Wait for the key to be uploaded in the account data
            await awaitSecretStorageKeyStoredInAccountData();

            // Wait for the cross signing keys to be uploaded
            await Promise.all(setupPromises);

            // wait for bootstrapSecretStorage to finished
            await bootstrapPromise;

            // Return the newly created key in the sync response
            accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);

            // Finally ensure backup is working
            await aliceClient.getCrypto()!.checkKeyBackupAndEnable();

            await backupStatusUpdate;
        }

        describe("Generate 4S recovery keys", () => {
            it("should create a random recovery key", async () => {
                const generatedKey = await aliceClient.getCrypto()!.createRecoveryKeyFromPassphrase();
                expect(generatedKey.privateKey).toBeDefined();
                expect(generatedKey.privateKey).toBeInstanceOf(Uint8Array);
                expect(generatedKey.privateKey.length).toBe(32);
                expect(generatedKey.keyInfo?.passphrase).toBeUndefined();
                expect(generatedKey.encodedPrivateKey).toBeDefined();
                expect(generatedKey.encodedPrivateKey!.indexOf("Es")).toBe(0);
            });

            it("should create a recovery key from passphrase", async () => {
                const generatedKey = await aliceClient.getCrypto()!.createRecoveryKeyFromPassphrase("mypassphrase");
                expect(generatedKey.privateKey).toBeDefined();
                expect(generatedKey.privateKey).toBeInstanceOf(Uint8Array);
                expect(generatedKey.privateKey.length).toBe(32);
                expect(generatedKey.keyInfo?.passphrase?.algorithm).toBe("m.pbkdf2");
                expect(generatedKey.keyInfo?.passphrase?.iterations).toBe(500000);

                expect(generatedKey.encodedPrivateKey).toBeDefined();
                expect(generatedKey.encodedPrivateKey!.indexOf("Es")).toBe(0);
            });
        });

        describe("bootstrapSecretStorage", () => {
            // Doesn't work with legacy crypto, which will try to bootstrap even without private key, which is buggy.
            newBackendOnly(
                "should throw an error if we are unable to create a key because createSecretStorageKey is not set",
                async () => {
                    await expect(
                        aliceClient.getCrypto()!.bootstrapSecretStorage({ setupNewSecretStorage: true }),
                    ).rejects.toThrow("unable to create a new secret storage key, createSecretStorageKey is not set");

                    expect(await aliceClient.getCrypto()!.isSecretStorageReady()).toStrictEqual(false);
                },
            );

            it("Should create a 4S key", async () => {
                accountDataAccumulator.interceptGetAccountData();

                const awaitAccountData = awaitAccountDataUpdate("m.secret_storage.default_key");

                const bootstrapPromise = aliceClient
                    .getCrypto()!
                    .bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey });

                // Wait for the key to be uploaded in the account data
                const secretStorageKey = await awaitSecretStorageKeyStoredInAccountData();

                // check that the key content contains the key check info
                const keyContent = accountDataAccumulator.accountDataEvents.get(
                    `m.secret_storage.key.${secretStorageKey}`,
                )!;
                // In order to verify if the key is valid, a zero secret is encrypted with the key
                expect(keyContent.iv).toBeDefined();
                expect(keyContent.mac).toBeDefined();

                // Return the newly created key in the sync response
                accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);

                // Finally, wait for bootstrapSecretStorage to finished
                await bootstrapPromise;

                // await account data updated before getting default key.
                await awaitAccountData;

                const defaultKeyId = await aliceClient.secretStorage.getDefaultKeyId();
                // Check that the uploaded key in stored in the secret storage
                expect(await aliceClient.secretStorage.hasKey(secretStorageKey)).toBeTruthy();
                // Check that the uploaded key is the default key
                expect(defaultKeyId).toBe(secretStorageKey);
            });

            it("should do nothing if an AES key is already in the secret storage and setupNewSecretStorage is not set", async () => {
                const awaitAccountDataClientUpdate = awaitAccountDataUpdate("m.secret_storage.default_key");

                const bootstrapPromise = aliceClient.getCrypto()!.bootstrapSecretStorage({ createSecretStorageKey });

                // Wait for the key to be uploaded in the account data
                await awaitSecretStorageKeyStoredInAccountData();

                // Return the newly created key in the sync response
                accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);

                // Wait for bootstrapSecretStorage to finished
                await bootstrapPromise;

                // On legacy crypto we need to wait for ClientEvent.AccountData before calling bootstrap again.
                await awaitAccountDataClientUpdate;

                // Call again bootstrapSecretStorage
                await aliceClient.getCrypto()!.bootstrapSecretStorage({ createSecretStorageKey });

                // createSecretStorageKey should be called only on the first run of bootstrapSecretStorage
                expect(createSecretStorageKey).toHaveBeenCalledTimes(1);
            });

            it("should create a new key if setupNewSecretStorage is at true even if an AES key is already in the secret storage", async () => {
                let bootstrapPromise = aliceClient
                    .getCrypto()!
                    .bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey });

                // Wait for the key to be uploaded in the account data
                await awaitSecretStorageKeyStoredInAccountData();

                // Return the newly created key in the sync response
                accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);

                // Wait for bootstrapSecretStorage to finished
                await bootstrapPromise;

                // Call again bootstrapSecretStorage
                bootstrapPromise = aliceClient
                    .getCrypto()!
                    .bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey });

                // Wait for the key to be uploaded in the account data
                await awaitSecretStorageKeyStoredInAccountData();

                // Return the newly created key in the sync response
                accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);

                // Wait for bootstrapSecretStorage to finished
                await bootstrapPromise;

                // createSecretStorageKey should have been called twice, one time every bootstrapSecretStorage call
                expect(createSecretStorageKey).toHaveBeenCalledTimes(2);
            });

            it("should upload cross signing keys", async () => {
                mockSetupCrossSigningRequests();

                // Before setting up secret-storage, bootstrap cross-signing, so that the client has cross-signing keys.
                await aliceClient.getCrypto()!.bootstrapCrossSigning({});

                // Now, when we bootstrap secret-storage, the cross-signing keys should be uploaded.
                const bootstrapPromise = aliceClient
                    .getCrypto()!
                    .bootstrapSecretStorage({ setupNewSecretStorage: true, createSecretStorageKey });

                // Wait for the key to be uploaded in the account data
                const secretStorageKey = await awaitSecretStorageKeyStoredInAccountData();

                // Return the newly created key in the sync response
                accountDataAccumulator.sendSyncResponseWithUpdatedAccountData(syncResponder);

                // Wait for the cross signing keys to be uploaded
                const [masterKey, userSigningKey, selfSigningKey] = await Promise.all([
                    awaitCrossSigningKeyUpload("master"),
                    awaitCrossSigningKeyUpload("user_signing"),
                    awaitCrossSigningKeyUpload("self_signing"),
                ]);

                // Finally, wait for bootstrapSecretStorage to finished
                await bootstrapPromise;

                // Expect the cross signing master key to be uploaded and to be encrypted with `secretStorageKey`
                expect(masterKey[secretStorageKey]).toBeDefined();
                expect(userSigningKey[secretStorageKey]).toBeDefined();
                expect(selfSigningKey[secretStorageKey]).toBeDefined();
            });

            it("should create a new megolm backup", async () => {
                const backupVersion = "abc";
                await bootstrapSecurity(backupVersion);

                expect(await aliceClient.getCrypto()!.isSecretStorageReady()).toStrictEqual(true);

                // Expect a backup to be available and used
                const activeBackup = await aliceClient.getCrypto()!.getActiveSessionBackupVersion();
                expect(activeBackup).toStrictEqual(backupVersion);

                // check that there is a MSK signature
                const signatures = (await aliceClient.getCrypto()!.checkKeyBackupAndEnable())!.backupInfo.auth_data!
                    .signatures;
                expect(signatures).toBeDefined();
                expect(signatures![aliceClient.getUserId()!]).toBeDefined();
                const mskId = await aliceClient.getCrypto()!.getCrossSigningKeyId(CrossSigningKey.Master)!;
                expect(signatures![aliceClient.getUserId()!][`ed25519:${mskId}`]).toBeDefined();
            });
        });

        describe("Manage Key Backup", () => {
            beforeEach(async () => {
                // We want to use fake timers, but the wasm bindings of matrix-sdk-crypto rely on a working `queueMicrotask`.
                jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
            });

            it("Should be able to restore from 4S after bootstrap", async () => {
                const backupVersion = "1";
                await bootstrapSecurity(backupVersion);

                const check = await aliceClient.getCrypto()!.checkKeyBackupAndEnable();

                // Import a new key that should be uploaded
                const newKey = testData.MEGOLM_SESSION_DATA;

                const awaitKeyUploaded = new Promise<IKeyBackup>((resolve) => {
                    fetchMock.put(
                        "path:/_matrix/client/v3/room_keys/keys",
                        (url, request) => {
                            const uploadPayload: IKeyBackup = JSON.parse(request.body?.toString() ?? "{}");
                            resolve(uploadPayload);
                            return {
                                status: 200,
                                body: {
                                    count: 1,
                                    etag: "abcdefg",
                                },
                            };
                        },
                        {
                            overwriteRoutes: true,
                        },
                    );
                });

                await aliceClient.getCrypto()!.importRoomKeys([newKey]);

                // The backup loop waits a random amount of time to avoid different clients firing at the same time.
                jest.runAllTimers();

                const keyBackupData = await awaitKeyUploaded;

                fetchMock.get("express:/_matrix/client/v3/room_keys/keys", keyBackupData);

                // should be able to restore from 4S
                const importResult = await advanceTimersUntil(
                    aliceClient.restoreKeyBackupWithSecretStorage(check!.backupInfo!),
                );
                expect(importResult.imported).toStrictEqual(1);
            });

            it("Reset key backup should create a new backup and update 4S", async () => {
                // First set up 4S and key backup
                const backupVersion = "1";
                await bootstrapSecurity(backupVersion);

                const currentVersion = await aliceClient.getCrypto()!.getActiveSessionBackupVersion();
                const currentBackupKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();

                // we will call reset backup, it should delete the existing one, then setup a new one
                // Let's mock for that

                // Mock delete and replace the GET to return 404 as soon as called
                const awaitDeleteCalled = new Promise<void>((resolve) => {
                    fetchMock.delete(
                        "express:/_matrix/client/v3/room_keys/version/:version",
                        (url: string, options: RequestInit) => {
                            fetchMock.get(
                                "path:/_matrix/client/v3/room_keys/version",
                                {
                                    status: 404,
                                    body: { errcode: "M_NOT_FOUND", error: "No current backup version." },
                                },
                                { overwriteRoutes: true },
                            );
                            resolve();
                            return {};
                        },
                        { overwriteRoutes: true },
                    );
                });

                const newVersion = "2";
                fetchMock.post(
                    "path:/_matrix/client/v3/room_keys/version",
                    (url, request) => {
                        const backupData: KeyBackupInfo = JSON.parse(request.body?.toString() ?? "{}");
                        backupData.version = newVersion;
                        backupData.count = 0;
                        backupData.etag = "zer";

                        // update get call with new version
                        fetchMock.get("path:/_matrix/client/v3/room_keys/version", backupData, {
                            overwriteRoutes: true,
                        });
                        return {
                            version: backupVersion,
                        };
                    },
                    { overwriteRoutes: true },
                );

                const newBackupStatusUpdate = new Promise<void>((resolve) => {
                    aliceClient.on(CryptoEvent.KeyBackupStatus, (enabled) => {
                        if (enabled) {
                            resolve();
                        }
                    });
                });

                const newBackupUploadPromise = awaitMegolmBackupKeyUpload();

                // Track calls to scheduleAllGroupSessionsForBackup. This is
                // only relevant on legacy encryption.
                const scheduleAllGroupSessionsForBackup = jest.fn();
                if (backend === "libolm") {
                    aliceClient.crypto!.backupManager.scheduleAllGroupSessionsForBackup =
                        scheduleAllGroupSessionsForBackup;
                } else {
                    // With Rust crypto, we don't need to call this function, so
                    // we call the dummy value here so we pass our later
                    // expectation.
                    scheduleAllGroupSessionsForBackup();
                }

                await aliceClient.getCrypto()!.resetKeyBackup();
                await awaitDeleteCalled;
                await newBackupStatusUpdate;
                await newBackupUploadPromise;

                const nextVersion = await aliceClient.getCrypto()!.getActiveSessionBackupVersion();
                const nextKey = await aliceClient.getCrypto()!.getSessionBackupPrivateKey();

                expect(nextVersion).toBeDefined();
                expect(nextVersion).not.toEqual(currentVersion);
                expect(nextKey).not.toEqual(currentBackupKey);
                expect(scheduleAllGroupSessionsForBackup).toHaveBeenCalled();

                // The `deleteKeyBackupVersion` API is deprecated but has been modified to work with both crypto backend
                // ensure that it works anyhow
                await aliceClient.deleteKeyBackupVersion(nextVersion!);
                await aliceClient.getCrypto()!.checkKeyBackupAndEnable();
                // XXX Legacy crypto does not update 4S when doing that; should ensure that rust implem does it.
                expect(await aliceClient.getCrypto()!.getActiveSessionBackupVersion()).toBeNull();
            });
        });
    });

    describe("Check if the cross signing keys are available for a user", () => {
        beforeEach(async () => {
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);

            const keyResponder = new E2EKeyResponder(aliceClient.getHomeserverUrl());
            keyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);
            keyResponder.addDeviceKeys(SIGNED_TEST_DEVICE_DATA);
            keyResponder.addKeyReceiver(BOB_TEST_USER_ID, keyReceiver);
            keyResponder.addCrossSigningData(BOB_SIGNED_CROSS_SIGNING_KEYS_DATA);
            keyResponder.addDeviceKeys(BOB_SIGNED_TEST_DEVICE_DATA);

            expectAliceKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await startClientAndAwaitFirstSync();
        });

        it("Cross signing keys are available for an untracked user with cross signing keys on the homeserver", async () => {
            // Needed for old crypto, download and cache locally the cross signing keys of Bob
            await aliceClient.getCrypto()?.getUserDeviceInfo([BOB_TEST_USER_ID], true);

            const hasCrossSigningKeysForUser = await aliceClient
                .getCrypto()!
                .userHasCrossSigningKeys(BOB_TEST_USER_ID, true);
            expect(hasCrossSigningKeysForUser).toBe(true);
        });

        it("Cross signing keys are available for a tracked user", async () => {
            // Process Alice keys, old crypto has a sleep(5ms) during the process
            await jest.advanceTimersByTimeAsync(5);
            await flushPromises();

            // Alice is the local user and should be tracked !
            const hasCrossSigningKeysForUser = await aliceClient.getCrypto()!.userHasCrossSigningKeys(TEST_USER_ID);
            expect(hasCrossSigningKeysForUser).toBe(true);
        });

        it("Cross signing keys are not available for an unknown user", async () => {
            const hasCrossSigningKeysForUser = await aliceClient.getCrypto()!.userHasCrossSigningKeys("@unknown:xyz");
            expect(hasCrossSigningKeysForUser).toBe(false);
        });
    });

    /** Guards against downgrade attacks from servers hiding or manipulating the crypto settings. */
    describe("Persistent encryption settings", () => {
        let persistentStoreClient: MatrixClient;
        let client2: MatrixClient;

        beforeEach(async () => {
            const homeserverurl = "https://alice-server.com";
            const userId = "@alice:localhost";

            const keyResponder = new E2EKeyResponder(homeserverurl);
            keyResponder.addKeyReceiver(userId, keyReceiver);

            // For legacy crypto, these tests only work properly with a proper (indexeddb-based) CryptoStore, so
            // rather than using the existing `aliceClient`, create a new client. Once we drop legacy crypto, we can
            // just use `aliceClient` here.
            persistentStoreClient = await makeNewClient(homeserverurl, userId, "persistentStoreClient");
            await persistentStoreClient.startClient({});
        });

        afterEach(async () => {
            persistentStoreClient.stopClient();
            client2?.stopClient();
        });

        test("Sending a message in a room where the server is hiding the state event does not send a plaintext event", async () => {
            // Alice is in an encrypted room
            const encryptionState = mkEncryptionEvent({ algorithm: "m.megolm.v1.aes-sha2" });
            syncResponder.sendOrQueueSyncResponse(getSyncResponseWithState([encryptionState]));
            await syncPromise(persistentStoreClient);

            // Send a message, and expect to get an `m.room.encrypted` event.
            await Promise.all([persistentStoreClient.sendTextMessage(ROOM_ID, "test"), expectEncryptedSendMessage()]);

            // We now replace the client, and allow the new one to resync, *without* the encryption event.
            client2 = await replaceClient(persistentStoreClient);
            syncResponder.sendOrQueueSyncResponse(getSyncResponseWithState([]));
            await client2.startClient({});
            await syncPromise(client2);
            logger.log(client2.getUserId() + ": restarted");

            await expectSendMessageToFail(client2);
        });

        test("Changes to the rotation period should be ignored", async () => {
            // Alice is in an encrypted room, where the rotation period is set to 2 messages
            const encryptionState = mkEncryptionEvent({ algorithm: "m.megolm.v1.aes-sha2", rotation_period_msgs: 2 });
            syncResponder.sendOrQueueSyncResponse(getSyncResponseWithState([encryptionState]));
            await syncPromise(persistentStoreClient);

            // Send a message, and expect to get an `m.room.encrypted` event.
            const [, msg1Content] = await Promise.all([
                persistentStoreClient.sendTextMessage(ROOM_ID, "test1"),
                expectEncryptedSendMessage(),
            ]);

            // Replace the state with one which bumps the rotation period. This should be ignored, though it's not
            // clear that is correct behaviour (see https://github.com/element-hq/element-meta/issues/69)
            const encryptionState2 = mkEncryptionEvent({
                algorithm: "m.megolm.v1.aes-sha2",
                rotation_period_msgs: 100,
            });
            syncResponder.sendOrQueueSyncResponse({
                next_batch: "1",
                rooms: { join: { [TEST_ROOM_ID]: { timeline: { events: [encryptionState2], prev_batch: "" } } } },
            });
            await syncPromise(persistentStoreClient);

            // Send two more messages. The first should use the same megolm session as the first; the second should
            // use a different one.
            const [, msg2Content] = await Promise.all([
                persistentStoreClient.sendTextMessage(ROOM_ID, "test2"),
                expectEncryptedSendMessage(),
            ]);
            expect(msg2Content.session_id).toEqual(msg1Content.session_id);
            const [, msg3Content] = await Promise.all([
                persistentStoreClient.sendTextMessage(ROOM_ID, "test3"),
                expectEncryptedSendMessage(),
            ]);
            expect(msg3Content.session_id).not.toEqual(msg1Content.session_id);
        });

        test("Changes to the rotation period should be ignored after a client restart", async () => {
            // Alice is in an encrypted room, where the rotation period is set to 2 messages
            const encryptionState = mkEncryptionEvent({ algorithm: "m.megolm.v1.aes-sha2", rotation_period_msgs: 2 });
            syncResponder.sendOrQueueSyncResponse(getSyncResponseWithState([encryptionState]));
            await syncPromise(persistentStoreClient);

            // Send a message, and expect to get an `m.room.encrypted` event.
            await Promise.all([persistentStoreClient.sendTextMessage(ROOM_ID, "test1"), expectEncryptedSendMessage()]);

            // We now replace the client, and allow the new one to resync with a *different* encryption event.
            client2 = await replaceClient(persistentStoreClient);
            const encryptionState2 = mkEncryptionEvent({
                algorithm: "m.megolm.v1.aes-sha2",
                rotation_period_msgs: 100,
            });
            syncResponder.sendOrQueueSyncResponse(getSyncResponseWithState([encryptionState2]));
            await client2.startClient({});
            await syncPromise(client2);
            logger.log(client2.getUserId() + ": restarted");

            // Now send another message, which should (for now) be rejected.
            await expectSendMessageToFail(client2);
        });

        /** Shut down `oldClient`, and build a new MatrixClient for the same user. */
        async function replaceClient(oldClient: MatrixClient) {
            oldClient.stopClient();
            syncResponder.sendOrQueueSyncResponse({}); // flush pending request from old client
            return makeNewClient(oldClient.getHomeserverUrl(), oldClient.getSafeUserId(), "client2");
        }

        async function makeNewClient(
            homeserverUrl: string,
            userId: string,
            loggerPrefix: string,
        ): Promise<MatrixClient> {
            const client = createClient({
                baseUrl: homeserverUrl,
                userId: userId,
                accessToken: "akjgkrgjs",
                deviceId: "xzcvb",
                cryptoCallbacks: createCryptoCallbacks(),
                logger: logger.getChild(loggerPrefix),

                // For legacy crypto, these tests only work with a proper persistent cryptoStore.
                cryptoStore: new IndexedDBCryptoStore(indexedDB, "test"),
            });
            await initCrypto(client);
            mockInitialApiRequests(client.getHomeserverUrl());
            return client;
        }

        function mkEncryptionEvent(content: Object) {
            return mkEventCustom({
                sender: persistentStoreClient.getSafeUserId(),
                type: "m.room.encryption",
                state_key: "",
                content: content,
            });
        }

        /** Sync response which includes `TEST_ROOM_ID`, where alice is a member
         *
         * @param stateEvents - Additional state events for the test room
         */
        function getSyncResponseWithState(stateEvents: Array<Object>) {
            const roomResponse = {
                state: {
                    events: [
                        mkMembershipCustom({
                            membership: KnownMembership.Join,
                            sender: persistentStoreClient.getSafeUserId(),
                        }),
                        ...stateEvents,
                    ],
                },
                timeline: {
                    events: [],
                    prev_batch: "",
                },
            };

            return {
                next_batch: "1",
                rooms: { join: { [TEST_ROOM_ID]: roomResponse } },
            };
        }

        /** Send a message with the given client, and check that it is not sent in plaintext */
        async function expectSendMessageToFail(aliceClient2: MatrixClient) {
            // The precise failure mode here is somewhat up for debate (https://github.com/element-hq/element-meta/issues/69).
            // For now, the attempt to send is rejected with an exception. The text is different between old and new stacks.
            await expect(aliceClient2.sendTextMessage(ROOM_ID, "test")).rejects.toThrow(
                /unconfigured room !room:id|Room !room:id was previously configured to use encryption/,
            );
        }
    });
});
