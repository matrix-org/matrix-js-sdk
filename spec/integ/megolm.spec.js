/*
Copyright 2016 OpenMarket Ltd

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

"use strict";

import 'source-map-support/register';

let Olm = null;
try {
    Olm = require('olm');
} catch (e) {}

const anotherjson = require('another-json');
const q = require('q');
import expect from 'expect';

const sdk = require('../..');
const utils = require('../../lib/utils');
const testUtils = require('../test-utils');
const TestClient = require('../TestClient').default;

const ROOM_ID = "!room:id";

/**
 * start an Olm session with a given recipient
 *
 * @param {Olm.Account} olmAccount
 * @param {TestClient} recipientTestClient
 * @return {Promise} promise for Olm.Session
 */
function createOlmSession(olmAccount, recipientTestClient) {
    return recipientTestClient.awaitOneTimeKeyUpload().then((keys) => {
        const otkId = utils.keys(keys)[0];
        const otk = keys[otkId];

        const session = new Olm.Session();
        session.create_outbound(
            olmAccount, recipientTestClient.getDeviceKey(), otk.key,
        );
        return session;
    });
}

/**
 * encrypt an event with olm
 *
 * @param {object} opts
 * @param {string=} opts.sender
 * @param {string} opts.senderKey
 * @param {Olm.Session} opts.p2pSession
 * @param {TestClient} opts.recipient
 * @param {object=} opts.plaincontent
 * @param {string=} opts.plaintype
 *
 * @return {object} event
 */
function encryptOlmEvent(opts) {
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

    const event = {
        content: {
            algorithm: 'm.olm.v1.curve25519-aes-sha2',
            ciphertext: {},
            sender_key: opts.senderKey,
        },
        sender: opts.sender || '@bob:xyz',
        type: 'm.room.encrypted',
    };
    event.content.ciphertext[opts.recipient.getDeviceKey()] =
        opts.p2pSession.encrypt(JSON.stringify(plaintext));
    return event;
}

/**
 * encrypt an event with megolm
 *
 * @param {object} opts
 * @param {string} opts.senderKey
 * @param {Olm.OutboundGroupSession} opts.groupSession
 * @param {object=} opts.plaintext
 * @param {string=} opts.room_id
 *
 * @return {object} event
 */
function encryptMegolmEvent(opts) {
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

/**
 * build an encrypted room_key event to share a group session
 *
 * @param {object} opts
 * @param {string} opts.senderKey
 * @param {TestClient} opts.recipient
 * @param {Olm.Session} opts.p2pSession
 * @param {Olm.OutboundGroupSession} opts.groupSession
 * @param {string=} opts.room_id
 *
 * @return {object} event
 */
function encryptGroupSessionKey(opts) {
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

/**
 * get a /sync response which contains a single room (ROOM_ID),
 * with the members given
 *
 * @param {string[]} roomMembers
 *
 * @return {object} event
 */
function getSyncResponse(roomMembers) {
    const roomResponse = {
        state: {
            events: [
                testUtils.mkEvent({
                    type: 'm.room.encryption',
                    skey: '',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                    },
                }),
            ],
        },
    };

    for (let i = 0; i < roomMembers.length; i++) {
        roomResponse.state.events.push(
            testUtils.mkMembership({
                mship: 'join',
                sender: roomMembers[i],
            }),
        );
    }

    const syncResponse = {
        next_batch: 1,
        rooms: {
            join: {},
        },
    };
    syncResponse.rooms.join[ROOM_ID] = roomResponse;
    return syncResponse;
}


describe("megolm", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    let testOlmAccount;
    let testSenderKey;
    let aliceTestClient;

    /**
     * Get the device keys for testOlmAccount in a format suitable for a
     * response to /keys/query
     *
     * @param {string} userId The user ID to query for
     * @returns {Object} The fake query response
     */
    function getTestKeysQueryResponse(userId) {
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        const testDeviceKeys = {
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
        testDeviceKeys.signatures = {};
        testDeviceKeys.signatures[userId] = {
            'ed25519:DEVICE_ID': sig,
        };

        const queryResponse = {
            device_keys: {},
        };

        queryResponse.device_keys[userId] = {
            'DEVICE_ID': testDeviceKeys,
        };

        return queryResponse;
    }

    /**
     * Get a one-time key for testOlmAccount in a format suitable for a
     * response to /keys/claim

     * @param {string} userId The user ID to query for
     * @returns {Object} The fake key claim response
     */
    function getTestKeysClaimResponse(userId) {
        testOlmAccount.generate_one_time_keys(1);
        const testOneTimeKeys = JSON.parse(testOlmAccount.one_time_keys());
        testOlmAccount.mark_keys_as_published();

        const keyId = utils.keys(testOneTimeKeys.curve25519)[0];
        const oneTimeKey = testOneTimeKeys.curve25519[keyId];
        const keyResult = {
            'key': oneTimeKey,
        };
        const j = anotherjson.stringify(keyResult);
        const sig = testOlmAccount.sign(j);
        keyResult.signatures = {};
        keyResult.signatures[userId] = {
            'ed25519:DEVICE_ID': sig,
        };

        const claimResponse = {one_time_keys: {}};
        claimResponse.one_time_keys[userId] = {
            'DEVICE_ID': {},
        };
        claimResponse.one_time_keys[userId].DEVICE_ID['signed_curve25519:' + keyId] =
            keyResult;
        return claimResponse;
    }

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        aliceTestClient = new TestClient(
            "@alice:localhost", "xzcvb", "akjgkrgjs",
        );

        testOlmAccount = new Olm.Account();
        testOlmAccount.create();
        const testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        testSenderKey = testE2eKeys.curve25519;
    });

    afterEach(function() {
        aliceTestClient.stop();
    });

    it("Alice receives a megolm message", function(done) {
        return aliceTestClient.start().then(() => {
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((p2pSession) => {
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
            const syncResponse = {
                next_batch: 1,
                to_device: {
                    events: [roomKeyEncrypted],
                },
                rooms: {
                    join: {},
                },
            };
            syncResponse.rooms.join[ROOM_ID] = {
                timeline: {
                    events: [messageEncrypted],
                },
            };

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush("/sync", 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        }).nodeify(done);
    });

    it("Alice receives a megolm message before the session keys", function(done) {
        // https://github.com/vector-im/riot-web/issues/2273
        let roomKeyEncrypted;

        return aliceTestClient.start().then(() => {
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((p2pSession) => {
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

            // make the room_key event, but don't send it yet
            roomKeyEncrypted = encryptGroupSessionKey({
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
            const syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {},
                },
            };
            syncResponse.rooms.join[ROOM_ID] = {
                timeline: {
                    events: [messageEncrypted],
                },
            };

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush("/sync", 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().msgtype).toEqual('m.bad.encrypted');

            // now she gets the room_key event
            const syncResponse = {
                next_batch: 2,
                to_device: {
                    events: [roomKeyEncrypted],
                },
            };

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush("/sync", 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        }).nodeify(done);
    });

    it("Alice gets a second room_key message", function(done) {
        return aliceTestClient.start().then(() => {
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((p2pSession) => {
            const groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

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
                    join: {},
                },
            };
            syncResponse2.rooms.join[ROOM_ID] = {
                timeline: {
                    events: [messageEncrypted],
                },
            };
            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse2);

            return aliceTestClient.httpBackend.flush("/sync", 2);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        }).nodeify(done);
    });

    it('Alice sends a megolm message', function(done) {
        let p2pSession;

        return aliceTestClient.start().then(() => {
            // establish an olm session with alice
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((_p2pSession) => {
            p2pSession = _p2pSession;

            const syncResponse = getSyncResponse(['@bob:xyz']);

            const olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };

            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            // start out with the device unknown - the send should be rejected.
            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz'),
            );

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test').then(() => {
                    throw new Error("sendTextMessage failed on an unknown device");
                }, (e) => {
                    expect(e.name).toEqual("UnknownDeviceError");
                }),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).then(function() {
            // mark the device as known, and resend.
            aliceTestClient.client.setDeviceKnown('@bob:xyz', 'DEVICE_ID');

            let inboundGroupSession;
            aliceTestClient.httpBackend.when(
                'PUT', '/sendToDevice/m.room.encrypted/',
            ).respond(200, function(path, content) {
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
            ).respond(200, function(path, content) {
                const ct = content.ciphertext;
                const r = inboundGroupSession.decrypt(ct);
                console.log('Decrypted received megolm message', r);

                expect(r.message_index).toEqual(0);
                const decrypted = JSON.parse(r.plaintext);
                expect(decrypted.type).toEqual('m.room.message');
                expect(decrypted.content.body).toEqual('test');

                return {
                    event_id: '$event_id',
                };
            });

            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const pendingMsg = room.getPendingEvents()[0];

            return q.all([
                aliceTestClient.client.resendEvent(pendingMsg, room),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).nodeify(done);
    });

    it("Alice shouldn't do a second /query for non-e2e-capable devices", function(done) {
        return aliceTestClient.start().then(function() {
            const syncResponse = getSyncResponse(['@bob:xyz']);
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            console.log("Forcing alice to download our device keys");

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(200, {
                device_keys: {
                    '@bob:xyz': {},
                },
            });

            return q.all([
                aliceTestClient.client.downloadKeys(['@bob:xyz']),
                aliceTestClient.httpBackend.flush('/keys/query', 1),
            ]);
        }).then(function() {
            console.log("Telling alice to send a megolm message");

            aliceTestClient.httpBackend.when(
                'PUT', '/send/',
            ).respond(200, {
                    event_id: '$event_id',
            });

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).nodeify(done);
    });


    it("We shouldn't attempt to send to blocked devices", function(done) {
        return aliceTestClient.start().then(() => {
            // establish an olm session with alice
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((p2pSession) => {
            const syncResponse = getSyncResponse(['@bob:xyz']);

            const olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            console.log('Forcing alice to download our device keys');

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz'),
            );

            return q.all([
                aliceTestClient.client.downloadKeys(['@bob:xyz']),
                aliceTestClient.httpBackend.flush('/keys/query', 1),
            ]);
        }).then(function() {
            console.log('Telling alice to block our device');
            aliceTestClient.client.setDeviceBlocked('@bob:xyz', 'DEVICE_ID');

            console.log('Telling alice to send a megolm message');
            aliceTestClient.httpBackend.when(
                'PUT', '/send/',
            ).respond(200, {
                event_id: '$event_id',
            });

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).nodeify(done);
    });

    it("We should start a new megolm session when a device is blocked", function(done) {
        let p2pSession;
        let megolmSessionId;

        return aliceTestClient.start().then(() => {
            // establish an olm session with alice
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((_p2pSession) => {
            p2pSession = _p2pSession;

            const syncResponse = getSyncResponse(['@bob:xyz']);

            const olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            console.log("Fetching bob's devices and marking known");

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz'),
            );

            return q.all([
                aliceTestClient.client.downloadKeys(['@bob:xyz']),
                aliceTestClient.httpBackend.flush(),
            ]).then((keys) => {
                aliceTestClient.client.setDeviceKnown('@bob:xyz', 'DEVICE_ID');
            });
        }).then(function() {
            console.log('Telling alice to send a megolm message');

            aliceTestClient.httpBackend.when(
                'PUT', '/sendToDevice/m.room.encrypted/',
            ).respond(200, function(path, content) {
                console.log('sendToDevice: ', content);
                const m = content.messages['@bob:xyz'].DEVICE_ID;
                const ct = m.ciphertext[testSenderKey];
                expect(ct.type).toEqual(1); // normal message
                const decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));
                console.log('decrypted sendToDevice:', decrypted);
                expect(decrypted.type).toEqual('m.room_key');
                megolmSessionId = decrypted.content.session_id;
                return {};
            });

            aliceTestClient.httpBackend.when(
                'PUT', '/send/',
            ).respond(200, function(path, content) {
                console.log('/send:', content);
                expect(content.session_id).toEqual(megolmSessionId);
                return {
                    event_id: '$event_id',
                };
            });

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).then(function() {
            console.log('Telling alice to block our device');
            aliceTestClient.client.setDeviceBlocked('@bob:xyz', 'DEVICE_ID');

            console.log('Telling alice to send another megolm message');
            aliceTestClient.httpBackend.when(
                'PUT', '/send/',
            ).respond(200, function(path, content) {
                console.log('/send:', content);
                expect(content.session_id).toNotEqual(megolmSessionId);
                return {
                    event_id: '$event_id',
                };
            });

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test2'),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).nodeify(done);
    });

    // https://github.com/vector-im/riot-web/issues/2676
    it("Alice should send to her other devices", function(done) {
        // for this test, we make the testOlmAccount be another of Alice's devices.
        // it ought to get included in messages Alice sends.

        let p2pSession;
        let inboundGroupSession;
        let decrypted;

        return aliceTestClient.start().then(function() {
            // an encrypted room with just alice
            const syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {},
                },
            };
            syncResponse.rooms.join[ROOM_ID] = {
                state: {
                    events: [
                        testUtils.mkEvent({
                            type: 'm.room.encryption',
                            skey: '',
                            content: {
                                algorithm: 'm.megolm.v1.aes-sha2',
                            },
                        }),
                        testUtils.mkMembership({
                            mship: 'join',
                            sender: aliceTestClient.userId,
                        }),
                    ],
                },
            };
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            // the completion of the first initialsync hould make Alice
            // invalidate the device cache for all members in e2e rooms (ie,
            // herself), and do a key query.
            aliceTestClient.expectKeyQuery(
                getTestKeysQueryResponse(aliceTestClient.userId),
            );

            return aliceTestClient.httpBackend.flush();
        }).then(function() {
            // start out with the device unknown - the send should be rejected.
            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test').then(() => {
                    throw new Error("sendTextMessage failed on an unknown device");
                }, (e) => {
                    expect(e.name).toEqual("UnknownDeviceError");
                    expect(Object.keys(e.devices)).toEqual([aliceTestClient.userId]);
                    expect(Object.keys(e.devices[aliceTestClient.userId])).
                        toEqual(['DEVICE_ID']);
                }),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).then(function() {
            // mark the device as known, and resend.
            aliceTestClient.client.setDeviceKnown(aliceTestClient.userId, 'DEVICE_ID');
            aliceTestClient.httpBackend.when('POST', '/keys/claim').respond(
                200, function(path, content) {
                expect(content.one_time_keys[aliceTestClient.userId].DEVICE_ID)
                    .toEqual("signed_curve25519");
                return getTestKeysClaimResponse(aliceTestClient.userId);
            });

            aliceTestClient.httpBackend.when(
                'PUT', '/sendToDevice/m.room.encrypted/',
            ).respond(200, function(path, content) {
                console.log("sendToDevice: ", content);
                const m = content.messages[aliceTestClient.userId].DEVICE_ID;
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

            aliceTestClient.httpBackend.when(
                'PUT', '/send/',
            ).respond(200, function(path, content) {
                const ct = content.ciphertext;
                const r = inboundGroupSession.decrypt(ct);
                console.log('Decrypted received megolm message', r);
                decrypted = JSON.parse(r.plaintext);

                return {
                    event_id: '$event_id',
                };
            });

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).then(function() {
            expect(decrypted.type).toEqual('m.room.message');
            expect(decrypted.content.body).toEqual('test');
        }).nodeify(done);
    });


    it('Alice should wait for device list to complete when sending a megolm message',
    function(done) {
        let p2pSession;
        let inboundGroupSession;

        let downloadPromise;
        let sendPromise;

        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room.encrypted/',
        ).respond(200, function(path, content) {
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
        ).respond(200, function(path, content) {
            const ct = content.ciphertext;
            const r = inboundGroupSession.decrypt(ct);
            console.log('Decrypted received megolm message', r);

            expect(r.message_index).toEqual(0);
            const decrypted = JSON.parse(r.plaintext);
            expect(decrypted.type).toEqual('m.room.message');
            expect(decrypted.content.body).toEqual('test');

            return {
                event_id: '$event_id',
            };
        });

        return aliceTestClient.start().then(() => {
            // establish an olm session with alice
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((p2pSession) => {
            const syncResponse = getSyncResponse(['@bob:xyz']);

            const olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };

            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            console.log('Forcing alice to download our device keys');

            // this will block
            downloadPromise = aliceTestClient.client.downloadKeys(['@bob:xyz']);

            // so will this.
            sendPromise = aliceTestClient.client.sendTextMessage(ROOM_ID, 'test')
            .then(() => {
                throw new Error("sendTextMessage failed on an unknown device");
            }, (e) => {
                expect(e.name).toEqual("UnknownDeviceError");
            });

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz'),
            );

            return aliceTestClient.httpBackend.flush();
        }).then(function() {
            return q.all([downloadPromise, sendPromise]);
        }).nodeify(done);
    });


    it("We should not get confused by out-of-order device query responses",
       () => {
           // https://github.com/vector-im/riot-web/issues/3126
           return aliceTestClient.start().then(() => {
               aliceTestClient.httpBackend.when('GET', '/sync').respond(
                   200, getSyncResponse(['@bob:xyz', '@chris:abc']));
               return aliceTestClient.httpBackend.flush('/sync', 1);
           }).then(() => {
               return testUtils.syncPromise(aliceTestClient.client);
           }).then(() => {
               // to make sure the initial device queries are flushed out, we
               // attempt to send a message.

               aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                   200, {
                       device_keys: {
                           '@bob:xyz': {},
                           '@chris:abc': {},
                       },
                   },
               );

               aliceTestClient.httpBackend.when('PUT', '/send/').respond(
                   200, {event_id: '$event1'});

               return q.all([
                   aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),
                   aliceTestClient.httpBackend.flush('/keys/query', 1).then(
                       () => aliceTestClient.httpBackend.flush('/send/', 1, 20),
                   ),
               ]);
           }).then(() => {
               expect(aliceTestClient.storage.getEndToEndDeviceSyncToken()).toEqual(1);

               // invalidate bob's and chris's device lists in separate syncs
               aliceTestClient.httpBackend.when('GET', '/sync').respond(200, {
                   next_batch: '2',
                   device_lists: {
                       changed: ['@bob:xyz'],
                   },
               });
               aliceTestClient.httpBackend.when('GET', '/sync').respond(200, {
                   next_batch: '3',
                   device_lists: {
                       changed: ['@chris:abc'],
                   },
               });
               return aliceTestClient.httpBackend.flush('/sync', 2);
           }).then(() => {
               return testUtils.syncPromise(aliceTestClient.client);
           }).then(() => {
               // check that we don't yet have a request for chris's devices.
               aliceTestClient.httpBackend.when('POST', '/keys/query', {
                   device_keys: {
                       '@chris:abc': {},
                   },
                   token: '3',
               }).respond(200, {
                   device_keys: {'@chris:abc': {}},
               });
               return aliceTestClient.httpBackend.flush('/keys/query', 1);
           }).then((flushed) => {
               expect(flushed).toEqual(0);
               const bobStat = aliceTestClient.storage
                     .getEndToEndDeviceTrackingStatus()['@bob:xyz'];
               if (bobStat != 1 && bobStat != 2) {
                   throw new Error('Unexpected status for bob: wanted 1 or 2, got ' +
                                   bobStat);
               }

               const chrisStat = aliceTestClient.storage
                     .getEndToEndDeviceTrackingStatus()['@chris:abc'];
               if (chrisStat != 1 && chrisStat != 2) {
                   throw new Error('Unexpected status for chris: wanted 1 or 2, got ' +
                                   bobStat);
               }

               // now add an expectation for a query for bob's devices, and let
               // it complete.
               aliceTestClient.httpBackend.when('POST', '/keys/query', {
                   device_keys: {
                       '@bob:xyz': {},
                   },
                   token: '2',
               }).respond(200, {
                   device_keys: {'@bob:xyz': {}},
               });
               return aliceTestClient.httpBackend.flush('/keys/query', 1);
           }).then((flushed) => {
               expect(flushed).toEqual(1);

               // wait for the client to stop processing the response
               return aliceTestClient.client.downloadKeys(['@bob:xyz']);
           }).then(() => {
               const bobStat = aliceTestClient.storage
                     .getEndToEndDeviceTrackingStatus()['@bob:xyz'];
               expect(bobStat).toEqual(3);
               const chrisStat = aliceTestClient.storage
                     .getEndToEndDeviceTrackingStatus()['@chris:abc'];
               if (chrisStat != 1 && chrisStat != 2) {
                   throw new Error('Unexpected status for chris: wanted 1 or 2, got ' +
                                   bobStat);
               }

               // now let the query for chris's devices complete.
               return aliceTestClient.httpBackend.flush('/keys/query', 1);
           }).then((flushed) => {
               expect(flushed).toEqual(1);

               // wait for the client to stop processing the response
               return aliceTestClient.client.downloadKeys(['@chris:abc']);
           }).then(() => {
               const bobStat = aliceTestClient.storage
                     .getEndToEndDeviceTrackingStatus()['@bob:xyz'];
               const chrisStat = aliceTestClient.storage
                     .getEndToEndDeviceTrackingStatus()['@chris:abc'];

               expect(bobStat).toEqual(3);
               expect(chrisStat).toEqual(3);
               expect(aliceTestClient.storage.getEndToEndDeviceSyncToken()).toEqual(3);
           });
       });

    it("Alice exports megolm keys and imports them to a new device", function(done) {
        let messageEncrypted;

        return aliceTestClient.start().then(() => {
            // establish an olm session with alice
            return createOlmSession(testOlmAccount, aliceTestClient);
        }).then((p2pSession) => {
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
            messageEncrypted = encryptMegolmEvent({
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
                    join: {},
                },
            };
            syncResponse.rooms.join[ROOM_ID] = {
                timeline: {
                    events: [messageEncrypted],
                },
            };

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush("/sync", 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');

            return aliceTestClient.client.exportRoomKeys();
        }).then(function(exported) {
            // start a new client
            aliceTestClient.stop();

            aliceTestClient = new TestClient(
                "@alice:localhost", "device2", "access_token2",
            );

            aliceTestClient.client.importRoomKeys(exported);

            return aliceTestClient.start();
        }).then(function() {
            const syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {},
                },
            };
            syncResponse.rooms.join[ROOM_ID] = {
                timeline: {
                    events: [messageEncrypted],
                },
            };

            aliceTestClient.httpBackend.when("GET", "/sync").respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush("/sync", 1);
        }).then(function() {
            return testUtils.syncPromise(aliceTestClient.client);
        }).then(function() {
            const room = aliceTestClient.client.getRoom(ROOM_ID);
            const event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        }).nodeify(done);
    });
});
