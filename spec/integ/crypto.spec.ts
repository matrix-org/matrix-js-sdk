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
import MockHttpBackend from "matrix-mock-request";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import * as testUtils from "../test-utils/test-utils";
import { TestClient } from "../TestClient";
import { logger } from "../../src/logger";
import {
    IClaimOTKsResult,
    IContent,
    IDownloadKeyResult,
    IEvent,
    IJoinedRoom,
    IndexedDBCryptoStore,
    ISyncResponse,
    IUploadKeysRequest,
    MatrixEvent,
    MatrixEventEvent,
    Room,
    RoomMember,
    RoomStateEvent,
} from "../../src/matrix";
import { IDeviceKeys } from "../../src/crypto/dehydration";
import { DeviceInfo } from "../../src/crypto/deviceinfo";
import { CRYPTO_BACKENDS, InitCrypto } from "../test-utils/test-utils";

const ROOM_ID = "!room:id";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

// start an Olm session with a given recipient
async function createOlmSession(olmAccount: Olm.Account, recipientTestClient: TestClient): Promise<Olm.Session> {
    const keys = await recipientTestClient.awaitOneTimeKeyUpload();
    const otkId = Object.keys(keys)[0];
    const otk = keys[otkId];

    const session = new global.Olm.Session();
    session.create_outbound(olmAccount, recipientTestClient.getDeviceKey(), otk.key);
    return session;
}

// IToDeviceEvent isn't exported by src/sync-accumulator.ts
interface ToDeviceEvent {
    content: IContent;
    sender: string;
    type: string;
}

/** encrypt an event with an existing olm session */
function encryptOlmEvent(opts: {
    /** the sender's user id */
    sender?: string;
    /** the sender's curve25519 key */
    senderKey: string;
    /** the sender's ed25519 key */
    senderSigningKey: string;
    /** the olm session to use for encryption */
    p2pSession: Olm.Session;
    /** the recipient client */
    recipient: TestClient;
    /** the payload of the message */
    plaincontent?: object;
    /** the event type of the payload */
    plaintype?: string;
}): ToDeviceEvent {
    expect(opts.senderKey).toBeTruthy();
    expect(opts.p2pSession).toBeTruthy();
    expect(opts.recipient).toBeTruthy();

    const plaintext = {
        content: opts.plaincontent || {},
        recipient: opts.recipient.userId,
        recipient_keys: {
            ed25519: opts.recipient.getSigningKey(),
        },
        keys: {
            ed25519: opts.senderSigningKey,
        },
        sender: opts.sender || "@bob:xyz",
        type: opts.plaintype || "m.test",
    };

    return {
        content: {
            algorithm: "m.olm.v1.curve25519-aes-sha2",
            ciphertext: {
                [opts.recipient.getDeviceKey()]: opts.p2pSession.encrypt(JSON.stringify(plaintext)),
            },
            sender_key: opts.senderKey,
        },
        sender: opts.sender || "@bob:xyz",
        type: "m.room.encrypted",
    };
}

// encrypt an event with megolm
function encryptMegolmEvent(opts: {
    senderKey: string;
    groupSession: Olm.OutboundGroupSession;
    plaintext?: Partial<IEvent>;
    room_id?: string;
}): IEvent {
    expect(opts.senderKey).toBeTruthy();
    expect(opts.groupSession).toBeTruthy();

    const plaintext = opts.plaintext || {};
    if (!plaintext.content) {
        plaintext.content = {
            body: "42",
            msgtype: "m.text",
        };
    }
    if (!plaintext.type) {
        plaintext.type = "m.room.message";
    }
    if (!plaintext.room_id) {
        expect(opts.room_id).toBeTruthy();
        plaintext.room_id = opts.room_id;
    }
    return encryptMegolmEventRawPlainText({ senderKey: opts.senderKey, groupSession: opts.groupSession, plaintext });
}

function encryptMegolmEventRawPlainText(opts: {
    senderKey: string;
    groupSession: Olm.OutboundGroupSession;
    plaintext: Partial<IEvent>;
}): IEvent {
    return {
        event_id: "$test_megolm_event_" + Math.random(),
        sender: "@not_the_real_sender:example.com",
        origin_server_ts: 1672944778000,
        content: {
            algorithm: "m.megolm.v1.aes-sha2",
            ciphertext: opts.groupSession.encrypt(JSON.stringify(opts.plaintext)),
            device_id: "testDevice",
            sender_key: opts.senderKey,
            session_id: opts.groupSession.session_id(),
        },
        type: "m.room.encrypted",
        unsigned: {},
    };
}

/** build an encrypted room_key event to share a group session, using an existing olm session */
function encryptGroupSessionKey(opts: {
    recipient: TestClient;
    /** sender's olm account */
    olmAccount: Olm.Account;
    /** sender's olm session with the recipient */
    p2pSession: Olm.Session;
    groupSession: Olm.OutboundGroupSession;
    room_id?: string;
}): Partial<IEvent> {
    const senderKeys = JSON.parse(opts.olmAccount.identity_keys());
    return encryptOlmEvent({
        senderKey: senderKeys.curve25519,
        senderSigningKey: senderKeys.ed25519,
        recipient: opts.recipient,
        p2pSession: opts.p2pSession,
        plaincontent: {
            algorithm: "m.megolm.v1.aes-sha2",
            room_id: opts.room_id,
            session_id: opts.groupSession.session_id(),
            session_key: opts.groupSession.session_key(),
        },
        plaintype: "m.room_key",
    });
}

// get a /sync response which contains a single room (ROOM_ID), with the members given
function getSyncResponse(roomMembers: string[]): ISyncResponse {
    const roomResponse: IJoinedRoom = {
        summary: {
            "m.heroes": [],
            "m.joined_member_count": roomMembers.length,
            "m.invited_member_count": roomMembers.length,
        },
        state: {
            events: [
                testUtils.mkEventCustom({
                    sender: roomMembers[0],
                    type: "m.room.encryption",
                    state_key: "",
                    content: {
                        algorithm: "m.megolm.v1.aes-sha2",
                    },
                }),
            ],
        },
        timeline: {
            events: [],
            prev_batch: "",
        },
        ephemeral: { events: [] },
        account_data: { events: [] },
        unread_notifications: {},
    };

    for (let i = 0; i < roomMembers.length; i++) {
        roomResponse.state.events.push(
            testUtils.mkMembershipCustom({
                membership: "join",
                sender: roomMembers[i],
            }),
        );
    }

    return {
        next_batch: "1",
        rooms: {
            join: { [ROOM_ID]: roomResponse },
            invite: {},
            leave: {},
        },
        account_data: { events: [] },
    };
}

/**
 * Establish an Olm Session with the test user
 *
 * Waits for the test user to upload their keys, then sends a /sync response with a to-device message which will
 * establish an Olm session.
 *
 * @param testClient: a TestClient for the user under test, which we expect to upload account keys, and to make a
 *    /sync request which we will respond to.
 * @param peerOlmAccount: an OlmAccount which will be used to initiate the Olm session.
 */
async function establishOlmSession(testClient: TestClient, peerOlmAccount: Olm.Account): Promise<Olm.Session> {
    const peerE2EKeys = JSON.parse(peerOlmAccount.identity_keys());
    const p2pSession = await createOlmSession(peerOlmAccount, testClient);
    const olmEvent = encryptOlmEvent({
        senderKey: peerE2EKeys.curve25519,
        senderSigningKey: peerE2EKeys.ed25519,
        recipient: testClient,
        p2pSession: p2pSession,
    });
    testClient.httpBackend.when("GET", "/sync").respond(200, {
        next_batch: 1,
        to_device: { events: [olmEvent] },
    });
    await testClient.flushSync();
    return p2pSession;
}

/**
 * Expect that the client shares keys with the given recipient
 *
 * Waits for an HTTP request to send the encrypted m.room_key to-device message; decrypts it and uses it
 * to establish an Olm InboundGroupSession.
 *
 * @param senderMockHttpBackend - MockHttpBackend for the sender
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
    senderMockHttpBackend: MockHttpBackend,
    recipientUserID: string,
    recipientOlmAccount: Olm.Account,
    recipientOlmSession: Olm.Session | null = null,
): Promise<Olm.InboundGroupSession> {
    const Olm = global.Olm;
    const testRecipientKey = JSON.parse(recipientOlmAccount.identity_keys())["curve25519"];

    let inboundGroupSession: Olm.InboundGroupSession;

    senderMockHttpBackend.when("PUT", "/sendToDevice/m.room.encrypted/").respond(200, (_path, content: any) => {
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
        inboundGroupSession = new Olm.InboundGroupSession();
        inboundGroupSession.create(decrypted.content.session_key);
        return {};
    });

    expect(await senderMockHttpBackend.flush("/sendToDevice/m.room.encrypted/", 1, 1000)).toEqual(1);
    return inboundGroupSession!;
}

/**
 * Expect that the client sends an encrypted event
 *
 * Waits for an HTTP request to send an encrypted message in the test room.
 *
 * @param senderMockHttpBackend - MockHttpBackend for the sender
 *
 * @param inboundGroupSessionPromise - a promise for an Olm InboundGroupSession, which will
 *    be used to decrypt the event. We will wait for this to resolve once the HTTP request has been processed.
 *
 * @returns The content of the successfully-decrypted event
 */
async function expectSendMegolmMessage(
    senderMockHttpBackend: MockHttpBackend,
    inboundGroupSessionPromise: Promise<Olm.InboundGroupSession>,
): Promise<Partial<IEvent>> {
    let encryptedMessageContent: IContent | null = null;
    senderMockHttpBackend.when("PUT", "/send/m.room.encrypted/").respond(200, function (_path, content: IContent) {
        encryptedMessageContent = content;
        return {
            event_id: "$event_id",
        };
    });

    expect(await senderMockHttpBackend.flush("/send/m.room.encrypted/", 1, 1000)).toEqual(1);

    // In some of the tests, the room key is sent *after* the actual event, so we may need to wait for it now.
    const inboundGroupSession = await inboundGroupSessionPromise;

    const r: any = inboundGroupSession.decrypt(encryptedMessageContent!.ciphertext);
    logger.log("Decrypted received megolm message", r);
    return JSON.parse(r.plaintext);
}

describe.each(Object.entries(CRYPTO_BACKENDS))("megolm (%s)", (backend: string, initCrypto: InitCrypto) => {
    if (!global.Olm) {
        // currently we use libolm to implement the crypto in the tests, so need it to be present.
        logger.warn("not running megolm tests: Olm not present");
        return;
    }

    // oldBackendOnly is an alternative to `it` or `test` which will skip the test if we are running against the
    // Rust backend. Once we have full support in the rust sdk, it will go away.
    const oldBackendOnly = backend === "rust-sdk" ? test.skip : test;

    const Olm = global.Olm;

    let testOlmAccount = {} as unknown as Olm.Account;
    let testSenderKey = "";
    let aliceTestClient = new TestClient("@alice:localhost", "device2", "access_token2");

    /**
     * Get the device keys for testOlmAccount in a format suitable for a
     * response to /keys/query
     *
     * @param userId - The user ID to query for
     * @returns The fake query response
     */
    function getTestKeysQueryResponse(userId: string): IDownloadKeyResult {
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        const testDeviceKeys: IDeviceKeys = {
            algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
            device_id: "DEVICE_ID",
            keys: {
                "curve25519:DEVICE_ID": testE2eKeys.curve25519,
                "ed25519:DEVICE_ID": testE2eKeys.ed25519,
            },
            user_id: userId,
        };
        const j = anotherjson.stringify(testDeviceKeys);
        const sig = testOlmAccount.sign(j);
        testDeviceKeys.signatures = { [userId]: { "ed25519:DEVICE_ID": sig } };

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

    beforeEach(async () => {
        aliceTestClient = new TestClient("@alice:localhost", "xzcvb", "akjgkrgjs");
        await initCrypto(aliceTestClient.client);

        // create a test olm device which we will use to communicate with alice. We use libolm to implement this.
        await Olm.init();
        testOlmAccount = new Olm.Account();
        testOlmAccount.create();
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        testSenderKey = testE2eKeys.curve25519;
    });

    afterEach(async () => {
        await aliceTestClient.stop();
    });

    it("Alice receives a megolm message", async () => {
        await aliceTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto.deviceList.downloadKeys = () => Promise.resolve({});
            aliceTestClient.client.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceTestClient,
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

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
        await aliceTestClient.flushSync();

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.isEncrypted()).toBe(true);

        // it probably won't be decrypted yet, because it takes a while to process the olm keys
        const decryptedEvent = await testUtils.awaitDecryption(event, { waitOnDecryptionFailure: true });
        expect(decryptedEvent.getContent().body).toEqual("42");
    });

    oldBackendOnly("Alice receives a megolm message before the session keys", async () => {
        // https://github.com/vector-im/element-web/issues/2273
        await aliceTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto.deviceList.downloadKeys = () => Promise.resolve({});
            aliceTestClient.client.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event, but don't send it yet
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceTestClient,
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
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 1,
            rooms: { join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } } },
        });
        await aliceTestClient.flushSync();

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        expect(room.getLiveTimeline().getEvents()[0].getContent().msgtype).toEqual("m.bad.encrypted");

        // now she gets the room_key event
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 2,
            to_device: {
                events: [roomKeyEncrypted],
            },
        });
        await aliceTestClient.flushSync();

        const event = room.getLiveTimeline().getEvents()[0];

        let decryptedEvent: MatrixEvent;
        if (event.getContent().msgtype != "m.bad.encrypted") {
            decryptedEvent = event;
        } else {
            decryptedEvent = await new Promise<MatrixEvent>((resolve) => {
                event.once(MatrixEventEvent.Decrypted, (ev) => {
                    logger.log(`${Date.now()} event ${event.getId()} now decrypted`);
                    resolve(ev);
                });
            });
        }
        expect(decryptedEvent.getContent().body).toEqual("42");
    });

    it("Alice gets a second room_key message", async () => {
        await aliceTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto.deviceList.downloadKeys = () => Promise.resolve({});
            aliceTestClient.client.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted1 = encryptGroupSessionKey({
            recipient: aliceTestClient,
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
            recipient: aliceTestClient,
            olmAccount: testOlmAccount,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        // on the first sync, send the best room key
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted1],
            },
        });

        // on the second sync, send the advanced room key, along with the
        // message.  This simulates the situation where Alice has been sent a
        // later copy of the room key and is reloading the client.
        const syncResponse2 = {
            next_batch: 2,
            to_device: {
                events: [roomKeyEncrypted2],
            },
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        };
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse2);

        // flush both syncs
        await aliceTestClient.flushSync();
        await aliceTestClient.flushSync();

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        await room.decryptCriticalEvents();
        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.getContent().body).toEqual("42");
    });

    oldBackendOnly("prepareToEncrypt", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await aliceTestClient.start();
        aliceTestClient.client.setGlobalErrorOnUnknownDevices(false);

        // tell alice she is sharing a room with bob
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
        await aliceTestClient.flushSync();

        // we expect alice first to query bob's keys...
        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));
        aliceTestClient.httpBackend.flush("/keys/query", 1);

        // ... and then claim one of his OTKs
        aliceTestClient.httpBackend.when("POST", "/keys/claim").respond(200, getTestKeysClaimResponse("@bob:xyz"));
        aliceTestClient.httpBackend.flush("/keys/claim", 1);

        // fire off the prepare request
        const room = aliceTestClient.client.getRoom(ROOM_ID);
        expect(room).toBeTruthy();
        const p = aliceTestClient.client.prepareToEncrypt(room!);

        // we expect to get a room key message
        await expectSendRoomKey(aliceTestClient.httpBackend, "@bob:xyz", testOlmAccount);

        // the prepare request should complete successfully.
        await p;
    });

    oldBackendOnly("Alice sends a megolm message", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await aliceTestClient.start();
        const p2pSession = await establishOlmSession(aliceTestClient, testOlmAccount);

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
        await aliceTestClient.flushSync();

        // start out with the device unknown - the send should be rejected.
        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));
        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, "test").then(
                () => {
                    throw new Error("sendTextMessage failed on an unknown device");
                },
                (e) => {
                    expect(e.name).toEqual("UnknownDeviceError");
                },
            ),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);

        // mark the device as known, and resend.
        aliceTestClient.client.setDeviceKnown("@bob:xyz", "DEVICE_ID");

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        const pendingMsg = room.getPendingEvents()[0];

        const inboundGroupSessionPromise = expectSendRoomKey(
            aliceTestClient.httpBackend,
            "@bob:xyz",
            testOlmAccount,
            p2pSession,
        );

        await Promise.all([
            aliceTestClient.client.resendEvent(pendingMsg, room),
            expectSendMegolmMessage(aliceTestClient.httpBackend, inboundGroupSessionPromise),
        ]);
    });

    oldBackendOnly("We shouldn't attempt to send to blocked devices", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await aliceTestClient.start();
        await establishOlmSession(aliceTestClient, testOlmAccount);

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
        await aliceTestClient.flushSync();

        logger.log("Forcing alice to download our device keys");

        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));
        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

        await Promise.all([
            aliceTestClient.client.downloadKeys(["@bob:xyz"]),
            aliceTestClient.httpBackend.flush("/keys/query", 2),
        ]);

        logger.log("Telling alice to block our device");
        aliceTestClient.client.setDeviceBlocked("@bob:xyz", "DEVICE_ID");

        logger.log("Telling alice to send a megolm message");
        aliceTestClient.httpBackend.when("PUT", "/send/").respond(200, {
            event_id: "$event_id",
        });
        aliceTestClient.httpBackend.when("PUT", "/sendToDevice/m.room_key.withheld/").respond(200, {});

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, "test"),

            // the crypto stuff can take a while, so give the requests a whole second.
            aliceTestClient.httpBackend.flushAllExpected({ timeout: 1000 }),
        ]);
    });

    describe("get|setGlobalErrorOnUnknownDevices", () => {
        it("should raise an error if crypto is disabled", () => {
            aliceTestClient.client["cryptoBackend"] = undefined;
            expect(() => aliceTestClient.client.setGlobalErrorOnUnknownDevices(true)).toThrowError(
                "encryption disabled",
            );
            expect(() => aliceTestClient.client.getGlobalErrorOnUnknownDevices()).toThrowError("encryption disabled");
        });

        oldBackendOnly("should permit sending to unknown devices", async () => {
            expect(aliceTestClient.client.getGlobalErrorOnUnknownDevices()).toBeTruthy();

            aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await aliceTestClient.start();
            const p2pSession = await establishOlmSession(aliceTestClient, testOlmAccount);

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
            await aliceTestClient.flushSync();

            // start out with the device unknown - the send should be rejected.
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

            await Promise.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, "test").then(
                    () => {
                        throw new Error("sendTextMessage failed on an unknown device");
                    },
                    (e) => {
                        expect(e.name).toEqual("UnknownDeviceError");
                    },
                ),
                aliceTestClient.httpBackend.flushAllExpected(),
            ]);

            // enable sending to unknown devices, and resend
            aliceTestClient.client.setGlobalErrorOnUnknownDevices(false);
            expect(aliceTestClient.client.getGlobalErrorOnUnknownDevices()).toBeFalsy();

            const room = aliceTestClient.client.getRoom(ROOM_ID)!;
            const pendingMsg = room.getPendingEvents()[0];

            const inboundGroupSessionPromise = expectSendRoomKey(
                aliceTestClient.httpBackend,
                "@bob:xyz",
                testOlmAccount,
                p2pSession,
            );

            await Promise.all([
                aliceTestClient.client.resendEvent(pendingMsg, room),
                expectSendMegolmMessage(aliceTestClient.httpBackend, inboundGroupSessionPromise),
            ]);
        });
    });

    describe("get|setGlobalBlacklistUnverifiedDevices", () => {
        it("should raise an error if crypto is disabled", () => {
            aliceTestClient.client["cryptoBackend"] = undefined;
            expect(() => aliceTestClient.client.setGlobalBlacklistUnverifiedDevices(true)).toThrowError(
                "encryption disabled",
            );
            expect(() => aliceTestClient.client.getGlobalBlacklistUnverifiedDevices()).toThrowError(
                "encryption disabled",
            );
        });

        oldBackendOnly("should disable sending to unverified devices", async () => {
            aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await aliceTestClient.start();
            const p2pSession = await establishOlmSession(aliceTestClient, testOlmAccount);

            // tell alice we share a room with bob
            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
            await aliceTestClient.flushSync();

            logger.log("Forcing alice to download our device keys");
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

            await Promise.all([
                aliceTestClient.client.downloadKeys(["@bob:xyz"]),
                aliceTestClient.httpBackend.flush("/keys/query", 2),
            ]);

            logger.log("Telling alice to block messages to unverified devices");
            expect(aliceTestClient.client.getGlobalBlacklistUnverifiedDevices()).toBeFalsy();
            aliceTestClient.client.setGlobalBlacklistUnverifiedDevices(true);
            expect(aliceTestClient.client.getGlobalBlacklistUnverifiedDevices()).toBeTruthy();

            logger.log("Telling alice to send a megolm message");
            aliceTestClient.httpBackend.when("PUT", "/send/").respond(200, { event_id: "$event_id" });
            aliceTestClient.httpBackend.when("PUT", "/sendToDevice/m.room_key.withheld/").respond(200, {});

            await Promise.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, "test"),
                aliceTestClient.httpBackend.flushAllExpected({ timeout: 1000 }),
            ]);

            // Now, let's mark the device as verified, and check that keys are sent to it.

            logger.log("Marking the device as verified");
            // XXX: this is an integration test; we really ought to do this via the cross-signing dance
            const d = aliceTestClient.client.crypto!.deviceList.getStoredDevice("@bob:xyz", "DEVICE_ID")!;
            d.verified = DeviceInfo.DeviceVerification.VERIFIED;
            aliceTestClient.client.crypto?.deviceList.storeDevicesForUser("@bob:xyz", { DEVICE_ID: d });

            const inboundGroupSessionPromise = expectSendRoomKey(
                aliceTestClient.httpBackend,
                "@bob:xyz",
                testOlmAccount,
                p2pSession,
            );

            logger.log("Asking alice to re-send");
            await Promise.all([
                expectSendMegolmMessage(aliceTestClient.httpBackend, inboundGroupSessionPromise).then((decrypted) => {
                    expect(decrypted.type).toEqual("m.room.message");
                    expect(decrypted.content!.body).toEqual("test");
                }),
                aliceTestClient.client.sendTextMessage(ROOM_ID, "test"),
            ]);
        });
    });

    oldBackendOnly("We should start a new megolm session when a device is blocked", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await aliceTestClient.start();
        const p2pSession = await establishOlmSession(aliceTestClient, testOlmAccount);

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
        await aliceTestClient.flushSync();

        logger.log("Fetching bob's devices and marking known");

        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));
        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

        await Promise.all([
            aliceTestClient.client.downloadKeys(["@bob:xyz"]),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);
        await aliceTestClient.client.setDeviceKnown("@bob:xyz", "DEVICE_ID");

        logger.log("Telling alice to send a megolm message");

        let megolmSessionId: string;
        const inboundGroupSessionPromise = expectSendRoomKey(
            aliceTestClient.httpBackend,
            "@bob:xyz",
            testOlmAccount,
            p2pSession,
        );
        inboundGroupSessionPromise.then((igs) => {
            megolmSessionId = igs.session_id();
        });

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, "test"),
            expectSendMegolmMessage(aliceTestClient.httpBackend, inboundGroupSessionPromise),
        ]);

        logger.log("Telling alice to block our device");
        aliceTestClient.client.setDeviceBlocked("@bob:xyz", "DEVICE_ID");

        logger.log("Telling alice to send another megolm message");
        aliceTestClient.httpBackend.when("PUT", "/send/").respond(200, function (_path, content) {
            logger.log("/send:", content);
            // make sure that a new session is used
            expect(content.session_id).not.toEqual(megolmSessionId);
            return {
                event_id: "$event_id",
            };
        });
        aliceTestClient.httpBackend.when("PUT", "/sendToDevice/m.room_key.withheld/").respond(200, {});

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, "test2"),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);
    });

    // https://github.com/vector-im/element-web/issues/2676
    oldBackendOnly("Alice should send to her other devices", async () => {
        // for this test, we make the testOlmAccount be another of Alice's devices.
        // it ought to get included in messages Alice sends.
        await aliceTestClient.start();
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
                                    mship: "join",
                                    sender: aliceTestClient.userId,
                                }),
                            ],
                        },
                    },
                },
            },
        };
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);

        // the completion of the first initialsync should make Alice
        // invalidate the device cache for all members in e2e rooms (ie,
        // herself), and do a key query.
        aliceTestClient.expectKeyQuery(getTestKeysQueryResponse(aliceTestClient.userId!));

        await aliceTestClient.httpBackend.flushAllExpected();

        // start out with the device unknown - the send should be rejected.
        try {
            await aliceTestClient.client.sendTextMessage(ROOM_ID, "test");
            throw new Error("sendTextMessage succeeded on an unknown device");
        } catch (e) {
            expect((e as any).name).toEqual("UnknownDeviceError");
            expect(Object.keys((e as any).devices)).toEqual([aliceTestClient.userId!]);
            expect(Object.keys((e as any)?.devices[aliceTestClient.userId!])).toEqual(["DEVICE_ID"]);
        }

        // mark the device as known, and resend.
        aliceTestClient.client.setDeviceKnown(aliceTestClient.userId!, "DEVICE_ID");
        aliceTestClient.httpBackend
            .when("POST", "/keys/claim")
            .respond(200, function (_path, content: IClaimOTKsResult) {
                expect(content.one_time_keys[aliceTestClient.userId!].DEVICE_ID).toEqual("signed_curve25519");
                return getTestKeysClaimResponse(aliceTestClient.userId!);
            });

        const inboundGroupSessionPromise = expectSendRoomKey(
            aliceTestClient.httpBackend,
            aliceTestClient.userId!,
            testOlmAccount,
        );

        let decrypted: Partial<IEvent> = {};

        // Grab the event that we'll need to resend
        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        const pendingEvents = room.getPendingEvents();
        expect(pendingEvents.length).toEqual(1);
        const unsentEvent = pendingEvents[0];

        await Promise.all([
            aliceTestClient.httpBackend.flush("/keys/claim", 1, 1000),
            expectSendMegolmMessage(aliceTestClient.httpBackend, inboundGroupSessionPromise).then((d) => {
                decrypted = d;
            }),
            aliceTestClient.client.resendEvent(unsentEvent, room),
        ]);

        expect(decrypted.type).toEqual("m.room.message");
        expect(decrypted.content?.body).toEqual("test");
    });

    oldBackendOnly("Alice should wait for device list to complete when sending a megolm message", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await aliceTestClient.start();
        await establishOlmSession(aliceTestClient, testOlmAccount);

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse(["@bob:xyz"]));
        await aliceTestClient.flushSync();

        // this will block
        logger.log("Forcing alice to download our device keys");
        const downloadPromise = aliceTestClient.client.downloadKeys(["@bob:xyz"]);

        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

        // so will this.
        const sendPromise = aliceTestClient.client.sendTextMessage(ROOM_ID, "test").then(
            () => {
                throw new Error("sendTextMessage failed on an unknown device");
            },
            (e) => {
                expect(e.name).toEqual("UnknownDeviceError");
            },
        );

        aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

        await aliceTestClient.httpBackend.flushAllExpected();
        await Promise.all([downloadPromise, sendPromise]);
    });

    oldBackendOnly("Alice exports megolm keys and imports them to a new device", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
        await aliceTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto.deviceList.downloadKeys = () => Promise.resolve({});
            aliceTestClient.client.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);

        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceTestClient,
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
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 1,
            to_device: {
                events: [roomKeyEncrypted],
            },
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        });
        await aliceTestClient.flushSync();

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        await room.decryptCriticalEvents();

        // it probably won't be decrypted yet, because it takes a while to process the olm keys
        const decryptedEvent = await testUtils.awaitDecryption(room.getLiveTimeline().getEvents()[0], {
            waitOnDecryptionFailure: true,
        });
        expect(decryptedEvent.getContent().body).toEqual("42");

        const exported = await aliceTestClient.client.exportRoomKeys();

        // start a new client
        aliceTestClient.stop();

        aliceTestClient = new TestClient("@alice:localhost", "device2", "access_token2");
        await initCrypto(aliceTestClient.client);
        await aliceTestClient.client.importRoomKeys(exported);
        await aliceTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const syncResponse = {
            next_batch: 1,
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        };

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
        await aliceTestClient.flushSync();

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
        await aliceTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto.deviceList.downloadKeys = () => Promise.resolve({});
            aliceTestClient.client.crypto.deviceList.getUserByIdentityKey = () => "@bob:xyz";
        }

        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            recipient: aliceTestClient,
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

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
        await aliceTestClient.flushSync();

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
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

        await aliceTestClient.start();
        await beccaTestClient.start();

        // if we're using the old crypto impl, stub out some methods in the device manager.
        // TODO: replace this with intercepts of the /keys/query endpoint to make it impl agnostic.
        if (aliceTestClient.client.crypto) {
            aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
            aliceTestClient.client.crypto!.deviceList.getDeviceByIdentityKey = () => device;
            aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => beccaTestClient.client.getUserId()!;
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
        const aliceOtks = await aliceTestClient.awaitOneTimeKeyUpload();
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
                        p2pSession.create_outbound(account, aliceTestClient.getDeviceKey(), aliceOtk.key);
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
            recipient: aliceTestClient,
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
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 1,
            to_device: { events: [encryptedForwardedKey] },
        });
        await aliceTestClient.flushSync();

        // Alice is invited to the room by Becca
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
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
                                        membership: "invite",
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        });
        await aliceTestClient.flushSync();

        // Alice has joined the room
        aliceTestClient.httpBackend
            .when("GET", "/sync")
            .respond(200, getSyncResponse(["@alice:localhost", "@becca:localhost"]));
        await aliceTestClient.flushSync();

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 4,
            rooms: {
                join: {
                    [ROOM_ID]: { timeline: { events: [event.event] } },
                },
            },
        });
        await aliceTestClient.flushSync();

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        const roomEvent = room.getLiveTimeline().getEvents()[0];
        expect(roomEvent.isEncrypted()).toBe(true);
        const decryptedEvent = await testUtils.awaitDecryption(roomEvent);
        expect(decryptedEvent.getContent().body).toEqual("test message");

        await beccaTestClient.stop();
    });

    oldBackendOnly("Alice receives shared history before being invited to a room by someone else", async () => {
        const beccaTestClient = new TestClient("@becca:localhost", "foobar", "bazquux");
        await beccaTestClient.client.initCrypto();

        await aliceTestClient.start();
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
        aliceTestClient.client.crypto!.deviceList.getDeviceByIdentityKey = () => device;

        // Create an olm session for Becca and Alice's devices
        const aliceOtks = await aliceTestClient.awaitOneTimeKeyUpload();
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
                        p2pSession.create_outbound(account, aliceTestClient.getDeviceKey(), aliceOtk.key);
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
            recipient: aliceTestClient,
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
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 1,
            to_device: { events: [encryptedForwardedKey] },
        });
        await aliceTestClient.flushSync();

        // Alice is invited to the room by Charlie
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
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
                                        membership: "invite",
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        });
        await aliceTestClient.flushSync();

        // Alice has joined the room
        aliceTestClient.httpBackend
            .when("GET", "/sync")
            .respond(200, getSyncResponse(["@alice:localhost", "@becca:localhost", "@charlie:localhost"]));
        await aliceTestClient.flushSync();

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
            next_batch: 4,
            rooms: {
                join: {
                    [ROOM_ID]: { timeline: { events: [event.event] } },
                },
            },
        });
        await aliceTestClient.flushSync();

        // Decryption should fail, because Alice hasn't received any keys she can trust
        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
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
        await aliceTestClient.start();

        aliceTestClient.httpBackend
            .when("POST", "/keys/query")
            .respond(200, function (_path, content: IUploadKeysRequest) {
                return { device_keys: {} };
            });

        /* Alice makes the /createRoom call */
        aliceTestClient.httpBackend.when("POST", "/createRoom").respond(200, { room_id: testRoomId });
        await Promise.all([
            aliceTestClient.client.createRoom({
                initial_state: [
                    {
                        type: "m.room.encryption",
                        state_key: "",
                        content: { algorithm: "m.megolm.v1.aes-sha2" },
                    },
                ],
            }),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);

        /* The sync arrives in two parts; first the m.room.create... */
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
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
                                    state_key: aliceTestClient.getUserId(),
                                    content: { membership: "join" },
                                    event_id: "$alijoin",
                                },
                            ],
                        },
                    },
                },
            },
        });
        await aliceTestClient.flushSync();

        // ... and then the e2e event and an invite ...
        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
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
                                    content: { membership: "invite" },
                                    event_id: "$otherinvite",
                                },
                            ],
                        },
                    },
                },
            },
        });

        // as soon as the roomMember arrives, try to send a message
        aliceTestClient.client.on(RoomStateEvent.NewMember, (_e, _s, member: RoomMember) => {
            if (member.userId == "@other:user") {
                aliceTestClient.client.sendMessage(testRoomId, { msgtype: "m.text", body: "Hello, World" });
            }
        });

        // flush the sync and wait for the /send/ request.
        aliceTestClient.httpBackend
            .when("PUT", "/send/m.room.encrypted/")
            .respond(200, (_path, _content) => ({ event_id: "asdfgh" }));
        await Promise.all([
            aliceTestClient.flushSync(),
            aliceTestClient.httpBackend.flush("/send/m.room.encrypted/", 1),
        ]);
    });

    describe("Lazy-loading member lists", () => {
        let p2pSession: Olm.Session;

        beforeEach(async () => {
            // set up the aliceTestClient so that it is a room with no known members
            aliceTestClient.expectKeyQuery({ device_keys: { "@alice:localhost": {} }, failures: {} });
            await aliceTestClient.start({ lazyLoadMembers: true });
            aliceTestClient.client.setGlobalErrorOnUnknownDevices(false);

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, getSyncResponse([]));
            await aliceTestClient.flushSync();

            p2pSession = await establishOlmSession(aliceTestClient, testOlmAccount);
        });

        async function expectMembershipRequest(roomId: string, members: string[]): Promise<void> {
            const membersPath = `/rooms/${encodeURIComponent(roomId)}/members?not_membership=leave`;
            aliceTestClient.httpBackend.when("GET", membersPath).respond(200, {
                chunk: [
                    testUtils.mkMembershipCustom({
                        membership: "join",
                        sender: "@bob:xyz",
                    }),
                ],
            });
            await aliceTestClient.httpBackend.flush(membersPath, 1);
        }

        oldBackendOnly("Sending an event initiates a member list sync", async () => {
            // we expect a call to the /members list...
            const memberListPromise = expectMembershipRequest(ROOM_ID, ["@bob:xyz"]);

            // then a request for bob's devices...
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

            // then a to-device with the room_key
            const inboundGroupSessionPromise = expectSendRoomKey(
                aliceTestClient.httpBackend,
                "@bob:xyz",
                testOlmAccount,
                p2pSession,
            );

            // and finally the megolm message
            const megolmMessagePromise = expectSendMegolmMessage(
                aliceTestClient.httpBackend,
                inboundGroupSessionPromise,
            );

            // kick it off
            const sendPromise = aliceTestClient.client.sendTextMessage(ROOM_ID, "test");

            await Promise.all([
                sendPromise,
                megolmMessagePromise,
                memberListPromise,
                aliceTestClient.httpBackend.flush("/keys/query", 1),
            ]);
        });

        oldBackendOnly("loading the membership list inhibits a later load", async () => {
            const room = aliceTestClient.client.getRoom(ROOM_ID)!;
            await Promise.all([room.loadMembersIfNeeded(), expectMembershipRequest(ROOM_ID, ["@bob:xyz"])]);

            // expect a request for bob's devices...
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, getTestKeysQueryResponse("@bob:xyz"));

            // then a to-device with the room_key
            const inboundGroupSessionPromise = expectSendRoomKey(
                aliceTestClient.httpBackend,
                "@bob:xyz",
                testOlmAccount,
                p2pSession,
            );

            // and finally the megolm message
            const megolmMessagePromise = expectSendMegolmMessage(
                aliceTestClient.httpBackend,
                inboundGroupSessionPromise,
            );

            // kick it off
            const sendPromise = aliceTestClient.client.sendTextMessage(ROOM_ID, "test");

            await Promise.all([sendPromise, megolmMessagePromise, aliceTestClient.httpBackend.flush("/keys/query", 1)]);
        });
    });

    describe("m.room_key.withheld handling", () => {
        // TODO: there are a bunch more tests for this sort of thing in spec/unit/crypto/algorithms/megolm.spec.ts.
        //   They should be converted to integ tests and moved.

        oldBackendOnly("does not block decryption on an 'm.unavailable' report", async function () {
            await aliceTestClient.start();

            // there may be a key downloads for alice
            aliceTestClient.httpBackend.when("POST", "/keys/query").respond(200, {});
            aliceTestClient.httpBackend.flush("/keys/query", 1, 5000);

            // encrypt a message with a group session.
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();
            const messageEncryptedEvent = encryptMegolmEvent({
                senderKey: testSenderKey,
                groupSession: groupSession,
                room_id: ROOM_ID,
            });

            // Alice gets the room message, but not the key
            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
                next_batch: 1,
                rooms: {
                    join: { [ROOM_ID]: { timeline: { events: [messageEncryptedEvent] } } },
                },
            });
            await aliceTestClient.flushSync();

            // alice will (eventually) send a room-key request
            aliceTestClient.httpBackend.when("PUT", "/sendToDevice/m.room_key_request/").respond(200, {});
            await aliceTestClient.httpBackend.flush("/sendToDevice/m.room_key_request/", 1, 1000);

            // at this point, the message should be a decryption failure
            const room = aliceTestClient.client.getRoom(ROOM_ID)!;
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.isDecryptionFailure()).toBeTruthy();

            // we want to wait for the message to be updated, so create a promise for it
            const retryPromise = new Promise((resolve) => {
                event.once(MatrixEventEvent.Decrypted, (ev) => {
                    resolve(ev);
                });
            });

            // alice gets back a room-key-withheld notification
            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, {
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
            await aliceTestClient.flushSync();

            // the withheld notification should trigger a retry; wait for it
            await retryPromise;

            // finally: the message should still be a regular decryption failure, not a withheld notification.
            expect(event.getContent().body).not.toContain("withheld");
        });
    });
});
