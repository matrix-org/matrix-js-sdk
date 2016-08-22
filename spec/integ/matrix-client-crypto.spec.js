"use strict";
var sdk = require("../..");
var q = require("q");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");
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
    bobClient.uploadKeys(5).catch(utils.failTest);
    return expectBobKeyUpload();
}


/**
 * Set an expectation that ali will query bobs keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function aliQueryKeys() {
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
function bobQueryKeys() {
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
    var p2 = aliQueryKeys();

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
    // can't query keys before bob has uploaded them
    expect(bobOneTimeKeys).toBeDefined();

    aliQueryKeys().catch(utils.failTest);
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
    var p = aliClient.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function(res) {
        expect(res[aliUserId]).toEqual({});
        expect(res[bobUserId][bobDeviceId].device).toBeDefined();
        expect(res[bobUserId][bobDeviceId].sessionId).toBeDefined();
        expect(aliClient.isRoomEncrypted(roomId)).toBeTruthy();
    });
    aliHttpBackend.flush();
    return p;
}

function bobEnablesEncryption() {
    bobQueryKeys().catch(utils.failTest);
    return bobClient.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function(res) {
        expect(res[aliUserId][aliDeviceId].device).toBeDefined();
        expect(res[aliUserId][aliDeviceId].sessionId).toBeDefined();
        expect(res[bobUserId]).toEqual({});
        expect(bobClient.isRoomEncrypted(roomId)).toBeTruthy();
    });
}

function aliSendsMessage() {
    return sendMessage(aliHttpBackend, aliClient).then(function(content) {
        aliMessages.push(content);
        var ciphertext = content.ciphertext[bobDeviceCurve25519Key];
        expect(ciphertext).toBeDefined();
    });
}

function bobSendsMessage() {
    return sendMessage(bobHttpBackend, bobClient).then(function(content) {
        bobMessages.push(content);
        var aliKeyId = "curve25519:" + aliDeviceId;
        var aliDeviceCurve25519Key = aliDeviceKeys.keys[aliKeyId];
        var ciphertext = content.ciphertext[aliDeviceCurve25519Key];
        expect(ciphertext).toBeDefined();
        return ciphertext;
    });
}

function sendMessage(httpBackend, client) {
    var path = "/send/m.room.encrypted/";
    var sent;
    httpBackend.when("PUT", path).respond(200, function(path, content) {
        sent = content;
        return {
            event_id: "asdfgh",
        };
    });
    var p1 = client.sendMessage(
        roomId, {msgtype: "m.text", body: "Hello, World"}
    );
    var p2 = httpBackend.flush(path, 1);
    return q.all([p1, p2]).then(function() {
        return sent;
    });
}

function aliRecvMessage() {
    var message = bobMessages.shift();
    return recvMessage(aliHttpBackend, aliClient, message);
}

function bobRecvMessage() {
    var message = aliMessages.shift();
    return recvMessage(bobHttpBackend, bobClient, message);
}

function recvMessage(httpBackend, client, message) {
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
                utils.mkEvent({
                    type: "m.room.encrypted",
                    room: roomId,
                    content: message
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
    expectAliKeyUpload().catch(utils.failTest);
    startClient(aliHttpBackend, aliClient);
    return aliHttpBackend.flush().then(function() {
        console.log("Ali client started");
    });
}

function bobStartClient() {
    expectBobKeyUpload().catch(utils.failTest);
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
                utils.mkMembership({
                    mship: "join",
                    user: aliUserId,
                }),
                utils.mkMembership({
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
        utils.beforeEach(this);

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
            .catch(utils.failTest).done(done);
    });

    it("Ali downloads Bobs keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .catch(utils.failTest).done(done);
    });

    it("Ali gets keys with an invalid signature", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(function() {
                // tamper bob's keys!
                expect(bobDeviceKeys.keys["curve25519:" + bobDeviceId]).toBeDefined();
                bobDeviceKeys.keys["curve25519:" + bobDeviceId] += "abc";

                return q.all(aliClient.downloadKeys([bobUserId]),
                             aliQueryKeys());
            })
            .then(function() {
                // should get an empty list
                expect(aliClient.listDeviceKeys(bobUserId)).toEqual([]);
            })
            .catch(utils.failTest).done(done);
    });

    it("Ali enables encryption", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .catch(utils.failTest).done(done);
    });

    it("Ali sends a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .catch(utils.failTest).done(done);
    });

    it("Bob receives a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .catch(utils.failTest).done(done);
    });

    it("Bob receives two pre-key messages", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(utils.failTest).done(done);
    });

    it("Bob replies to the message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .then(bobEnablesEncryption)
            .then(bobSendsMessage).then(function(ciphertext) {
                expect(ciphertext.type).toEqual(1);
            }).then(aliRecvMessage)
            .catch(utils.failTest).done(done);
    });
});
