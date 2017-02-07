/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

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

/* This file consists of a set of integration tests which try to simulate
 * communication via an Olm-encrypted room between two users, Alice and Bob.
 *
 * Note that megolm (group) conversation is not tested here.
 *
 * See also `megolm.spec.js`.
 */

"use strict";
import 'source-map-support/register';
const sdk = require("../..");
const q = require("q");
const utils = require("../../lib/utils");
const testUtils = require("../test-utils");
const TestClient = require('../TestClient').default;

let aliTestClient;
const roomId = "!room:localhost";
const aliUserId = "@ali:localhost";
const aliDeviceId = "zxcvb";
const aliAccessToken = "aseukfgwef";
let bobTestClient;
const bobUserId = "@bob:localhost";
const bobDeviceId = "bvcxz";
const bobAccessToken = "fewgfkuesa";
let aliMessages;
let bobMessages;


function bobUploadsKeys() {
    bobTestClient.expectKeyUpload();
    return q.all([
        bobTestClient.client.uploadKeys(5),
        bobTestClient.httpBackend.flush(),
    ]).then(() => {
        expect(Object.keys(bobTestClient.oneTimeKeys).length).toEqual(5);
        expect(bobTestClient.deviceKeys).not.toEqual({});
    });
}

/**
 * Set an expectation that ali will query bobs keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function expectAliQueryKeys() {
    // can't query keys before bob has uploaded them
    expect(bobTestClient.deviceKeys).toBeTruthy();

    const bobKeys = {};
    bobKeys[bobDeviceId] = bobTestClient.deviceKeys;
    aliTestClient.httpBackend.when("POST", "/keys/query")
            .respond(200, function(path, content) {
        expect(content.device_keys[bobUserId]).toEqual({});
        const result = {};
        result[bobUserId] = bobKeys;
        return {device_keys: result};
    });
    return aliTestClient.httpBackend.flush("/keys/query", 1);
}

/**
 * Set an expectation that bob will query alis keys; then flush the http request.
 *
 * @return {promise} which resolves once the http request has completed.
 */
function expectBobQueryKeys() {
    // can't query keys before ali has uploaded them
    expect(aliTestClient.deviceKeys).toBeTruthy();

    const aliKeys = {};
    aliKeys[aliDeviceId] = aliTestClient.deviceKeys;
    console.log("query result will be", aliKeys);

    bobTestClient.httpBackend.when(
        "POST", "/keys/query",
    ).respond(200, function(path, content) {
        expect(content.device_keys[aliUserId]).toEqual({});
        const result = {};
        result[aliUserId] = aliKeys;
        return {device_keys: result};
    });
    return bobTestClient.httpBackend.flush("/keys/query", 1);
}

/**
 * Set an expectation that ali will claim one of bob's keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function expectAliClaimKeys() {
    // can't query keys before bob has uploaded them
    expect(bobTestClient.oneTimeKeys).not.toEqual({});

    aliTestClient.httpBackend.when(
        "POST", "/keys/claim",
    ).respond(200, function(path, content) {
        const claimType = content.one_time_keys[bobUserId][bobDeviceId];
        expect(claimType).toEqual("signed_curve25519");
        let keyId = null;
        for (keyId in bobTestClient.oneTimeKeys) {
            if (bobTestClient.oneTimeKeys.hasOwnProperty(keyId)) {
                if (keyId.indexOf(claimType + ":") === 0) {
                    break;
                }
            }
        }
        const result = {};
        result[bobUserId] = {};
        result[bobUserId][bobDeviceId] = {};
        result[bobUserId][bobDeviceId][keyId] = bobTestClient.oneTimeKeys[keyId];
        return {one_time_keys: result};
    });

    return aliTestClient.httpBackend.flush("/keys/claim", 1);
}


function aliDownloadsKeys() {
    // can't query keys before bob has uploaded them
    expect(bobTestClient.getSigningKey()).toBeDefined();

    const p1 = aliTestClient.client.downloadKeys([bobUserId]).then(function() {
        expect(aliTestClient.client.listDeviceKeys(bobUserId)).toEqual([{
            id: "bvcxz",
            key: bobTestClient.getSigningKey(),
            verified: false,
            blocked: false,
            display_name: null,
        }]);
    });
    const p2 = expectAliQueryKeys();

    // check that the localStorage is updated as we expect (not sure this is
    // an integration test, but meh)
    return q.all([p1, p2]).then(function() {
        const devices = aliTestClient.storage.getEndToEndDevicesForUser(bobUserId);
        expect(devices[bobDeviceId].keys).toEqual(bobTestClient.deviceKeys.keys);
        expect(devices[bobDeviceId].verified).
            toBe(0); // DeviceVerification.UNVERIFIED
    });
}

function aliEnablesEncryption() {
    return aliTestClient.client.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function() {
        expect(aliTestClient.client.isRoomEncrypted(roomId)).toBeTruthy();
    });
}

function bobEnablesEncryption() {
    return bobTestClient.client.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function() {
       expect(bobTestClient.client.isRoomEncrypted(roomId)).toBeTruthy();
    });
}

/**
 * Ali sends a message, first claiming e2e keys. Set the expectations and
 * check the results.
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function aliSendsFirstMessage() {
    return q.all([
        sendMessage(aliTestClient.client),
        expectAliQueryKeys()
            .then(expectAliClaimKeys)
            .then(expectAliSendMessageRequest),
    ]).spread(function(_, ciphertext) {
        return ciphertext;
    });
}

/**
 * Ali sends a message without first claiming e2e keys. Set the expectations
 * and check the results.
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function aliSendsMessage() {
    return q.all([
        sendMessage(aliTestClient.client),
        expectAliSendMessageRequest(),
    ]).spread(function(_, ciphertext) {
        return ciphertext;
    });
}

/**
 * Bob sends a message, first querying (but not claiming) e2e keys. Set the
 * expectations and check the results.
 *
 * @return {promise} which resolves to the ciphertext for Ali's device.
 */
function bobSendsReplyMessage() {
    return q.all([
        sendMessage(bobTestClient.client),
        expectBobQueryKeys()
            .then(expectBobSendMessageRequest),
    ]).spread(function(_, ciphertext) {
        return ciphertext;
    });
}

/**
 * Set an expectation that Ali will send a message, and flush the request
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function expectAliSendMessageRequest() {
    return expectSendMessageRequest(aliTestClient.httpBackend).then(function(content) {
        aliMessages.push(content);
        expect(utils.keys(content.ciphertext)).toEqual([bobTestClient.getDeviceKey()]);
        const ciphertext = content.ciphertext[bobTestClient.getDeviceKey()];
        expect(ciphertext).toBeDefined();
        return ciphertext;
    });
}

/**
 * Set an expectation that Bob will send a message, and flush the request
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function expectBobSendMessageRequest() {
    return expectSendMessageRequest(bobTestClient.httpBackend).then(function(content) {
        bobMessages.push(content);
        const aliKeyId = "curve25519:" + aliDeviceId;
        const aliDeviceCurve25519Key = aliTestClient.deviceKeys.keys[aliKeyId];
        expect(utils.keys(content.ciphertext)).toEqual([aliDeviceCurve25519Key]);
        const ciphertext = content.ciphertext[aliDeviceCurve25519Key];
        expect(ciphertext).toBeDefined();
        return ciphertext;
    });
}

function sendMessage(client) {
    return client.sendMessage(
        roomId, {msgtype: "m.text", body: "Hello, World"},
    );
}

function expectSendMessageRequest(httpBackend) {
    const path = "/send/m.room.encrypted/";
    let sent;
    httpBackend.when("PUT", path).respond(200, function(path, content) {
        sent = content;
        return {
            event_id: "asdfgh",
        };
    });
    return httpBackend.flush(path, 1).then(function() {
        return sent;
    });
}

function aliRecvMessage() {
    const message = bobMessages.shift();
    return recvMessage(
        aliTestClient.httpBackend, aliTestClient.client, bobUserId, message,
    );
}

function bobRecvMessage() {
    const message = aliMessages.shift();
    return recvMessage(
        bobTestClient.httpBackend, bobTestClient.client, aliUserId, message,
    );
}

function recvMessage(httpBackend, client, sender, message) {
    const syncData = {
        next_batch: "x",
        rooms: {
            join: {

            },
        },
    };
    syncData.rooms.join[roomId] = {
        timeline: {
            events: [
                testUtils.mkEvent({
                    type: "m.room.encrypted",
                    room: roomId,
                    content: message,
                    sender: sender,
                }),
            ],
        },
    };
    httpBackend.when("GET", "/sync").respond(200, syncData);
    const deferred = q.defer();
    const onEvent = function(event) {
        console.log(client.credentials.userId + " received event",
                    event);

        // ignore the m.room.member events
        if (event.getType() == "m.room.member") {
            return;
        }

        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent()).toEqual({
            msgtype: "m.text",
            body: "Hello, World",
        });
        expect(event.isEncrypted()).toBeTruthy();

        client.removeListener("event", onEvent);
        deferred.resolve();
    };

    client.on("event", onEvent);

    httpBackend.flush();
    return deferred.promise;
}


/**
 * Set http responses for the requests which are made when a client starts, and
 * start the client.
 *
 * @param {TestClient} testClient
 * @returns {Promise} which resolves when the client has done its initial requests
 */
function startClient(testClient) {
    // send a sync response including our test room.
    const syncData = {
        next_batch: "x",
        rooms: {
            join: { },
        },
    };
    syncData.rooms.join[roomId] = {
        state: {
            events: [
                testUtils.mkMembership({
                    mship: "join",
                    user: aliUserId,
                }),
                testUtils.mkMembership({
                    mship: "join",
                    user: bobUserId,
                }),
            ],
        },
        timeline: {
            events: [],
        },
    };
    testClient.httpBackend.when("GET", "/sync").respond(200, syncData);
    return testClient.start();
}


describe("MatrixClient crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        aliTestClient = new TestClient(aliUserId, aliDeviceId, aliAccessToken);
        bobTestClient = new TestClient(bobUserId, bobDeviceId, bobAccessToken);

        aliMessages = [];
        bobMessages = [];
    });

    afterEach(function() {
        aliTestClient.stop();
        bobTestClient.stop();
    });

    it('Ali knows the difference between a new user and one with no devices',
        function(done) {
            aliTestClient.httpBackend.when('POST', '/keys/query').respond(200, {
                device_keys: {
                    '@bob:id': {},
                },
            });

            const p1 = aliTestClient.client.downloadKeys(['@bob:id']);
            const p2 = aliTestClient.httpBackend.flush('/keys/query', 1);

            q.all([p1, p2]).then(function() {
                const devices = aliTestClient.storage.getEndToEndDevicesForUser(
                    '@bob:id',
                );
                expect(utils.keys(devices).length).toEqual(0);

                // request again: should be no more requests
                return aliTestClient.client.downloadKeys(['@bob:id']);
            }).nodeify(done);
        },
    );

    it("Bob uploads without one-time keys and with one-time keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .catch(testUtils.failTest).done(done);
    });

    it("Ali downloads Bobs keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .catch(testUtils.failTest).done(done);
    });

    it("Ali gets keys with an invalid signature", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(function() {
                // tamper bob's keys
                const bobDeviceKeys = bobTestClient.deviceKeys;
                expect(bobDeviceKeys.keys["curve25519:" + bobDeviceId]).toBeDefined();
                bobDeviceKeys.keys["curve25519:" + bobDeviceId] += "abc";

                return q.all(aliTestClient.client.downloadKeys([bobUserId]),
                             expectAliQueryKeys());
            })
            .then(function() {
                // should get an empty list
                expect(aliTestClient.client.listDeviceKeys(bobUserId)).toEqual([]);
            })
            .catch(testUtils.failTest).done(done);
    });

    it("Ali gets keys with an incorrect userId", function(done) {
        const eveUserId = "@eve:localhost";

        const bobDeviceKeys = {
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            device_id: 'bvcxz',
            keys: {
                'ed25519:bvcxz': 'pYuWKMCVuaDLRTM/eWuB8OlXEb61gZhfLVJ+Y54tl0Q',
                'curve25519:bvcxz': '7Gni0loo/nzF0nFp9847RbhElGewzwUXHPrljjBGPTQ',
            },
            user_id: '@eve:localhost',
            signatures: {
                '@eve:localhost': {
                    'ed25519:bvcxz': 'CliUPZ7dyVPBxvhSA1d+X+LYa5b2AYdjcTwG' +
                        '0stXcIxjaJNemQqtdgwKDtBFl3pN2I13SEijRDCf1A8bYiQMDg',
                },
            },
        };

        const bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        aliTestClient.httpBackend.when(
            "POST", "/keys/query",
        ).respond(200, function(path, content) {
            const result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });

        q.all(
            aliTestClient.client.downloadKeys([bobUserId, eveUserId]),
            aliTestClient.httpBackend.flush("/keys/query", 1),
        ).then(function() {
            // should get an empty list
            expect(aliTestClient.client.listDeviceKeys(bobUserId)).toEqual([]);
            expect(aliTestClient.client.listDeviceKeys(eveUserId)).toEqual([]);
        }).catch(testUtils.failTest).done(done);
    });

    it("Ali gets keys with an incorrect deviceId", function(done) {
        const bobDeviceKeys = {
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            device_id: 'bad_device',
            keys: {
                'ed25519:bad_device': 'e8XlY5V8x2yJcwa5xpSzeC/QVOrU+D5qBgyTK0ko+f0',
                'curve25519:bad_device': 'YxuuLG/4L5xGeP8XPl5h0d7DzyYVcof7J7do+OXz0xc',
            },
            user_id: '@bob:localhost',
            signatures: {
                '@bob:localhost': {
                    'ed25519:bad_device': 'fEFTq67RaSoIEVBJ8DtmRovbwUBKJ0A' +
                        'me9m9PDzM9azPUwZ38Xvf6vv1A7W1PSafH4z3Y2ORIyEnZgHaNby3CQ',
                },
            },
        };

        const bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        aliTestClient.httpBackend.when(
            "POST", "/keys/query",
        ).respond(200, function(path, content) {
            const result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });

        q.all(
            aliTestClient.client.downloadKeys([bobUserId]),
            aliTestClient.httpBackend.flush("/keys/query", 1),
        ).then(function() {
            // should get an empty list
            expect(aliTestClient.client.listDeviceKeys(bobUserId)).toEqual([]);
        }).catch(testUtils.failTest).done(done);
    });

    it("Ali enables encryption", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(aliEnablesEncryption)
            .catch(testUtils.failTest).done(done);
    });

    it("Ali sends a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .catch(testUtils.failTest).nodeify(done);
    });

    it("Bob receives a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(() => startClient(bobTestClient))
            .then(bobRecvMessage)
            .catch(testUtils.failTest).done(done);
    });

    it("Bob receives a message with a bogus sender", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(() => startClient(bobTestClient))
            .then(function() {
                const message = aliMessages.shift();
                const syncData = {
                    next_batch: "x",
                    rooms: {
                        join: {

                        },
                    },
                };
                syncData.rooms.join[roomId] = {
                    timeline: {
                        events: [
                            testUtils.mkEvent({
                                type: "m.room.encrypted",
                                room: roomId,
                                content: message,
                                sender: "@bogus:sender",
                            }),
                        ],
                    },
                };
                bobTestClient.httpBackend.when("GET", "/sync").respond(200, syncData);

                const deferred = q.defer();
                const onEvent = function(event) {
                    console.log(bobUserId + " received event",
                                event);

                    // ignore the m.room.member events
                    if (event.getType() == "m.room.member") {
                        return;
                    }

                    expect(event.getType()).toEqual("m.room.message");
                    expect(event.getContent().msgtype).toEqual("m.bad.encrypted");
                    expect(event.isEncrypted()).toBeTruthy();

                    bobTestClient.client.removeListener("event", onEvent);
                    deferred.resolve();
                };

                bobTestClient.client.on("event", onEvent);

                bobTestClient.httpBackend.flush();
                return deferred.promise;
            })
            .catch(testUtils.failTest).done(done);
    });

    it("Ali blocks Bob's device", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(aliEnablesEncryption)
            .then(aliDownloadsKeys)
            .then(function() {
                aliTestClient.client.setDeviceBlocked(bobUserId, bobDeviceId, true);
                const p1 = sendMessage(aliTestClient.client);
                const p2 = expectAliQueryKeys()
                    .then(expectAliClaimKeys)
                    .then(function() {
                        return expectSendMessageRequest(aliTestClient.httpBackend);
                    }).then(function(sentContent) {
                        // no unblocked devices, so the ciphertext should be empty
                        expect(sentContent.ciphertext).toEqual({});
                    });
                return q.all([p1, p2]);
            }).catch(testUtils.failTest).nodeify(done);
    });

    it("Bob receives two pre-key messages", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(() => startClient(bobTestClient))
            .then(bobRecvMessage)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(testUtils.failTest).done(done);
    });

    it("Bob replies to the message", function(done) {
        q()
            .then(() => startClient(aliTestClient))
            .then(() => startClient(bobTestClient))
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobRecvMessage)
            .then(bobEnablesEncryption)
            .then(bobSendsReplyMessage).then(function(ciphertext) {
                expect(ciphertext.type).toEqual(1);
            }).then(aliRecvMessage)
            .catch(testUtils.failTest).done(done);
    });


    it("Ali does a key query when she gets a new_device event", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(() => startClient(aliTestClient))
            .then(function() {
                const syncData = {
                    next_batch: '2',
                    to_device: {
                        events: [
                            testUtils.mkEvent({
                                content: {
                                    device_id: 'TEST_DEVICE',
                                    rooms: [],
                                },
                                sender: bobUserId,
                                type: 'm.new_device',
                            }),
                        ],
                    },
                };
                aliTestClient.httpBackend.when('GET', '/sync').respond(200, syncData);
                return aliTestClient.httpBackend.flush('/sync', 1);
            }).then(expectAliQueryKeys)
            .nodeify(done);
    });
});
