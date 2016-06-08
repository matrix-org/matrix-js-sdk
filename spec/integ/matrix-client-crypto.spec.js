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

describe("MatrixClient crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    var baseUrl = "http://localhost.or.something";
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

    beforeEach(function() {
        aliLocalStore = new MockStorageApi();
        aliStorage = new sdk.WebStorageSessionStore(aliLocalStore);
        bobStorage = new sdk.WebStorageSessionStore(new MockStorageApi());
        utils.beforeEach(this);

        aliHttpBackend = new HttpBackend();
        aliClient = sdk.createClient({
            baseUrl: baseUrl,
            userId: aliUserId,
            accessToken: aliAccessToken,
            deviceId: aliDeviceId,
            sessionStore: aliStorage,
            request: aliHttpBackend.requestFn,
        });

        bobHttpBackend = new HttpBackend();
        bobClient = sdk.createClient({
            baseUrl: baseUrl,
            userId: bobUserId,
            accessToken: bobAccessToken,
            deviceId: bobDeviceId,
            sessionStore: bobStorage,
            request: bobHttpBackend.requestFn,
        });

        aliMessages = [];
        bobMessages = [];
    });

    afterEach(function() {
        aliClient.stopClient();
        bobClient.stopClient();
    });

    describe("Ali account setup", function() {
        it("should have device keys", function(done) {
            expect(aliClient.deviceKeys).toBeDefined();
            expect(aliClient.deviceKeys.user_id).toEqual(aliUserId);
            expect(aliClient.deviceKeys.device_id).toEqual(aliDeviceId);
            done();
        });
    });

    function bobUploadsKeys() {
        var uploadPath = "/keys/upload/bvcxz";
        bobHttpBackend.when("POST", uploadPath).respond(200, function(path, content) {
            expect(content.one_time_keys).toEqual({});
            bobHttpBackend.when("POST", uploadPath).respond(200, function(path, content) {
                expect(content.one_time_keys).not.toEqual({});
                bobDeviceKeys = content.device_keys;
                bobOneTimeKeys = content.one_time_keys;
                var count = 0;
                for (var key in content.one_time_keys) {
                    if (content.one_time_keys.hasOwnProperty(key)) {
                        count++;
                    }
                }
                expect(count).toEqual(5);
                return {one_time_key_counts: {curve25519: count}};
            });
            return {one_time_key_counts: {}};
        });
        bobClient.uploadKeys(5).catch(utils.failTest);
        return bobHttpBackend.flush().then(function() {
            expect(bobDeviceKeys).toBeDefined();
            expect(bobOneTimeKeys).toBeDefined();
            bobDeviceCurve25519Key = bobDeviceKeys.keys["curve25519:bvcxz"];
            bobDeviceEd25519Key = bobDeviceKeys.keys["ed25519:bvcxz"];
        });
    }

    it("Bob uploads without one-time keys and with one-time keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .catch(utils.failTest).done(done);
    });

    function aliDownloadsKeys() {
        var bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        aliHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
            expect(content.device_keys[bobUserId]).toEqual({});
            var result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });
        var p1 = aliClient.downloadKeys([bobUserId]).then(function() {
            expect(aliClient.listDeviceKeys(bobUserId)).toEqual([{
                id: "bvcxz",
                key: bobDeviceEd25519Key,
                verified: false,
            }]);
        });
        var p2 = aliHttpBackend.flush();

        return q.all([p1, p2]).then(function() {
            var devices = aliStorage.getEndToEndDevicesForUser(bobUserId);
            expect(devices[bobDeviceId].keys).toEqual(bobDeviceKeys.keys);
            expect(devices[bobDeviceId].verified).toBe(false);
        });
    }

    it("Ali downloads Bobs keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .catch(utils.failTest).done(done);
    });

    function aliEnablesEncryption() {
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
            members: [aliUserId, bobUserId]
        }).then(function(res) {
            expect(res.missingUsers).toEqual([]);
            expect(res.missingDevices).toEqual({});
            expect(aliClient.isRoomEncrypted(roomId)).toBeTruthy();
        });
        aliHttpBackend.flush();
        return p;
    }

    it("Ali enables encryption", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .catch(utils.failTest).done(done);
    });

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

    function aliSendsMessage() {
        return sendMessage(aliHttpBackend, aliClient).then(function(content) {
            aliMessages.push(content);
            var ciphertext = content.ciphertext[bobDeviceCurve25519Key];
            expect(ciphertext).toBeDefined();
        });
    }

    it("Ali sends a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .catch(utils.failTest).done(done);
    });

    function startClient(httpBackend, client) {
        client.startClient();
        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
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
        client.on("event", function(event) {
            expect(event.getType()).toEqual("m.room.message");
            expect(event.getContent()).toEqual({
                msgtype: "m.text",
                body: "Hello, World"
            });
            expect(event.isEncrypted()).toBeTruthy();
            deferred.resolve();
        });
        startClient(httpBackend, client);
        httpBackend.flush();
        return deferred.promise;
    }

    function bobRecvMessage() {
        var message = aliMessages.shift();
        return recvMessage(bobHttpBackend, bobClient, message);
    }

    it("Bob receives a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(utils.failTest).done(done);
    });

    it("Bob receives two pre-key messages", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(utils.failTest).done(done);
    });


    function aliUploadsKeys() {
        var uploadPath = "/keys/upload/" + aliDeviceId;
        aliHttpBackend.when("POST", uploadPath).respond(200, function(path, content) {
            expect(content.one_time_keys).toEqual({});
            aliDeviceKeys = content.device_keys;
            return {one_time_key_counts: {curve25519: 0}};
        });
        return q.all([
            aliClient.uploadKeys(0),
            aliHttpBackend.flush(uploadPath, 1),
        ]).then(function() {
            console.log("ali uploaded keys");
        });
    }

    function bobDownloadsKeys() {
        var aliKeys = {};
        aliKeys[aliDeviceId] = aliDeviceKeys;
        bobHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
            expect(content.device_keys[aliUserId]).toEqual({});
            var result = {};
            result[aliUserId] = aliKeys;
            return {device_keys: result};
        });
        return q.all([
            bobClient.downloadKeys([aliUserId]),
            bobHttpBackend.flush(),
        ]);
    }

    function bobEnablesEncryption() {
        return bobClient.setRoomEncryption(roomId, {
            algorithm: "m.olm.v1.curve25519-aes-sha2",
            members: [aliUserId, bobUserId]
        }).then(function(res) {
            console.log("bob enabled encryption");
            expect(res.missingUsers).toEqual([]);
            expect(res.missingDevices).toEqual({});
            expect(bobClient.isRoomEncrypted(roomId)).toBeTruthy();
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

    function aliRecvMessage() {
        var message = bobMessages.shift();
        return recvMessage(aliHttpBackend, aliClient, message);
    }


    it("Bob replies to the message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .then(aliUploadsKeys)
            .then(bobDownloadsKeys)
            .then(bobEnablesEncryption)
            .then(bobSendsMessage).then(function(ciphertext) {
                expect(ciphertext.type).toEqual(1);
            }).then(aliRecvMessage)
            .catch(utils.failTest).done(done);
    });
});
