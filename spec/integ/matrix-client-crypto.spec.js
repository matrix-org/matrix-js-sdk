"use strict";
var sdk = require("../..");
var q = require("q");
var HttpBackend = require("../mock-request");
var utils = require("../../lib/utils");
var test_utils = require("../test-utils");

function MockStorageApi() {
    this.data = {};
}
MockStorageApi.prototype = {
    setItem: function(k, v) {
        this.data[k] = v;
    },
    getItem: function(k) {
        return this.data[k] || null;
    },
    removeItem: function(k) {
        delete this.data[k];
    }
};

var aliHttpBackend;
var bobHttpBackend;
var aliClient;
var roomId = "!room:localhost";
var aliUserId = "@ali:localhost";
var aliDeviceId = "zxcvb";
var aliAccessToken = "aseukfgwef";
var bobClient;
var bobUserId = "@bob:localhost";
var bobDeviceId = "bvcxz";
var bobAccessToken = "fewgfkuesa";
var bobOneTimeKeys;
var aliDeviceKeys;
var bobDeviceKeys;
var bobDeviceCurve25519Key;
var bobDeviceEd25519Key;
var aliLocalStore;
var aliStorage;
var bobStorage;
var aliMessages;
var bobMessages;


/**
 * Set an expectation that the client will upload device keys and a number of
 * one-time keys; then flush the http requests.
 *
 * @param {string} deviceId expected device id in upload request
 * @param {object} httpBackend
 *
 * @return {promise} completes once the http requests have completed, returning combined
 * {one_time_keys: {}, device_keys: {}}
 */
function expectKeyUpload(deviceId, httpBackend) {
    var uploadPath = "/keys/upload/" + deviceId;
    var keys = {};

    httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
        expect(content.one_time_keys).not.toBeDefined();
        expect(content.device_keys).toBeDefined();
        keys.device_keys = content.device_keys;
        return {one_time_key_counts: {curve25519: 0}};
    });

    httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
        expect(content.device_keys).not.toBeDefined();
        expect(content.one_time_keys).toBeDefined();
        expect(content.one_time_keys).not.toEqual({});
        var count = 0;
        for (var key in content.one_time_keys) {
            if (content.one_time_keys.hasOwnProperty(key)) {
                count++;
            }
        }
        expect(count).toEqual(5);
        keys.one_time_keys = content.one_time_keys;
        return {one_time_key_counts: {curve25519: count}};
    });

    return httpBackend.flush(uploadPath, 2).then(function() {
        return keys;
    });
}


/**
 * Set an expectation that ali will upload device keys and a number of one-time keys;
 * then flush the http requests.
 *
 * <p>Updates <tt>aliDeviceKeys</tt>
 *
 * @return {promise} completes once the http requests have completed.
 */
function expectAliKeyUpload() {
    return expectKeyUpload(aliDeviceId, aliHttpBackend).then(function(content) {
        aliDeviceKeys = content.device_keys;
    });
}


/**
 * Set an expectation that bob will upload device keys and a number of one-time keys;
 * then flush the http requests.
 *
 * <p>Updates <tt>bobDeviceKeys</tt>, <tt>bobOneTimeKeys</tt>,
 * <tt>bobDeviceCurve25519Key</tt>, <tt>bobDeviceEd25519Key</tt>
 *
 * @return {promise} completes once the http requests have completed.
 */
function expectBobKeyUpload() {
    return expectKeyUpload(bobDeviceId, bobHttpBackend).then(function(content) {
        bobDeviceKeys = content.device_keys;
        bobOneTimeKeys = content.one_time_keys;
        expect(bobDeviceKeys).toBeDefined();
        expect(bobOneTimeKeys).toBeDefined();
        bobDeviceCurve25519Key = bobDeviceKeys.keys["curve25519:bvcxz"];
        bobDeviceEd25519Key = bobDeviceKeys.keys["ed25519:bvcxz"];
    });
}

function bobUploadsKeys() {
    bobClient.uploadKeys(5).catch(test_utils.failTest);
    return expectBobKeyUpload();
}


/**
 * Set an expectation that ali will query bobs keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function expectAliQueryKeys() {
    // can't query keys before bob has uploaded them
    expect(bobDeviceKeys).toBeDefined();

    var bobKeys = {};
    bobKeys[bobDeviceId] = bobDeviceKeys;
    aliHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
        expect(content.device_keys[bobUserId]).toEqual({});
        var result = {};
        result[bobUserId] = bobKeys;
        return {device_keys: result};
    });
    return aliHttpBackend.flush("/keys/query", 1);
}

/**
 * Set an expectation that bob will query alis keys; then flush the http request.
 *
 * @return {promise} which resolves once the http request has completed.
 */
function expectBobQueryKeys() {
    // can't query keys before ali has uploaded them
    expect(aliDeviceKeys).toBeDefined();

    var aliKeys = {};
    aliKeys[aliDeviceId] = aliDeviceKeys;
    bobHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
        expect(content.device_keys[aliUserId]).toEqual({});
        var result = {};
        result[aliUserId] = aliKeys;
        return {device_keys: result};
    });
    return bobHttpBackend.flush("/keys/query", 1);
}

/**
 * Set an expectation that ali will claim one of bob's keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function expectAliClaimKeys() {
    // can't query keys before bob has uploaded them
    expect(bobOneTimeKeys).toBeDefined();

    aliHttpBackend.when("POST", "/keys/claim").respond(200, function(path, content) {
        expect(content.one_time_keys[bobUserId][bobDeviceId]).toEqual("curve25519");
        for (var keyId in bobOneTimeKeys) {
            if (bobOneTimeKeys.hasOwnProperty(keyId)) {
                if (keyId.indexOf("curve25519:") === 0) {
                    break;
                }
            }
        }
        var result = {};
        result[bobUserId] = {};
        result[bobUserId][bobDeviceId] = {};
        result[bobUserId][bobDeviceId][keyId] = bobOneTimeKeys[keyId];
        return {one_time_keys: result};
    });

    return aliHttpBackend.flush("/keys/claim", 1);
}


function aliDownloadsKeys() {
    // can't query keys before bob has uploaded them
    expect(bobDeviceEd25519Key).toBeDefined();

    var p1 = aliClient.downloadKeys([bobUserId]).then(function() {
        expect(aliClient.listDeviceKeys(bobUserId)).toEqual([{
            id: "bvcxz",
            key: bobDeviceEd25519Key,
            verified: false,
            blocked: false,
            display_name: null,
        }]);
    });
    var p2 = expectAliQueryKeys();

    // check that the localStorage is updated as we expect (not sure this is
    // an integration test, but meh)
    return q.all([p1, p2]).then(function() {
        var devices = aliStorage.getEndToEndDevicesForUser(bobUserId);
        expect(devices[bobDeviceId].keys).toEqual(bobDeviceKeys.keys);
        expect(devices[bobDeviceId].verified).
            toBe(0); // DeviceVerification.UNVERIFIED
    });
}

function aliEnablesEncryption() {
    return aliClient.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function() {
        expect(aliClient.isRoomEncrypted(roomId)).toBeTruthy();
    });
}

function bobEnablesEncryption() {
    return bobClient.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function() {
       expect(bobClient.isRoomEncrypted(roomId)).toBeTruthy();
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
        sendMessage(aliClient),
        expectAliQueryKeys()
            .then(expectAliClaimKeys)
            .then(expectAliSendMessageRequest)
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
        sendMessage(aliClient),
        expectAliSendMessageRequest()
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
        sendMessage(bobClient),
        expectBobQueryKeys()
            .then(expectBobSendMessageRequest)
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
    return expectSendMessageRequest(aliHttpBackend).then(function(content) {
        aliMessages.push(content);
        expect(utils.keys(content.ciphertext)).toEqual([bobDeviceCurve25519Key]);
        var ciphertext = content.ciphertext[bobDeviceCurve25519Key];
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
    return expectSendMessageRequest(bobHttpBackend).then(function(content) {
        bobMessages.push(content);
        var aliKeyId = "curve25519:" + aliDeviceId;
        var aliDeviceCurve25519Key = aliDeviceKeys.keys[aliKeyId];
        expect(utils.keys(content.ciphertext)).toEqual([aliDeviceCurve25519Key]);
        var ciphertext = content.ciphertext[aliDeviceCurve25519Key];
        expect(ciphertext).toBeDefined();
        return ciphertext;
    });
}

function sendMessage(client) {
    return client.sendMessage(
        roomId, {msgtype: "m.text", body: "Hello, World"}
    );
}

function expectSendMessageRequest(httpBackend) {
    var path = "/send/m.room.encrypted/";
    var sent;
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
    var message = bobMessages.shift();
    return recvMessage(aliHttpBackend, aliClient, bobUserId, message);
}

function bobRecvMessage() {
    var message = aliMessages.shift();
    return recvMessage(bobHttpBackend, bobClient, aliUserId, message);
}

function recvMessage(httpBackend, client, sender, message) {
    var syncData = {
        next_batch: "x",
        rooms: {
            join: {

            }
        }
    };
    syncData.rooms.join[roomId] = {
        timeline: {
            events: [
                test_utils.mkEvent({
                    type: "m.room.encrypted",
                    room: roomId,
                    content: message,
                    sender: sender,
                })
            ]
        }
    };
    httpBackend.when("GET", "/sync").respond(200, syncData);
    var deferred = q.defer();
    var onEvent = function(event) {
        console.log(client.credentials.userId + " received event",
                    event);

        // ignore the m.room.member events
        if (event.getType() == "m.room.member") {
            return;
        }

        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent()).toEqual({
            msgtype: "m.text",
            body: "Hello, World"
        });
        expect(event.isEncrypted()).toBeTruthy();

        client.removeListener("event", onEvent);
        deferred.resolve();
    };

    client.on("event", onEvent);

    httpBackend.flush();
    return deferred.promise;
}


function aliStartClient() {
    expectAliKeyUpload().catch(test_utils.failTest);
    startClient(aliHttpBackend, aliClient);
    return aliHttpBackend.flush().then(function() {
        console.log("Ali client started");
    });
}

function bobStartClient() {
    expectBobKeyUpload().catch(test_utils.failTest);
    startClient(bobHttpBackend, bobClient);
    return bobHttpBackend.flush().then(function() {
        console.log("Bob client started");
    });
}


/**
 * Set http responses for the requests which are made when a client starts, and
 * start the client.
 *
 * @param {object} httpBackend
 * @param {MatrixClient} client
 */
function startClient(httpBackend, client) {
    httpBackend.when("GET", "/pushrules").respond(200, {});
    httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });

    // send a sync response including our test room.
    var syncData = {
        next_batch: "x",
        rooms: {
            join: { }
        }
    };
    syncData.rooms.join[roomId] = {
        state: {
            events: [
                test_utils.mkMembership({
                    mship: "join",
                    user: aliUserId,
                }),
                test_utils.mkMembership({
                    mship: "join",
                    user: bobUserId,
                }),
            ]
        },
        timeline: {
            events: []
        }
    };
    httpBackend.when("GET", "/sync").respond(200, syncData);

    client.startClient();
}


describe("MatrixClient crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    beforeEach(function() {
        aliLocalStore = new MockStorageApi();
        aliStorage = new sdk.WebStorageSessionStore(aliLocalStore);
        bobStorage = new sdk.WebStorageSessionStore(new MockStorageApi());
        test_utils.beforeEach(this);

        aliHttpBackend = new HttpBackend();
        aliClient = sdk.createClient({
            baseUrl: "http://alis.server",
            userId: aliUserId,
            accessToken: aliAccessToken,
            deviceId: aliDeviceId,
            sessionStore: aliStorage,
            request: aliHttpBackend.requestFn,
        });

        bobHttpBackend = new HttpBackend();
        bobClient = sdk.createClient({
            baseUrl: "http://bobs.server",
            userId: bobUserId,
            accessToken: bobAccessToken,
            deviceId: bobDeviceId,
            sessionStore: bobStorage,
            request: bobHttpBackend.requestFn,
        });

        bobOneTimeKeys = undefined;
        aliDeviceKeys = undefined;
        bobDeviceKeys = undefined;
        bobDeviceCurve25519Key = undefined;
        bobDeviceEd25519Key = undefined;
        aliMessages = [];
        bobMessages = [];
    });

    afterEach(function() {
        aliClient.stopClient();
        bobClient.stopClient();
    });

    it("Bob uploads without one-time keys and with one-time keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .catch(test_utils.failTest).done(done);
    });

    it("Ali downloads Bobs keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .catch(test_utils.failTest).done(done);
    });

    it("Ali gets keys with an invalid signature", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(function() {
                // tamper bob's keys!
                expect(bobDeviceKeys.keys["curve25519:" + bobDeviceId]).toBeDefined();
                bobDeviceKeys.keys["curve25519:" + bobDeviceId] += "abc";

                return q.all(aliClient.downloadKeys([bobUserId]),
                             expectAliQueryKeys());
            })
            .then(function() {
                // should get an empty list
                expect(aliClient.listDeviceKeys(bobUserId)).toEqual([]);
            })
            .catch(test_utils.failTest).done(done);
    });

    it("Ali enables encryption", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .catch(test_utils.failTest).done(done);
    });

    it("Ali sends a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .catch(test_utils.failTest).nodeify(done);
    });

    it("Bob receives a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .catch(test_utils.failTest).done(done);
    });

    it("Bob receives a message with a bogus sender", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(function() {
                var message = aliMessages.shift();
                var syncData = {
                    next_batch: "x",
                    rooms: {
                        join: {

                        }
                    }
                };
                syncData.rooms.join[roomId] = {
                    timeline: {
                        events: [
                            test_utils.mkEvent({
                                type: "m.room.encrypted",
                                room: roomId,
                                content: message,
                                sender: "@bogus:sender",
                            })
                        ]
                    }
                };
                bobHttpBackend.when("GET", "/sync").respond(200, syncData);

                var deferred = q.defer();
                var onEvent = function(event) {
                    console.log(bobClient.credentials.userId + " received event",
                                event);

                    // ignore the m.room.member events
                    if (event.getType() == "m.room.member") {
                        return;
                    }

                    expect(event.getType()).toEqual("m.room.message");
                    expect(event.getContent().msgtype).toEqual("m.bad.encrypted");
                    expect(event.isEncrypted()).toBeTruthy();

                    bobClient.removeListener("event", onEvent);
                    deferred.resolve();
                };

                bobClient.on("event", onEvent);

                bobHttpBackend.flush();
                return deferred.promise;
            })
            .catch(test_utils.failTest).done(done);
    });

    it("Ali blocks Bob's device", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliDownloadsKeys)
            .then(function() {
                aliClient.setDeviceBlocked(bobUserId, bobDeviceId, true);
                var p1 = sendMessage(aliClient);
                var p2 = expectAliQueryKeys()
                    .then(expectAliClaimKeys)
                    .then(function() {
                        return expectSendMessageRequest(aliHttpBackend);
                    }).then(function(sentContent) {
                        // no unblocked devices, so the ciphertext should be empty
                        expect(sentContent.ciphertext).toEqual({});
                    });
                return q.all([p1, p2]);
            }).catch(test_utils.failTest).nodeify(done);
    });

    it("Bob receives two pre-key messages", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(test_utils.failTest).done(done);
    });

    it("Bob replies to the message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .then(bobEnablesEncryption)
            .then(bobSendsReplyMessage).then(function(ciphertext) {
                expect(ciphertext.type).toEqual(1);
            }).then(aliRecvMessage)
            .catch(test_utils.failTest).done(done);
    });
});
