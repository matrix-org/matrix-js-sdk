"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var publicGlobals = require("../../lib/matrix");
var Room = publicGlobals.Room;
var MatrixInMemoryStore = publicGlobals.MatrixInMemoryStore;
var utils = require("../test-utils");

describe("MatrixClient", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend, store;
    var userId = "@alice:localhost";
    var accessToken = "aseukfgwef";

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        store = new MatrixInMemoryStore();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            accessToken: accessToken,
            store: store
        });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("joinRoom", function() {
        it("should no-op if you've already joined a room", function() {
            var roomId = "!foo:bar";
            var room = new Room(roomId);
            room.addEvents([
                utils.mkMembership({
                    user: userId, room: roomId, mship: "join", event: true
                })
            ]);
            store.storeRoom(room);
            client.joinRoom(roomId);
            httpBackend.verifyNoOutstandingRequests();
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
});
