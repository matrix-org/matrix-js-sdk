"use strict";
var sdk = require("../..");
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
    var baseUrl = "http://localhost.or.something";
    var httpBackend;
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
    var bobDeviceKeys;
    var bobDeviceCurve25519Key;
    var bobDeviceEd25519Key;
    var aliLocalStore;
    var aliStorage;
    var bobStorage;
    var aliMessage;

    beforeEach(function() {
        aliLocalStore = new MockStorageApi();
        aliStorage = new sdk.WebStorageSessionStore(aliLocalStore);
        bobStorage = new sdk.WebStorageSessionStore(new MockStorageApi());
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);

        aliClient = sdk.createClient({
            baseUrl: baseUrl,
            userId: aliUserId,
            accessToken: aliAccessToken,
            deviceId: aliDeviceId,
            sessionStore: aliStorage
        });

        bobClient = sdk.createClient({
            baseUrl: baseUrl,
            userId: bobUserId,
            accessToken: bobAccessToken,
            deviceId: bobDeviceId,
            sessionStore: bobStorage
        });

        httpBackend.when("GET", "/pushrules").respond(200, {});
    });

    describe("Ali account setup", function() {
        it("should have device keys", function(done) {
            expect(aliClient.deviceKeys).toBeDefined();
            expect(aliClient.deviceKeys.user_id).toEqual(aliUserId);
            expect(aliClient.deviceKeys.device_id).toEqual(aliDeviceId);
            done();
        });
        it("should have a curve25519 key", function(done) {
            expect(aliClient.deviceCurve25519Key).toBeDefined();
            done();
        });
    });

    function bobUploadsKeys(done) {
        var uploadPath = "/keys/upload/bvcxz";
        httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
            expect(content.one_time_keys).toEqual({});
            httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
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
        bobClient.uploadKeys(5);
        httpBackend.flush().done(function() {
            expect(bobDeviceKeys).toBeDefined();
            expect(bobOneTimeKeys).toBeDefined();
            bobDeviceCurve25519Key = bobDeviceKeys.keys["curve25519:bvcxz"];
            bobDeviceEd25519Key = bobDeviceKeys.keys["ed25519:bvcxz"];
            done();
        });
    }

    it("Bob uploads without one-time keys and with one-time keys", bobUploadsKeys);

    function aliDownloadsKeys(done) {
        var bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        httpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
            expect(content.device_keys[bobUserId]).toEqual({});
            var result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });
        aliClient.downloadKeys([bobUserId]).then(function() {
            expect(aliClient.listDeviceKeys(bobUserId)).toEqual([{
                id: "bvcxz",
                key: bobDeviceEd25519Key
            }]);
        });
        httpBackend.flush().done(function() {
            var devices = aliStorage.getEndToEndDevicesForUser(bobUserId);
            expect(devices).toEqual(bobKeys);
            done();
        });
    }

    it("Ali downloads Bobs keys", function(done) {
        bobUploadsKeys(function() {aliDownloadsKeys(done);});
    });

    function aliEnablesEncryption(done) {
        httpBackend.when("POST", "/keys/claim").respond(200, function(path, content) {
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
        aliClient.setRoomEncryption(roomId, {
            algorithm: "m.olm.v1.curve25519-aes-sha2",
            members: [aliUserId, bobUserId]
        }).then(function(res) {
            expect(res.missingUsers).toEqual([]);
            expect(res.missingDevices).toEqual({});
            expect(aliClient.isRoomEncrypted(roomId)).toBeTruthy();
            done();
        });
        httpBackend.flush();
    }

    it("Ali enables encryption", function(done) {
        bobUploadsKeys(function() {
            aliDownloadsKeys(function() {
                aliEnablesEncryption(done);
            });
        });
    });

    function aliSendsMessage(done) {
        var txnId = "a.transaction.id";
        var path = "/send/m.room.encrypted/" + txnId;
        httpBackend.when("PUT", path).respond(200, function(path, content) {
            aliMessage = content;
            expect(aliMessage.ciphertext[bobDeviceCurve25519Key]).toBeDefined();
            return {};
        });
        aliClient.sendMessage(
            roomId, {msgtype: "m.text", body: "Hello, World"}, txnId
        );
        httpBackend.flush().done(function() {done();});
    }

    it("Ali sends a message", function(done) {
        bobUploadsKeys(function() {
            aliDownloadsKeys(function() {
                aliEnablesEncryption(function() {
                    aliSendsMessage(done);
                });
            });
        });
    });

    function bobRecvMessage(done) {
        var initialSync = {
            end: "alpha",
            presence: [],
            rooms: []
        };
        var events = {
            start: "alpha",
            end: "beta",
            chunk: [utils.mkEvent({
                type: "m.room.encrypted",
                room: roomId,
                content: aliMessage
            })]
        };
        httpBackend.when("GET", "initialSync").respond(200, initialSync);
        httpBackend.when("GET", "events").respond(200, events);
        bobClient.on("event", function(event) {
            expect(event.getType()).toEqual("m.room.message");
            expect(event.getContent()).toEqual({
                msgtype: "m.text",
                body: "Hello, World"
            });
            expect(event.isEncrypted()).toBeTruthy();
            done();
        });
        bobClient.startClient();
        httpBackend.flush();
    }

    it("Bob receives a message", function(done) {
        bobUploadsKeys(function() {
            aliDownloadsKeys(function() {
                aliEnablesEncryption(function() {
                    aliSendsMessage(function() {
                        bobRecvMessage(done);
                    });
                });
            });
        });
    }, 30000); //timeout after 30s

});
