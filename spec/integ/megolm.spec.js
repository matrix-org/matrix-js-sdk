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


try {
    var Olm = require('olm');
} catch (e) {}

var anotherjson = require('another-json');
var q = require('q');

var sdk = require('../..');
var utils = require('../../lib/utils');
var test_utils = require('../test-utils');
var MockHttpBackend = require('../mock-request');

var ROOM_ID = "!room:id";

/**
 * Wrapper for a MockStorageApi, MockHttpBackend and MatrixClient
 *
 * @constructor
 * @param {string} userId
 * @param {string} deviceId
 * @param {string} accessToken
 */
function TestClient(userId, deviceId, accessToken) {
    this.userId = userId;
    this.deviceId = deviceId;

    this.storage = new sdk.WebStorageSessionStore(new test_utils.MockStorageApi());
    this.httpBackend = new MockHttpBackend();
    this.client = sdk.createClient({
        baseUrl: "http://test.server",
        userId: userId,
        accessToken: accessToken,
        deviceId: deviceId,
        sessionStore: this.storage,
        request: this.httpBackend.requestFn,
    });

    this.deviceKeys = null;
    this.oneTimeKeys = [];
}

/**
 * start the client, and wait for it to initialise.
 *
 * @param {object?} deviceQueryResponse  the list of our existing devices to return from
 *    the /query request. Defaults to empty device list
 * @return {Promise}
 */
TestClient.prototype.start = function(existingDevices) {
    var self = this;

    this.httpBackend.when("GET", "/pushrules").respond(200, {});
    this.httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });

    this.httpBackend.when('POST', '/keys/query').respond(200, function(path, content) {
        expect(content.device_keys[self.userId]).toEqual({});
        var res = existingDevices;
        if (!res) {
            res = { device_keys: {} };
            res.device_keys[self.userId] = {};
        }
        return res;
    });
    this.httpBackend.when("POST", "/keys/upload").respond(200, function(path, content) {
        expect(content.one_time_keys).not.toBeDefined();
        expect(content.device_keys).toBeDefined();
        self.deviceKeys = content.device_keys;
        return {one_time_key_counts: {signed_curve25519: 0}};
    });
    this.httpBackend.when("POST", "/keys/upload").respond(200, function(path, content) {
        expect(content.device_keys).not.toBeDefined();
        expect(content.one_time_keys).toBeDefined();
        expect(content.one_time_keys).not.toEqual({});
        self.oneTimeKeys = content.one_time_keys;
        return {one_time_key_counts: {
            signed_curve25519: utils.keys(self.oneTimeKeys).length
        }};
    });

    this.client.startClient();

    return this.httpBackend.flush();
};

/**
 * stop the client
 */
TestClient.prototype.stop = function() {
    this.client.stopClient();
};

/**
 * get the uploaded curve25519 device key
 *
 * @return {string} base64 device key
 */
TestClient.prototype.getDeviceKey = function() {
    var key_id = 'curve25519:' + this.deviceId;
    return this.deviceKeys.keys[key_id];
};


/**
 * get the uploaded ed25519 device key
 *
 * @return {string} base64 device key
 */
TestClient.prototype.getSigningKey = function() {
    var key_id = 'ed25519:' + this.deviceId;
    return this.deviceKeys.keys[key_id];
};

/**
 * start an Olm session with a given recipient
 *
 * @param {Olm.Account} olmAccount
 * @param {TestClient} recipientTestClient
 * @return {Olm.Session}
 */
function createOlmSession(olmAccount, recipientTestClient) {
    var otk_id = utils.keys(recipientTestClient.oneTimeKeys)[0];
    var otk = recipientTestClient.oneTimeKeys[otk_id];

    var session = new Olm.Session();
    session.create_outbound(
        olmAccount, recipientTestClient.getDeviceKey(), otk.key
    );
    return session;
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
    expect(opts.senderKey).toBeDefined();
    expect(opts.p2pSession).toBeDefined();
    expect(opts.recipient).toBeDefined();

    var plaintext = {
        content: opts.plaincontent || {},
        recipient: opts.recipient.userId,
        recipient_keys: {
            ed25519: opts.recipient.getSigningKey(),
        },
        sender: opts.sender || '@bob:xyz',
        type: opts.plaintype || 'm.test',
    };

    var event = {
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
    expect(opts.senderKey).toBeDefined();
    expect(opts.groupSession).toBeDefined();

    var plaintext = opts.plaintext || {};
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
        expect(opts.room_id).toBeDefined();
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
    var roomResponse = {
        state: {
            events: [
                test_utils.mkEvent({
                    type: 'm.room.encryption',
                    skey: '',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                    },
                }),
            ],
        }
    };

    for (var i = 0; i < roomMembers.length; i++) {
        roomResponse.state.events.push(
            test_utils.mkMembership({
                mship: 'join',
                sender: roomMembers[i],
            })
        );
    }

    var syncResponse = {
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

    var testOlmAccount;
    var testSenderKey;
    var aliceTestClient;

    /**
     * Get the device keys for testOlmAccount in a format suitable for a
     * response to /keys/query
     */
    function getTestKeysQueryResponse(userId) {
        var testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        var testDeviceKeys = {
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            device_id: 'DEVICE_ID',
            keys: {
                'curve25519:DEVICE_ID': testE2eKeys.curve25519,
                'ed25519:DEVICE_ID': testE2eKeys.ed25519,
            },
            user_id: userId,
        };
        var j = anotherjson.stringify(testDeviceKeys);
        var sig = testOlmAccount.sign(j);
        testDeviceKeys.signatures = {};
        testDeviceKeys.signatures[userId] = {
            'ed25519:DEVICE_ID': sig,
        };

        var queryResponse = {
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
     */
    function getTestKeysClaimResponse(userId) {
        testOlmAccount.generate_one_time_keys(1);
        var testOneTimeKeys = JSON.parse(testOlmAccount.one_time_keys());
        testOlmAccount.mark_keys_as_published();

        var keyId = utils.keys(testOneTimeKeys.curve25519)[0];
        var oneTimeKey = testOneTimeKeys.curve25519[keyId];
        var keyResult = {
            'key': oneTimeKey,
        };
        var j = anotherjson.stringify(keyResult);
        var sig = testOlmAccount.sign(j);
        keyResult.signatures = {};
        keyResult.signatures[userId] = {
            'ed25519:DEVICE_ID': sig,
        };

        var claimResponse = {one_time_keys: {}};
        claimResponse.one_time_keys[userId] = {
            'DEVICE_ID': {},
        };
        claimResponse.one_time_keys[userId].DEVICE_ID['signed_curve25519:' + keyId] =
            keyResult;
        return claimResponse;
    }

    beforeEach(function() {
        test_utils.beforeEach(this);

        aliceTestClient = new TestClient(
            "@alice:localhost", "xzcvb", "akjgkrgjs"
        );

        testOlmAccount = new Olm.Account();
        testOlmAccount.create();
        var testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        testSenderKey = testE2eKeys.curve25519;
    });

    afterEach(function() {
        aliceTestClient.stop();
    });

    it("Alice receives a megolm message", function(done) {
        return aliceTestClient.start().then(function() {
            var p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

            var groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

            // make the room_key event
            var roomKeyEncrypted = encryptGroupSessionKey({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
                groupSession: groupSession,
                room_id: ROOM_ID,
            });

            // encrypt a message with the group session
            var messageEncrypted = encryptMegolmEvent({
                senderKey: testSenderKey,
                groupSession: groupSession,
                room_id: ROOM_ID,
            });

            // Alice gets both the events in a single sync
            var syncResponse = {
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
            var room = aliceTestClient.client.getRoom(ROOM_ID);
            var event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        }).nodeify(done);
    });

    it("Alice gets a second room_key message", function(done) {
        return aliceTestClient.start().then(function() {
            var p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

            var groupSession = new Olm.OutboundGroupSession();
            groupSession.create();

            // make the room_key event
            var roomKeyEncrypted1 = encryptGroupSessionKey({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
                groupSession: groupSession,
                room_id: ROOM_ID,
            });

            // encrypt a message with the group session
            var messageEncrypted = encryptMegolmEvent({
                senderKey: testSenderKey,
                groupSession: groupSession,
                room_id: ROOM_ID,
            });

            // make a second room_key event now that we have advanced the group
            // session.
            var roomKeyEncrypted2 = encryptGroupSessionKey({
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
            var syncResponse2 = {
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
            var room = aliceTestClient.client.getRoom(ROOM_ID);
            var event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        }).nodeify(done);
    });

    it('Alice sends a megolm message', function(done) {
        var p2pSession;

        return aliceTestClient.start().then(function() {
            var syncResponse = getSyncResponse(['@bob:xyz']);

            // establish an olm session with alice
            p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

            var olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };

            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            var inboundGroupSession;
            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz')
            );

            aliceTestClient.httpBackend.when(
                'PUT', '/sendToDevice/m.room.encrypted/'
            ).respond(200, function(path, content) {
                var m = content.messages['@bob:xyz'].DEVICE_ID;
                var ct = m.ciphertext[testSenderKey];
                var decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));

                expect(decrypted.type).toEqual('m.room_key');
                inboundGroupSession = new Olm.InboundGroupSession();
                inboundGroupSession.create(decrypted.content.session_key);
                return {};
            });

            aliceTestClient.httpBackend.when(
                'PUT', '/send/'
            ).respond(200, function(path, content) {
                var ct = content.ciphertext;
                var r = inboundGroupSession.decrypt(ct);
                console.log('Decrypted received megolm message', r);

                expect(r.message_index).toEqual(0);
                var decrypted = JSON.parse(r.plaintext);
                expect(decrypted.type).toEqual('m.room.message');
                expect(decrypted.content.body).toEqual('test');

                return {
                    event_id: '$event_id',
                };
            });

            return q.all([
                aliceTestClient.client.sendTextMessage(ROOM_ID, 'test'),
                aliceTestClient.httpBackend.flush(),
            ]);
        }).nodeify(done);
    });

    it("Alice shouldn't do a second /query for non-e2e-capable devices", function(done) {
        return aliceTestClient.start().then(function() {
            var syncResponse = getSyncResponse(['@bob:xyz']);
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            console.log("Forcing alice to download our device keys");

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(200, {
                device_keys: {
                    '@bob:xyz': {},
                }
            });

            return q.all([
                aliceTestClient.client.downloadKeys(['@bob:xyz']),
                aliceTestClient.httpBackend.flush('/keys/query', 1),
            ]);
        }).then(function() {
            console.log("Telling alice to send a megolm message");

            aliceTestClient.httpBackend.when(
                'PUT', '/send/'
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
        return aliceTestClient.start().then(function() {
            var syncResponse = getSyncResponse(['@bob:xyz']);

            // establish an olm session with alice
            var p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

            var olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            console.log('Forcing alice to download our device keys');

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz')
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
                'PUT', '/send/'
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
        var p2pSession;
        var megolmSessionId;

        return aliceTestClient.start().then(function() {
            var syncResponse = getSyncResponse(['@bob:xyz']);

            // establish an olm session with alice
            p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

            var olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            console.log('Telling alice to send a megolm message');

            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz')
            );

            aliceTestClient.httpBackend.when(
                'PUT', '/sendToDevice/m.room.encrypted/'
            ).respond(200, function(path, content) {
                console.log('sendToDevice: ', content);
                var m = content.messages['@bob:xyz'].DEVICE_ID;
                var ct = m.ciphertext[testSenderKey];
                expect(ct.type).toEqual(1); // normal message
                var decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));
                console.log('decrypted sendToDevice:', decrypted);
                expect(decrypted.type).toEqual('m.room_key');
                megolmSessionId = decrypted.content.session_id;
                return {};
            });

            aliceTestClient.httpBackend.when(
                'PUT', '/send/'
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
                'PUT', '/send/'
            ).respond(200, function(path, content) {
                console.log('/send:', content);
                expect(content.session_id).not.toEqual(megolmSessionId);
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
        // it ought to get include in messages Alice sends.

        var p2pSession;
        var inboundGroupSession;
        var decrypted;

        return aliceTestClient.start(
            getTestKeysQueryResponse(aliceTestClient.userId)
        ).then(function() {
            // an encrypted room with just alice
            var syncResponse = {
                next_batch: 1,
                rooms: {
                    join: {},
                },
            };
            syncResponse.rooms.join[ROOM_ID] = {
                state: {
                    events: [
                        test_utils.mkEvent({
                            type: 'm.room.encryption',
                            skey: '',
                            content: {
                                algorithm: 'm.megolm.v1.aes-sha2',
                            },
                        }),
                        test_utils.mkMembership({
                            mship: 'join',
                            sender: aliceTestClient.userId,
                        }),
                    ],
                },
            };
            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);

            return aliceTestClient.httpBackend.flush();
        }).then(function() {
            aliceTestClient.httpBackend.when('POST', '/keys/claim').respond(
                200, function(path, content)
            {
                expect(content.one_time_keys[aliceTestClient.userId].DEVICE_ID)
                    .toEqual("signed_curve25519");
                return getTestKeysClaimResponse(aliceTestClient.userId);
            });

            aliceTestClient.httpBackend.when(
                'PUT', '/sendToDevice/m.room.encrypted/'
            ).respond(200, function(path, content) {
                console.log("sendToDevice: ", content);
                var m = content.messages[aliceTestClient.userId].DEVICE_ID;
                var ct = m.ciphertext[testSenderKey];
                expect(ct.type).toEqual(0); // pre-key message

                p2pSession = new Olm.Session();
                p2pSession.create_inbound(testOlmAccount, ct.body);
                var decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));

                expect(decrypted.type).toEqual('m.room_key');
                inboundGroupSession = new Olm.InboundGroupSession();
                inboundGroupSession.create(decrypted.content.session_key);
                return {};
            });

            aliceTestClient.httpBackend.when(
                'PUT', '/send/'
            ).respond(200, function(path, content) {
                var ct = content.ciphertext;
                var r = inboundGroupSession.decrypt(ct);
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
        var p2pSession;
        var inboundGroupSession;

        var downloadPromise;
        var sendPromise;

        aliceTestClient.httpBackend.when(
            'PUT', '/sendToDevice/m.room.encrypted/'
        ).respond(200, function(path, content) {
            var m = content.messages['@bob:xyz'].DEVICE_ID;
            var ct = m.ciphertext[testSenderKey];
            var decrypted = JSON.parse(p2pSession.decrypt(ct.type, ct.body));

            expect(decrypted.type).toEqual('m.room_key');
            inboundGroupSession = new Olm.InboundGroupSession();
            inboundGroupSession.create(decrypted.content.session_key);
            return {};
        });

        aliceTestClient.httpBackend.when(
            'PUT', '/send/'
        ).respond(200, function(path, content) {
            var ct = content.ciphertext;
            var r = inboundGroupSession.decrypt(ct);
            console.log('Decrypted received megolm message', r);

            expect(r.message_index).toEqual(0);
            var decrypted = JSON.parse(r.plaintext);
            expect(decrypted.type).toEqual('m.room.message');
            expect(decrypted.content.body).toEqual('test');

            return {
                event_id: '$event_id',
            };
        });

        return aliceTestClient.start().then(function() {
            var syncResponse = getSyncResponse(['@bob:xyz']);

            // establish an olm session with alice
            p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

            var olmEvent = encryptOlmEvent({
                senderKey: testSenderKey,
                recipient: aliceTestClient,
                p2pSession: p2pSession,
            });

            syncResponse.to_device = { events: [olmEvent] };

            aliceTestClient.httpBackend.when('GET', '/sync').respond(200, syncResponse);
            return aliceTestClient.httpBackend.flush('/sync', 1);
        }).then(function() {
            console.log('Forcing alice to download our device keys');

            // this will block
            downloadPromise = aliceTestClient.client.downloadKeys(['@bob:xyz']);
        }).then(function() {

            // so will this.
            sendPromise = aliceTestClient.client.sendTextMessage(ROOM_ID, 'test');
        }).then(function() {
            aliceTestClient.httpBackend.when('POST', '/keys/query').respond(
                200, getTestKeysQueryResponse('@bob:xyz')
            );

            return aliceTestClient.httpBackend.flush();
        }).then(function() {
            return q.all([downloadPromise, sendPromise]);
        }).nodeify(done);
    });
});
