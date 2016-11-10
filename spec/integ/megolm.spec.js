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

var sdk = require('../..');
var utils = require('../../lib/utils');
var test_utils = require('../test-utils');
var MockHttpBackend = require('../mock-request');

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
 * @return {Promise}
 */
TestClient.prototype.start = function() {
    var self = this;
    this.httpBackend.when("GET", "/pushrules").respond(200, {});
    this.httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
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
 * @param {string} opts.recipientKey
 * @param {Olm.Session} opts.p2pSession
 * @param {object} opts.plaintext
 *
 * @return {object} event
 */
function encryptOlmEvent(opts) {
    expect(opts.senderKey).toBeDefined();
    expect(opts.p2pSession).toBeDefined();
    expect(opts.plaintext).toBeDefined();
    expect(opts.recipientKey).toBeDefined();

    var event = {
        content: {
            algorithm: "m.olm.v1.curve25519-aes-sha2",
            ciphertext: {},
            sender_key: opts.senderKey,
        },
        sender: opts.sender || "@bob:xyz",
        type: "m.room.encrypted",
    };
    event.content.ciphertext[opts.recipientKey] =
        opts.p2pSession.encrypt(JSON.stringify(opts.plaintext));
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
 * @param {string} opts.recipientKey
 * @param {Olm.Session} opts.p2pSession
 * @param {Olm.OutboundGroupSession} opts.groupSession
 * @param {string=} opts.room_id
 *
 * @return {object} event
 */
function encryptGroupSessionKey(opts) {
    return encryptOlmEvent({
        senderKey: opts.senderKey,
        recipientKey: opts.recipientKey,
        p2pSession: opts.p2pSession,
        plaintext: {
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                room_id: opts.room_id,
                session_id: opts.groupSession.session_id(),
                session_key: opts.groupSession.session_key(),
            },
            type: "m.room_key",
        },
    });
}

describe("megolm", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    var ROOM_ID = "!room:id";

    var testOlmAccount;
    var testSenderKey;
    var aliceTestClient;

    beforeEach(test_utils.asyncTest(function() {
        test_utils.beforeEach(this);

        aliceTestClient = new TestClient(
            "@alice:localhost", "xzcvb", "akjgkrgjs"
        );

        testOlmAccount = new Olm.Account();
        testOlmAccount.create();
        var testE2eKeys = JSON.parse(testOlmAccount.identity_keys());
        testSenderKey = testE2eKeys.curve25519;

        return aliceTestClient.start();
    }));

    afterEach(function() {
        aliceTestClient.stop();
    });

    it("Alice receives a megolm message", test_utils.asyncTest(function() {
        var p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

        var groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        var roomKeyEncrypted = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipientKey: aliceTestClient.getDeviceKey(),
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
        return aliceTestClient.httpBackend.flush("/sync", 1).then(function() {
            var room = aliceTestClient.client.getRoom(ROOM_ID);
            var event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        });
    }));

    it("Alice gets a second room_key message", test_utils.asyncTest(function() {
        var p2pSession = createOlmSession(testOlmAccount, aliceTestClient);

        var groupSession = new Olm.OutboundGroupSession();
        groupSession.create();

        // make the room_key event
        var roomKeyEncrypted1 = encryptGroupSessionKey({
            senderKey: testSenderKey,
            recipientKey: aliceTestClient.getDeviceKey(),
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
            recipientKey: aliceTestClient.getDeviceKey(),
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

        return aliceTestClient.httpBackend.flush("/sync", 2).then(function() {
            var room = aliceTestClient.client.getRoom(ROOM_ID);
            var event = room.getLiveTimeline().getEvents()[0];
            expect(event.getContent().body).toEqual('42');
        });

    }));
});
