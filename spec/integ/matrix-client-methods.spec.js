"use strict";
import 'source-map-support/register';
const sdk = require("../..");
const HttpBackend = require("matrix-mock-request");
const publicGlobals = require("../../lib/matrix");
const Room = publicGlobals.Room;
const MatrixInMemoryStore = publicGlobals.MatrixInMemoryStore;
const Filter = publicGlobals.Filter;
const utils = require("../test-utils");
const MockStorageApi = require("../MockStorageApi");

import expect from 'expect';

describe("MatrixClient", function() {
    const baseUrl = "http://localhost.or.something";
    let client = null;
    let httpBackend = null;
    let store = null;
    let sessionStore = null;
    const userId = "@alice:localhost";
    const accessToken = "aseukfgwef";

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
        httpBackend = new HttpBackend();
        store = new MatrixInMemoryStore();

        const mockStorage = new MockStorageApi();
        sessionStore = new sdk.WebStorageSessionStore(mockStorage);

        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            deviceId: "aliceDevice",
            accessToken: accessToken,
            store: store,
            sessionStore: sessionStore,
        });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
        return httpBackend.stop();
    });

    describe("uploadContent", function() {
        const buf = new Buffer('hello world');
        it("should upload the file", function(done) {
            httpBackend.when(
                "POST", "/_matrix/media/v1/upload",
            ).check(function(req) {
                expect(req.rawData).toEqual(buf);
                expect(req.queryParams.filename).toEqual("hi.txt");
                if (!(req.queryParams.access_token == accessToken ||
                        req.headers["Authorization"] == "Bearer " + accessToken)) {
                    expect(true).toBe(false);
                }
                expect(req.headers["Content-Type"]).toEqual("text/plain");
                expect(req.opts.json).toBeFalsy();
                expect(req.opts.timeout).toBe(undefined);
            }).respond(200, "content", true);

            const prom = client.uploadContent({
                stream: buf,
                name: "hi.txt",
                type: "text/plain",
            });

            expect(prom).toBeTruthy();

            const uploads = client.getCurrentUploads();
            expect(uploads.length).toEqual(1);
            expect(uploads[0].promise).toBe(prom);
            expect(uploads[0].loaded).toEqual(0);

            prom.then(function(response) {
                // for backwards compatibility, we return the raw JSON
                expect(response).toEqual("content");

                const uploads = client.getCurrentUploads();
                expect(uploads.length).toEqual(0);
            }).nodeify(done);

            httpBackend.flush();
        });

        it("should parse the response if rawResponse=false", function(done) {
            httpBackend.when(
                "POST", "/_matrix/media/v1/upload",
            ).check(function(req) {
                expect(req.opts.json).toBeFalsy();
            }).respond(200, { "content_uri": "uri" });

            client.uploadContent({
                stream: buf,
                name: "hi.txt",
                type: "text/plain",
            }, {
                rawResponse: false,
            }).then(function(response) {
                expect(response.content_uri).toEqual("uri");
            }).nodeify(done);

            httpBackend.flush();
        });

        it("should parse errors into a MatrixError", function(done) {
            httpBackend.when(
                "POST", "/_matrix/media/v1/upload",
            ).check(function(req) {
                expect(req.rawData).toEqual(buf);
                expect(req.opts.json).toBeFalsy();
            }).respond(400, {
                "errcode": "M_SNAFU",
                "error": "broken",
            });

            client.uploadContent({
                stream: buf,
                name: "hi.txt",
                type: "text/plain",
            }).then(function(response) {
                throw Error("request not failed");
            }, function(error) {
                expect(error.httpStatus).toEqual(400);
                expect(error.errcode).toEqual("M_SNAFU");
                expect(error.message).toEqual("broken");
            }).nodeify(done);

            httpBackend.flush();
        });

        it("should return a promise which can be cancelled", function(done) {
            const prom = client.uploadContent({
                stream: buf,
                name: "hi.txt",
                type: "text/plain",
            });

            const uploads = client.getCurrentUploads();
            expect(uploads.length).toEqual(1);
            expect(uploads[0].promise).toBe(prom);
            expect(uploads[0].loaded).toEqual(0);

            prom.then(function(response) {
                throw Error("request not aborted");
            }, function(error) {
                expect(error).toEqual("aborted");

                const uploads = client.getCurrentUploads();
                expect(uploads.length).toEqual(0);
            }).nodeify(done);

            const r = client.cancelUpload(prom);
            expect(r).toBe(true);
        });
    });

    describe("joinRoom", function() {
        it("should no-op if you've already joined a room", function() {
            const roomId = "!foo:bar";
            const room = new Room(roomId, userId);
            room.addLiveEvents([
                utils.mkMembership({
                    user: userId, room: roomId, mship: "join", event: true,
                }),
            ]);
            store.storeRoom(room);
            client.joinRoom(roomId);
            httpBackend.verifyNoOutstandingRequests();
        });
    });

    describe("getFilter", function() {
        const filterId = "f1lt3r1d";

        it("should return a filter from the store if allowCached", function(done) {
            const filter = Filter.fromJson(userId, filterId, {
                event_format: "client",
            });
            store.storeFilter(filter);
            client.getFilter(userId, filterId, true).done(function(gotFilter) {
                expect(gotFilter).toEqual(filter);
                done();
            });
            httpBackend.verifyNoOutstandingRequests();
        });

        it("should do an HTTP request if !allowCached even if one exists",
        function(done) {
            const httpFilterDefinition = {
                event_format: "federation",
            };

            httpBackend.when(
                "GET", "/user/" + encodeURIComponent(userId) + "/filter/" + filterId,
            ).respond(200, httpFilterDefinition);

            const storeFilter = Filter.fromJson(userId, filterId, {
                event_format: "client",
            });
            store.storeFilter(storeFilter);
            client.getFilter(userId, filterId, false).done(function(gotFilter) {
                expect(gotFilter.getDefinition()).toEqual(httpFilterDefinition);
                done();
            });

            httpBackend.flush();
        });

        it("should do an HTTP request if nothing is in the cache and then store it",
        function(done) {
            const httpFilterDefinition = {
                event_format: "federation",
            };
            expect(store.getFilter(userId, filterId)).toBe(null);

            httpBackend.when(
                "GET", "/user/" + encodeURIComponent(userId) + "/filter/" + filterId,
            ).respond(200, httpFilterDefinition);
            client.getFilter(userId, filterId, true).done(function(gotFilter) {
                expect(gotFilter.getDefinition()).toEqual(httpFilterDefinition);
                expect(store.getFilter(userId, filterId)).toBeTruthy();
                done();
            });

            httpBackend.flush();
        });
    });

    describe("createFilter", function() {
        const filterId = "f1llllllerid";

        it("should do an HTTP request and then store the filter", function(done) {
            expect(store.getFilter(userId, filterId)).toBe(null);

            const filterDefinition = {
                event_format: "client",
            };

            httpBackend.when(
                "POST", "/user/" + encodeURIComponent(userId) + "/filter",
            ).check(function(req) {
                expect(req.data).toEqual(filterDefinition);
            }).respond(200, {
                filter_id: filterId,
            });

            client.createFilter(filterDefinition).done(function(gotFilter) {
                expect(gotFilter.getDefinition()).toEqual(filterDefinition);
                expect(store.getFilter(userId, filterId)).toEqual(gotFilter);
                done();
            });

            httpBackend.flush();
        });
    });

    describe("searching", function() {
        const response = {
            search_categories: {
                room_events: {
                    count: 24,
                    results: {
                        "$flibble:localhost": {
                            rank: 0.1,
                            result: {
                                type: "m.room.message",
                                user_id: "@alice:localhost",
                                room_id: "!feuiwhf:localhost",
                                content: {
                                    body: "a result",
                                    msgtype: "m.text",
                                },
                            },
                        },
                    },
                },
            },
        };

        it("searchMessageText should perform a /search for room_events", function(done) {
            client.searchMessageText({
                query: "monkeys",
            });
            httpBackend.when("POST", "/search").check(function(req) {
                expect(req.data).toEqual({
                    search_categories: {
                        room_events: {
                            search_term: "monkeys",
                        },
                    },
                });
            }).respond(200, response);

            httpBackend.flush().done(function() {
                done();
            });
        });
    });


    describe("downloadKeys", function() {
        if (!sdk.CRYPTO_ENABLED) {
            return;
        }

        beforeEach(function() {
            return client.initCrypto();
        });

        it("should do an HTTP request and then store the keys", function(done) {
            const ed25519key = "7wG2lzAqbjcyEkOP7O4gU7ItYcn+chKzh5sT/5r2l78";
            // ed25519key = client.getDeviceEd25519Key();
            const borisKeys = {
                dev1: {
                    algorithms: ["1"],
                    device_id: "dev1",
                    keys: { "ed25519:dev1": ed25519key },
                    signatures: {
                        boris: {
                            "ed25519:dev1":
                                "RAhmbNDq1efK3hCpBzZDsKoGSsrHUxb25NW5/WbEV9R" +
                                "JVwLdP032mg5QsKt/pBDUGtggBcnk43n3nBWlA88WAw",
                        },
                    },
                    unsigned: { "abc": "def" },
                    user_id: "boris",
                },
            };
            const chazKeys = {
                dev2: {
                    algorithms: ["2"],
                    device_id: "dev2",
                    keys: { "ed25519:dev2": ed25519key },
                    signatures: {
                        chaz: {
                           "ed25519:dev2":
                                "FwslH/Q7EYSb7swDJbNB5PSzcbEO1xRRBF1riuijqvL" +
                                "EkrK9/XVN8jl4h7thGuRITQ01siBQnNmMK9t45QfcCQ",
                        },
                    },
                    unsigned: { "ghi": "def" },
                    user_id: "chaz",
                },
            };

            /*
            function sign(o) {
                var anotherjson = require('another-json');
                var b = JSON.parse(JSON.stringify(o));
                delete(b.signatures);
                delete(b.unsigned);
                return client._crypto._olmDevice.sign(anotherjson.stringify(b));
            };

            console.log("Ed25519: " + ed25519key);
            console.log("boris:", sign(borisKeys.dev1));
            console.log("chaz:", sign(chazKeys.dev2));
            */

            httpBackend.when("POST", "/keys/query").check(function(req) {
                expect(req.data).toEqual({device_keys: {
                    'boris': {},
                    'chaz': {},
                }});
            }).respond(200, {
                device_keys: {
                    boris: borisKeys,
                    chaz: chazKeys,
                },
            });

            client.downloadKeys(["boris", "chaz"]).then(function(res) {
                assertObjectContains(res.boris.dev1, {
                    verified: 0, // DeviceVerification.UNVERIFIED
                    keys: { "ed25519:dev1": ed25519key },
                    algorithms: ["1"],
                    unsigned: { "abc": "def" },
                });

                assertObjectContains(res.chaz.dev2, {
                    verified: 0, // DeviceVerification.UNVERIFIED
                    keys: { "ed25519:dev2": ed25519key },
                    algorithms: ["2"],
                    unsigned: { "ghi": "def" },
                });
            }).nodeify(done);

            httpBackend.flush();
        });
    });

    describe("deleteDevice", function() {
        const auth = {a: 1};
        it("should pass through an auth dict", function(done) {
            httpBackend.when(
                "DELETE", "/_matrix/client/unstable/devices/my_device",
            ).check(function(req) {
                expect(req.data).toEqual({auth: auth});
            }).respond(200);

            client.deleteDevice(
                "my_device", auth,
            ).nodeify(done);

            httpBackend.flush();
        });
    });
});

function assertObjectContains(obj, expected) {
    for (const k in expected) {
        if (expected.hasOwnProperty(k)) {
            expect(obj[k]).toEqual(expected[k]);
        }
    }
}
