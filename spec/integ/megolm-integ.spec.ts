/*
Copyright 2016 OpenMarket Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import * as testUtils from "../test-utils/test-utils";
import { TestClient } from "../TestClient";
import { logger } from "../../src/logger";
import {
    IContent,
    IEvent,
    IClaimOTKsResult,
    IJoinedRoom,
    ISyncResponse,
    IDownloadKeyResult,
    MatrixEvent,
    MatrixEventEvent,
    IndexedDBCryptoStore,
    Room,
} from "../../src/matrix";
import { IDeviceKeys } from "../../src/crypto/dehydration";
import { DeviceInfo } from "../../src/crypto/deviceinfo";

const ROOM_ID = "!room:id";

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

// encrypt an event with olm
function encryptOlmEvent(opts: {
    sender?: string;
    senderKey: string;
    p2pSession: Olm.Session;
    recipient: TestClient;
    plaincontent?: object;
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
        sender: opts.sender || '@bob:xyz',
        type: opts.plaintype || 'm.test',
    };

    return {
        content: {
            algorithm: 'm.olm.v1.curve25519-aes-sha2',
            ciphertext: {
                [opts.recipient.getDeviceKey()]: opts.p2pSession.encrypt(JSON.stringify(plaintext)),
            },
            sender_key: opts.senderKey,
        },
        sender: opts.sender || '@bob:xyz',
        type: 'm.room.encrypted',
    };
}

// encrypt an event with megolm
function encryptMegolmEvent(opts: {
    senderKey: string;
    groupSession: Olm.OutboundGroupSession;
    plaintext?: Partial<IEvent>;
    room_id?: string;
}): Pick<IEvent, "event_id" | "content" | "type"> {
    expect(opts.senderKey).toBeTruthy();
    expect(opts.groupSession).toBeTruthy();

    const plaintext = opts.plaintext || {};
    if (!plaintext.content) {
        plaintext.content = {
            body: '42',
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

    return {
        event_id: 'test_megolm_event_' + Math.random(),
        content: {
            algorithm: "m.megolm.v1.aes-sha2",
            ciphertext: opts.groupSession.encrypt(JSON.stringify(plaintext)),
            device_id: "testDevice",
            sender_key: opts.senderKey,
            session_id: opts.groupSession.session_id(),
        },
        type: "m.room.encrypted",
    };
}

// build an encrypted room_key event to share a group session
function encryptGroupSessionKey(opts: {
    senderKey: string;
    recipient: TestClient;
    p2pSession: Olm.Session;
    groupSession: Olm.OutboundGroupSession;
    room_id?: string;
}): Partial<IEvent> {
    return encryptOlmEvent({
        senderKey: opts.senderKey,
        recipient: opts.recipient,
        p2pSession: opts.p2pSession,
        plaincontent: {
            algorithm: 'm.megolm.v1.aes-sha2',
            room_id: opts.room_id,
            session_id: opts.groupSession.session_id(),
            session_key: opts.groupSession.session_key(),
        },
        plaintype: 'm.room_key',
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
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                    },
                }),
            ],
        },
        timeline: {
            events: [],
            prev_batch: '',
        },
        ephemeral: { events: [] },
        account_data: { events: [] },
        unread_notifications: {},
    };

    for (let i = 0; i < roomMembers.length; i++) {
        roomResponse.state.events.push(
            testUtils.mkMembershipCustom({
                membership: 'join',
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

describe("megolm", () => {
    if (!global.Olm) {
        logger.warn('not running megolm tests: Olm not present');
        return;
    }
    const Olm = global.Olm;

    let testOlmAccount = {} as unknown as Olm.Account;
    let testSenderKey = '';
    let aliceTestClient = new TestClient(
        "@alice:localhost", "device2", "access_token2",
    );

    /**
     * Get the device keys for testOlmAccount in a format suitable for a
     * response to /keys/query
     *
     * @param {string} userId The user ID to query for
     * @returns {IDownloadKeyResult} The fake query response
     */
    function getTestKeysQueryResponse(userId: string): IDownloadKeyResult {
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        const testDeviceKeys: IDeviceKeys = {
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            device_id: 'DEVICE_ID',
            keys: {
                'curve25519:DEVICE_ID': testE2eKeys.curve25519,
                'ed25519:DEVICE_ID': testE2eKeys.ed25519,
            },
            user_id: userId,
        };
        const j = anotherjson.stringify(testDeviceKeys);
        const sig = testOlmAccount.sign(j);
        testDeviceKeys.signatures = { [userId]: { 'ed25519:DEVICE_ID': sig } };

        return {
            device_keys: { [userId]: { 'DEVICE_ID': testDeviceKeys } },
            failures: {},
        };
    }

    /**
     * Get a one-time key for testOlmAccount in a format suitable for a
     * response to /keys/claim

     * @param {string} userId The user ID to query for
     * @returns {IClaimOTKsResult} The fake key claim response
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
            signatures: { [userId]: { 'ed25519:DEVICE_ID': sig } },
        };

        return {
            one_time_keys: { [userId]: { 'DEVICE_ID': { ['signed_curve25519:' + keyId]: keyResult } } },
            failures: {},
        };
    }

    beforeEach(async () => {
        aliceTestClient = new TestClient(
            "@alice:localhost", "xzcvb", "akjgkrgjs",
        );
        await aliceTestClient.client.initCrypto();

        testOlmAccount = new Olm.Account();
        testOlmAccount.create();
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        testSenderKey = testE2eKeys.curve25519;
    });

    afterEach(() => aliceTestClient.stop());

    it("Alice receives a megolm message", async () => {
        await aliceTestClient.start();
        aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
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
        const decryptedEvent = await testUtils.awaitDecryption(event);
        expect(decryptedEvent.getContent().body).toEqual('42');
    });

    it("Alice receives a megolm message before the session keys", async () => {
        // https://github.com/vector-im/element-web/issues/2273
        await aliceTestClient.start();
        aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

        // make the room_key event, but don't send it yet
        const roomKeyEncrypted = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
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
        expect(room.getLiveTimeline().getEvents()[0].getContent().msgtype).toEqual('m.bad.encrypted');

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
        if (event.getContent().msgtype != 'm.bad.encrypted') {
            decryptedEvent = event;
        } else {
            decryptedEvent = await new Promise<MatrixEvent>((resolve) => {
                event.once(MatrixEventEvent.Decrypted, (ev) => {
                    logger.log(`${Date.now()} event ${event.getId()} now decrypted`);
                    resolve(ev);
                });
            });
        }
        expect(decryptedEvent.getContent().body).toEqual('42');
    });

    it("Alice gets a second room_key message", async () => {
        await aliceTestClient.start();
        aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

        // make the room_key event
        const roomKeyEncrypted1 = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
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
            senderKey: testSenderKey,
            recipient: aliceTestClient,
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
        expect(event.getContent().body).toEqual('42');
    });

    it('Alice sends a megolm message', async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { '@alice:localhost': {} }, failures: {} });
        await aliceTestClient.start();
        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);

        const syncResponse = getSyncResponse(['@bob:xyz']);

        const olmEvent = encryptOlmEvent({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
            p2pSession: p2pSession,
        });

        syncResponse.to_device = { events: [olmEvent] };

        aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);
        await aliceTestClient.flushSync();

        // start out with the device unknown - the send should be rejected.
        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );
        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, 'test').then(() => {
                throw new Error("sendTextMessage failed on an unknown device");
            }, (e) => {
                expect(e.name).toEqual("UnknownDeviceError");
            }),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);

        // mark the device as known, and resend.
        aliceTestClient.client.setDeviceKnown('@bob:xyz', 'DEVICE_ID');

        let inboundGroupSession: Olm.InboundGroupSession;
        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room.encrypted/',
        ).respond(200, function(_path, content: any) {
            const m = content.messages['@bob:xyz'].DEVICE_ID;
            const ct = m.ciphertext[testSenderKey];
            const decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));

            expect(decrypted.type).toEqual('m.room_key');
            inboundGroupSession = new Olm.InboundGroupSession();
            inboundGroupSession.create(decrypted.content.session_key);
            return {};
        });

        aliceTestClient.httpBackend.when(
            'PUT', '/send/',
        ).respond(200, (_path, content: IContent) => {
            const ct = content.ciphertext;
            const r: any = inboundGroupSession.decrypt(ct);
            logger.log('Decrypted received megolm message', r);

            expect(r.message_index).toEqual(0);
            const decrypted = JSON.parse(r.plaintext);
            expect(decrypted.type).toEqual('m.room.message');
            expect(decrypted.content.body).toEqual('test');

            return { event_id: '$event_id' };
        });

        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        const pendingMsg = room.getPendingEvents()[0];

        await Promise.all([
            aliceTestClient.client.resendEvent(pendingMsg, room),

            // the crypto stuff can take a while, so give the requests a whole second.
            aliceTestClient.httpBackend.flushAllExpected({ timeout: 1000 }),
        ]);
    });

    it("We shouldn't attempt to send to blocked devices", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { '@alice:localhost': {} }, failures: {} });
        await aliceTestClient.start();
        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const syncResponse = getSyncResponse(['@bob:xyz']);

        const olmEvent = encryptOlmEvent({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
            p2pSession: p2pSession,
        });

        syncResponse.to_device = { events: [olmEvent] };
        aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

        await aliceTestClient.flushSync();

        logger.log('Forcing alice to download our device keys');

        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );
        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );

        await Promise.all([
            aliceTestClient.client.downloadKeys(['@bob:xyz']),
            aliceTestClient.httpBackend.flush('/keys/query', 2),
        ]);

        logger.log('Telling alice to block our device');
        aliceTestClient.client.setDeviceBlocked('@bob:xyz', 'DEVICE_ID');

        logger.log('Telling alice to send a megolm message');
        aliceTestClient.httpBackend.when(
            'PUT', '/send/',
        ).respond(200, {
            event_id: '$event_id',
        });
        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room_key.withheld/',
        ).respond(200, {});

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),

            // the crypto stuff can take a while, so give the requests a whole second.
            aliceTestClient.httpBackend.flushAllExpected({ timeout: 1000 }),
        ]);
    });

    it("We should start a new megolm session when a device is blocked", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { '@alice:localhost': {} }, failures: {} });
        await aliceTestClient.start();
        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);

        const syncResponse = getSyncResponse(['@bob:xyz']);

        const olmEvent = encryptOlmEvent({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
            p2pSession: p2pSession,
        });

        syncResponse.to_device = { events: [olmEvent] };
        aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

        await aliceTestClient.flushSync();

        logger.log("Fetching bob's devices and marking known");

        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );
        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );

        await Promise.all([
            aliceTestClient.client.downloadKeys(['@bob:xyz']),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);
        await aliceTestClient.client.setDeviceKnown('@bob:xyz', 'DEVICE_ID');

        logger.log('Telling alice to send a megolm message');

        let megolmSessionId: string;
        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room.encrypted/',
        ).respond(200, function(_path, content: any) {
            logger.log('sendToDevice: ', content);
            const m = content.messages['@bob:xyz'].DEVICE_ID;
            const ct = m.ciphertext[testSenderKey];
            expect(ct.type).toEqual(1); // normal message
            const decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));
            logger.log('decrypted sendToDevice:', decrypted);
            expect(decrypted.type).toEqual('m.room_key');
            megolmSessionId = decrypted.content.session_id;
            return {};
        });

        aliceTestClient.httpBackend.when(
            'PUT', '/send/',
        ).respond(200, function(_path, content) {
            logger.log('/send:', content);
            expect(content.session_id).toEqual(megolmSessionId);
            return {
                event_id: '$event_id',
            };
        });

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),

            // the crypto stuff can take a while, so give the requests a whole second.
            aliceTestClient.httpBackend.flushAllExpected({ timeout: 1000 }),
        ]);

        logger.log('Telling alice to block our device');
        aliceTestClient.client.setDeviceBlocked('@bob:xyz', 'DEVICE_ID');

        logger.log('Telling alice to send another megolm message');
        aliceTestClient.httpBackend.when(
            'PUT', '/send/',
        ).respond(200, function(_path, content) {
            logger.log('/send:', content);
            expect(content.session_id).not.toEqual(megolmSessionId);
            return {
                event_id: '$event_id',
            };
        });
        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room_key.withheld/',
        ).respond(200, {});

        await Promise.all([
            aliceTestClient.client.sendTextMessage(ROOM_ID, 'test2'),
            aliceTestClient.httpBackend.flushAllExpected(),
        ]);
    });

    // https://github.com/vector-im/element-web/issues/2676
    it("Alice should send to her other devices", async () => {
        // for this test, we make the testOlmAccount be another of Alice's devices.
        // it ought to get included in messages Alice sends.
        await aliceTestClient.start();
        // an encrypted room with just alice
        const syncResponse = {
            next_batch: 1,
            rooms: { join: { [ROOM_ID]: { state: { events: [
                testUtils.mkEvent({
                    type: 'm.room.encryption',
                    skey: '',
                    content: { algorithm: 'm.megolm.v1.aes-sha2' },
                }),
                testUtils.mkMembership({
                    mship: 'join',
                    sender: aliceTestClient.userId,
                }),
            ] } } } },
        };
        aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

        // the completion of the first initialsync should make Alice
        // invalidate the device cache for all members in e2e rooms (ie,
        // herself), and do a key query.
        aliceTestClient.expectKeyQuery(
            getTestKeysQueryResponse(aliceTestClient.userId!),
        );

        await aliceTestClient.httpBackend.flushAllExpected();

        // start out with the device unknown - the send should be rejected.
        try {
            await aliceTestClient.client.sendTextMessage(ROOM_ID, 'test');
            throw new Error("sendTextMessage succeeded on an unknown device");
        } catch (e) {
            expect((e as any).name).toEqual("UnknownDeviceError");
            expect(Object.keys((e as any).devices)).toEqual([aliceTestClient.userId!]);
            expect(Object.keys((e as any)?.devices[aliceTestClient.userId!])).
                toEqual(['DEVICE_ID']);
        }

        // mark the device as known, and resend.
        aliceTestClient.client.setDeviceKnown(aliceTestClient.userId!, 'DEVICE_ID');
        aliceTestClient.httpBackend.when('POST', '/keys/claim').respond(
            200, function(_path, content: IClaimOTKsResult) {
                expect(content.one_time_keys[aliceTestClient.userId!].DEVICE_ID)
                    .toEqual("signed_curve25519");
                return getTestKeysClaimResponse(aliceTestClient.userId!);
            });

        let p2pSession: Olm.Session;
        let inboundGroupSession: Olm.InboundGroupSession;
        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room.encrypted/',
        ).respond(200, function(_path, content: {
            messages: { [userId: string]: { [deviceId: string]: Record<string, any> }};
        }) {
            logger.log("sendToDevice: ", content);
            const m = content.messages[aliceTestClient.userId!].DEVICE_ID;
            const ct = m.ciphertext[testSenderKey];
            expect(ct.type).toEqual(0); // pre-key message

            p2pSession = new Olm.Session();
            p2pSession.create_inbound(testOlmAccount, ct.body);
            const decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));

            expect(decrypted.type).toEqual('m.room_key');
            inboundGroupSession = new Olm.InboundGroupSession();
            inboundGroupSession.create(decrypted.content.session_key);
            return {};
        });

        let decrypted: Partial<IEvent> = {};
        aliceTestClient.httpBackend.when(
            'PUT', '/send/',
        ).respond(200, function(_path, content: IContent) {
            const ct = content.ciphertext;
            const r: any = inboundGroupSession.decrypt(ct);
            logger.log('Decrypted received megolm message', r);
            decrypted = JSON.parse(r.plaintext);

            return {
                event_id: '$event_id',
            };
        });

        // Grab the event that we'll need to resend
        const room = aliceTestClient.client.getRoom(ROOM_ID)!;
        const pendingEvents = room.getPendingEvents();
        expect(pendingEvents.length).toEqual(1);
        const unsentEvent = pendingEvents[0];

        await Promise.all([
            aliceTestClient.client.resendEvent(unsentEvent, room),

            // the crypto stuff can take a while, so give the requests a whole second.
            aliceTestClient.httpBackend.flushAllExpected({
                timeout: 1000,
            }),
        ]);

        expect(decrypted.type).toEqual('m.room.message');
        expect(decrypted.content?.body).toEqual('test');
    });

    it('Alice should wait for device list to complete when sending a megolm message', async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { '@alice:localhost': {} }, failures: {} });
        await aliceTestClient.start();
        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);

        const syncResponse = getSyncResponse(['@bob:xyz']);

        const olmEvent = encryptOlmEvent({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
            p2pSession: p2pSession,
        });

        syncResponse.to_device = { events: [olmEvent] };

        aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);
        await aliceTestClient.flushSync();

        // this will block
        logger.log('Forcing alice to download our device keys');
        const downloadPromise = aliceTestClient.client.downloadKeys(['@bob:xyz']);

        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );

        // so will this.
        const sendPromise = aliceTestClient.client.sendTextMessage(ROOM_ID, 'test')
            .then(() => {
                throw new Error("sendTextMessage failed on an unknown device");
            }, (e) => {
                expect(e.name).toEqual("UnknownDeviceError");
            });

        aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
            200, getTestKeysQueryResponse('@bob:xyz'),
        );

        await aliceTestClient.httpBackend.flushAllExpected();
        await Promise.all([downloadPromise, sendPromise]);
    });

    it("Alice exports megolm keys and imports them to a new device", async () => {
        aliceTestClient.expectKeyQuery({ device_keys: { '@alice:localhost': {} }, failures: {} });
        await aliceTestClient.start();
        aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
        // establish an olm session with alice
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);

        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
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
        expect(room.getLiveTimeline().getEvents()[0].getContent().body).toEqual('42');

        const exported = await aliceTestClient.client.exportRoomKeys();

        // start a new client
        aliceTestClient.stop();

        aliceTestClient = new TestClient(
            "@alice:localhost", "device2", "access_token2",
        );
        await aliceTestClient.client.initCrypto();
        await aliceTestClient.client.importRoomKeys(exported);
        await aliceTestClient.start();

        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

        const syncResponse = {
            next_batch: 1,
            rooms: {
                join: { [ROOM_ID]: { timeline: { events: [messageEncrypted] } } },
            },
        };

        aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
        await aliceTestClient.flushSync();

        const event = room.getLiveTimeline().getEvents()[0];
        expect(event.getContent().body).toEqual('42');
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
        const keys = [{
            room_id: ROOM_ID,
            algorithm: 'm.megolm.v1.aes-sha2',
            session_id: groupSession.session_id(),
            session_key: inboundGroupSession.export_session(0),
            sender_key: testSenderKey,
            forwarding_curve25519_key_chain: [],
            sender_claimed_keys: {},
        }];
        await testClient.client.importRoomKeys(keys, { untrusted: true });

        const event1 = testUtils.mkEvent({
            event: true,
            ...rawEvent,
            room: ROOM_ID,
        });
        await event1.attemptDecryption(testClient.client.crypto!, { isRetry: true });
        expect(event1.isKeySourceUntrusted()).toBeTruthy();

        const event2 = testUtils.mkEvent({
            type: 'm.room_key',
            content: {
                room_id: ROOM_ID,
                algorithm: 'm.megolm.v1.aes-sha2',
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
        aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
        const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
        const groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

        // make the room_key event
        const roomKeyEncrypted = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipient: aliceTestClient,
            p2pSession: p2pSession,
            groupSession: groupSession,
            room_id: ROOM_ID,
        });

        const plaintext = {
            type: "m.room.message",
            content: undefined,
            room_id: ROOM_ID,
        };

        const messageEncrypted = {
            event_id: 'test_megolm_event',
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                ciphertext: groupSession.encrypt(JSON.stringify(plaintext)),
                device_id: "testDevice",
                sender_key: testSenderKey,
                session_id: groupSession.session_id(),
            },
            type: "m.room.encrypted",
        };

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
        const decryptedEvent = await testUtils.awaitDecryption(event);
        expect(decryptedEvent.getRoomId()).toEqual(ROOM_ID);
        expect(decryptedEvent.getContent()).toEqual({});
        expect(decryptedEvent.getClearContent()).toBeUndefined();
    });

    it(
        "should successfully decrypt bundled redaction events that don't include a room_id in their /sync data",
        async () => {
            await aliceTestClient.start();
            aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
            const p2pSession = await createOlmSession(testOlmAccount, aliceTestClient);
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

            aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => "@bob:xyz";

            // make the room_key event
            const roomKeyEncrypted = encryptGroupSessionKey({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
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

            const redactionEncrypted = encryptMegolmEvent({
                senderKey: testSenderKey,
                groupSession: groupSession,
                plaintext: {
                    room_id: ROOM_ID,
                    type: "m.room.redaction",
                    redacts: messageEncrypted.event_id,
                    content: { reason: "redaction test" },
                },
            });

            const messageEncryptedWithRedaction = {
                ...messageEncrypted,
                unsigned: { redacted_because: redactionEncrypted },
            };

            const syncResponse = {
                next_batch: 1,
                to_device: {
                    events: [roomKeyEncrypted],
                },
                rooms: {
                    join: {
                        [ROOM_ID]: { timeline: { events: [messageEncryptedWithRedaction] } },
                    },
                },
            };

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
            await aliceTestClient.flushSync();

            const room = aliceTestClient.client.getRoom(ROOM_ID)!;
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.isEncrypted()).toBe(true);
            await event.attemptDecryption(aliceTestClient.client.crypto!);
            expect(event.getContent()).toEqual({});
            const redactionEvent: any = event.getRedactionEvent();
            expect(redactionEvent.content.reason).toEqual("redaction test");
        },
    );

    it("Alice receives shared history before being invited to a room by the sharer", async () => {
        const beccaTestClient = new TestClient(
            "@becca:localhost", "foobar", "bazquux",
        );
        await beccaTestClient.client.initCrypto();

        await aliceTestClient.start();
        aliceTestClient.client.crypto!.deviceList.downloadKeys = () => Promise.resolve({});
        await beccaTestClient.start();

        const beccaRoom = new Room(ROOM_ID, beccaTestClient.client, "@becca:localhost", {});
        beccaTestClient.client.store.storeRoom(beccaRoom);
        await beccaTestClient.client.setRoomEncryption(ROOM_ID, { "algorithm": "m.megolm.v1.aes-sha2" });

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
        aliceTestClient.client.crypto!.deviceList.getUserByIdentityKey = () => beccaTestClient.client.getUserId()!;

        // Create an olm session for Becca and Alice's devices
        const aliceOtks = await aliceTestClient.awaitOneTimeKeyUpload();
        const aliceOtkId = Object.keys(aliceOtks)[0];
        const aliceOtk = aliceOtks[aliceOtkId];
        const p2pSession = new global.Olm.Session();
        await beccaTestClient.client.crypto!.cryptoStore.doTxn(
            'readonly',
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
            recipient: aliceTestClient,
            p2pSession: p2pSession,
            plaincontent: {
                "algorithm": 'm.megolm.v1.aes-sha2',
                "room_id": ROOM_ID,
                "sender_key": content.sender_key,
                "sender_claimed_ed25519_key": groupSessionKey!.sender_claimed_ed25519_key,
                "session_id": content.session_id,
                "session_key": groupSessionKey!.key,
                "chain_index": groupSessionKey!.chain_index,
                "forwarding_curve25519_key_chain": groupSessionKey!.forwarding_curve25519_key_chain,
                "org.matrix.msc3061.shared_history": true,
            },
            plaintype: 'm.forwarded_room_key',
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
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [
                {
                    sender: '@becca:localhost',
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                    },
                },
                {
                    sender: '@becca:localhost',
                    type: 'm.room.member',
                    state_key: '@alice:localhost',
                    content: {
                        membership: 'invite',
                    },
                },
            ] } } } },
        });
        await aliceTestClient.flushSync();

        // Alice has joined the room
        aliceTestClient.httpBackend.when("GET", "/sync").respond(
            200, getSyncResponse(["@alice:localhost", "@becca:localhost"]),
        );
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
        expect(decryptedEvent.getContent().body).toEqual('test message');

        await beccaTestClient.stop();
    });

    it("Alice receives shared history before being invited to a room by someone else", async () => {
        const beccaTestClient = new TestClient(
            "@becca:localhost", "foobar", "bazquux",
        );
        await beccaTestClient.client.initCrypto();

        await aliceTestClient.start();
        await beccaTestClient.start();

        const beccaRoom = new Room(ROOM_ID, beccaTestClient.client, "@becca:localhost", {});
        beccaTestClient.client.store.storeRoom(beccaRoom);
        await beccaTestClient.client.setRoomEncryption(ROOM_ID, { "algorithm": "m.megolm.v1.aes-sha2" });

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
            'readonly',
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
            recipient: aliceTestClient,
            p2pSession: p2pSession,
            plaincontent: {
                "algorithm": 'm.megolm.v1.aes-sha2',
                "room_id": ROOM_ID,
                "sender_key": content.sender_key,
                "sender_claimed_ed25519_key": groupSessionKey!.sender_claimed_ed25519_key,
                "session_id": content.session_id,
                "session_key": groupSessionKey!.key,
                "chain_index": groupSessionKey!.chain_index,
                "forwarding_curve25519_key_chain": groupSessionKey!.forwarding_curve25519_key_chain,
                "org.matrix.msc3061.shared_history": true,
            },
            plaintype: 'm.forwarded_room_key',
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
            rooms: { invite: { [ROOM_ID]: { invite_state: { events: [
                {
                    sender: '@becca:localhost',
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                    },
                },
                {
                    sender: '@charlie:localhost',
                    type: 'm.room.member',
                    state_key: '@alice:localhost',
                    content: {
                        membership: 'invite',
                    },
                },
            ] } } } },
        });
        await aliceTestClient.flushSync();

        // Alice has joined the room
        aliceTestClient.httpBackend.when("GET", "/sync").respond(
            200, getSyncResponse(["@alice:localhost", "@becca:localhost", "@charlie:localhost"]),
        );
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
});
