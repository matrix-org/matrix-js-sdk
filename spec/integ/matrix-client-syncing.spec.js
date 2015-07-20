"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient syncing", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var selfUserId = "@alice:localhost";
    var selfAccessToken = "aseukfgwef";
    var otherUserId = "@bob:localhost";

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: selfUserId,
            accessToken: selfAccessToken
        });
        httpBackend.when("GET", "/pushrules").respond(200, {});
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("startClient", function() {
        var initialSync = {
            end: "s_5_3",
            presence: [],
            rooms: []
        };
        var eventData = {
            start: "s_5_3",
            end: "e_6_7",
            chunk: []
        };

        it("should start with /initialSync then move onto /events.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient();

            httpBackend.flush().done(function() {
                done();
            });
        });

        it("should pass the 'end' token from /initialSync to the from= param " +
            " of /events", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").check(function(req) {
                expect(req.queryParams.from).toEqual(initialSync.end);
            }).respond(200, eventData);

            client.startClient();

            httpBackend.flush().done(function() {
                done();
            });
        });
    });

    describe("users", function() {
        var userA = "@alice:bar";
        var userB = "@bob:bar";
        var userC = "@claire:bar";
        var initialSync = {
            end: "s_5_3",
            presence: [
                utils.mkPresence({
                    user: userA, presence: "online"
                }),
                utils.mkPresence({
                    user: userB, presence: "unavailable"
                })
            ],
            rooms: []
        };
        var eventData = {
            start: "s_5_3",
            end: "e_6_7",
            chunk: [
                // existing user change
                utils.mkPresence({
                    user: userA, presence: "offline"
                }),
                // new user C
                utils.mkPresence({
                    user: userC, presence: "online"
                })
            ]
        };

        it("should create users for presence events from /initialSync and /events",
        function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient();

            httpBackend.flush().done(function() {
                expect(client.getUser(userA).presence).toEqual("offline");
                expect(client.getUser(userB).presence).toEqual("unavailable");
                expect(client.getUser(userC).presence).toEqual("online");
                done();
            });
        });
    });

    describe("room state", function() {
        var roomOne = "!foo:localhost";
        var roomTwo = "!bar:localhost";
        var msgText = "some text here";
        var otherDisplayName = "Bob Smith";
        var initialSync = {
            end: "s_5_3",
            presence: [],
            rooms: [
                {
                    membership: "join",
                    room_id: roomOne,
                    messages: {
                        start: "f_1_1",
                        end: "f_2_2",
                        chunk: [
                            utils.mkMessage({
                                room: roomOne, user: otherUserId, msg: "hello"
                            })
                        ]
                    },
                    state: [
                        utils.mkEvent({
                            type: "m.room.name", room: roomOne, user: otherUserId,
                            content: {
                                name: "Old room name"
                            }
                        }),
                        utils.mkMembership({
                            room: roomOne, mship: "join", user: otherUserId
                        }),
                        utils.mkMembership({
                            room: roomOne, mship: "join", user: selfUserId
                        }),
                        utils.mkEvent({
                            type: "m.room.create", room: roomOne, user: selfUserId,
                            content: {
                                creator: selfUserId
                            }
                        })
                    ]
                },
                {
                    membership: "join",
                    room_id: roomTwo,
                    messages: {
                        start: "f_1_1",
                        end: "f_2_2",
                        chunk: [
                            utils.mkMessage({
                                room: roomTwo, user: otherUserId, msg: "hiii"
                            })
                        ]
                    },
                    state: [
                        utils.mkMembership({
                            room: roomTwo, mship: "join", user: otherUserId,
                            name: otherDisplayName
                        }),
                        utils.mkMembership({
                            room: roomTwo, mship: "join", user: selfUserId
                        }),
                        utils.mkEvent({
                            type: "m.room.create", room: roomTwo, user: selfUserId,
                            content: {
                                creator: selfUserId
                            }
                        })
                    ]
                }
            ]
        };
        var eventData = {
            start: "s_5_3",
            end: "e_6_7",
            chunk: [
                utils.mkEvent({
                    type: "m.room.name", room: roomOne, user: selfUserId,
                    content: { name: "A new room name" }
                }),
                utils.mkMessage({
                    room: roomTwo, user: otherUserId, msg: msgText
                }),
                utils.mkEvent({
                    type: "m.typing", room: roomTwo,
                    content: { user_ids: [otherUserId] }
                })
            ]
        };

        it("should continually recalculate the right room name.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomOne);
                // should have clobbered the name to the one from /events
                expect(room.name).toEqual(eventData.chunk[0].content.name);
                done();
            });
        });

        it("should store the right events in the timeline.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomTwo);
                // should have added the message from /events
                expect(room.timeline.length).toEqual(2);
                expect(room.timeline[1].getContent().body).toEqual(msgText);
                done();
            });
        });

        it("should set the right room name.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient();
            httpBackend.flush().done(function() {
                var room = client.getRoom(roomTwo);
                // should use the display name of the other person.
                expect(room.name).toEqual(otherDisplayName);
                done();
            });
        });

        it("should set the right user's typing flag.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient();

            httpBackend.flush().done(function() {
                var room = client.getRoom(roomTwo);
                var member = room.getMember(otherUserId);
                expect(member).toBeDefined();
                expect(member.typing).toEqual(true);
                member = room.getMember(selfUserId);
                expect(member).toBeDefined();
                expect(member.typing).toEqual(false);
                done();
            });
        });

        xit("should update power levels for users in a room", function() {

        });

        xit("should update the room topic", function() {

        });
    });

    describe("of a room", function() {
        xit("should sync when a join event (which changes state) for the user" +
        " arrives down the event stream (e.g. join from another device)", function() {

        });

        xit("should sync when the user explicitly calls joinRoom", function() {

        });
    });
});
