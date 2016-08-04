"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var publicGlobals = require("../../lib/matrix");
var Room = publicGlobals.Room;
var MatrixInMemoryStore = publicGlobals.MatrixInMemoryStore;
var Filter = publicGlobals.Filter;
var utils = require("../test-utils");
var MockStorageApi = require("../MockStorageApi");

describe("MatrixClient", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend, store, sessionStore;
    var userId = "@alice:localhost";
    var accessToken = "aseukfgwef";

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        store = new MatrixInMemoryStore();

        var mockStorage = new MockStorageApi();
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
    });

    describe("joinRoom", function() {
        it("should no-op if you've already joined a room", function() {
            var roomId = "!foo:bar";
            var room = new Room(roomId);
            room.addLiveEvents([
                utils.mkMembership({
                    user: userId, room: roomId, mship: "join", event: true
                })
            ]);
            store.storeRoom(room);
            client.joinRoom(roomId);
            httpBackend.verifyNoOutstandingRequests();
        });
    });

    describe("getFilter", function() {
        var filterId = "f1lt3r1d";

        it("should return a filter from the store if allowCached", function(done) {
            var filter = Filter.fromJson(userId, filterId, {
                event_format: "client"
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
            var httpFilterDefinition = {
                event_format: "federation"
            };

            httpBackend.when(
                "GET", "/user/" + encodeURIComponent(userId) + "/filter/" + filterId
            ).respond(200, httpFilterDefinition);

            var storeFilter = Filter.fromJson(userId, filterId, {
                event_format: "client"
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
            var httpFilterDefinition = {
                event_format: "federation"
            };
            expect(store.getFilter(userId, filterId)).toBeNull();

            httpBackend.when(
                "GET", "/user/" + encodeURIComponent(userId) + "/filter/" + filterId
            ).respond(200, httpFilterDefinition);
            client.getFilter(userId, filterId, true).done(function(gotFilter) {
                expect(gotFilter.getDefinition()).toEqual(httpFilterDefinition);
                expect(store.getFilter(userId, filterId)).toBeDefined();
                done();
            });

            httpBackend.flush();
        });
    });

    describe("createFilter", function() {
        var filterId = "f1llllllerid";

        it("should do an HTTP request and then store the filter", function(done) {
            expect(store.getFilter(userId, filterId)).toBeNull();

            var filterDefinition = {
                event_format: "client"
            };

            httpBackend.when(
                "POST", "/user/" + encodeURIComponent(userId) + "/filter"
            ).check(function(req) {
                expect(req.data).toEqual(filterDefinition);
            }).respond(200, {
                filter_id: filterId
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

        var response = {
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
                                    msgtype: "m.text"
                                }
                            }
                        }
                    }
                }
            }
        };

        it("searchMessageText should perform a /search for room_events", function(done) {
            client.searchMessageText({
                query: "monkeys"
            });
            httpBackend.when("POST", "/search").check(function(req) {
                expect(req.data).toEqual({
                    search_categories: {
                        room_events: {
                            search_term: "monkeys"
                        }
                    }
                });
            }).respond(200, response);

            httpBackend.flush().done(function() {
                done();
            });
        });
    });


    describe("downloadKeys", function() {
        it("should do an HTTP request and then store the keys", function(done) {
            var ed25519key = "wV5E3EUSHpHuoZLljNzojlabjGdXT3Mz7rugG9zgbkI";
            var borisKeys = {
                dev1: {
                    algorithms: ["1"], keys: { "ed25519:dev1": ed25519key },
                    signatures: {
                        boris: {
                           "ed25519:dev1":
                                "u99n8WZ61G//K6eVgYc+RDLVapmjttxqhjNucIFGEIJ" +
                                "oA4TUY8FmiGv3zl0EA71zrvPDfnFL5XLNsdc55NGbDg"
                        }
                    },
                    unsigned: { "abc": "def" },
                }
            };
            var chazKeys = {
                dev2: {
                    algorithms: ["2"], keys: { "ed25519:dev2": ed25519key },
                    signatures: {
                        chaz: {
                           "ed25519:dev2":
                                "8eaeXUWy9AQzjaNVOjVLs4FQk+cgobkNS811EjZBCMA" +
                                "apd8aPOfE26E13nFFOCLC1V6fOH5wVo61hxGR/j4PBA"
                        }
                    },
                    unsigned: { "ghi": "def" },
                }
            };
            var daveKeys = {
                dev3: {
                    algorithms: ["3"], keys: { "ed25519:dev2": ed25519key },
                    signatures: {
                        dave: {
                           "ed25519:dev2":
                                "8eaeXUWy9AQzjaNVOjVLs4FQk+cgobkNS811EjZBCMA" +
                                "apd8aPOfE26E13nFFOCLC1V6fOH5wVo61hxGR/j4PBA"
                        }
                    },
                    unsigned: { "ghi": "def" },
                }
            };

            httpBackend.when("POST", "/keys/query").check(function(req) {
                expect(req.data).toEqual({device_keys: {boris: {}, chaz: {}, dave: {}}});
            }).respond(200, {
                device_keys: {
                    boris: borisKeys,
                    chaz: chazKeys,
                    dave: daveKeys,
                },
            });

            client.downloadKeys(["boris", "chaz", "dave"]).then(function(res) {
                expect(res).toEqual({
                    boris: {
                        dev1: {
                            verified: 0, // DeviceVerification.UNVERIFIED
                            keys: { "ed25519:dev1": ed25519key },
                            algorithms: ["1"],
                            unsigned: { "abc": "def" },
                        },
                    },
                    chaz: {
                        dev2: {
                            verified: 0, // DeviceVerification.UNVERIFIED
                            keys: { "ed25519:dev2" : ed25519key },
                            algorithms: ["2"],
                            unsigned: { "ghi": "def" },
                        },
                    },
                    dave: {
                        // dave's key fails validation.
                    },
                });
            }).catch(utils.failTest).done(done);

            httpBackend.flush();
        });

        it("should return a rejected promise if the request fails", function(done) {
            httpBackend.when("POST", "/keys/query").respond(400);

            var exceptionThrown;
            client.downloadKeys(["bottom"]).then(function() {
                fail("download didn't fail");
            }, function(err) {
                exceptionThrown = err;
            }).then(function() {
                expect(exceptionThrown).toBeTruthy();
            }).catch(utils.failTest).done(done);

            httpBackend.flush();
        });
    });
});
