"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient", function() {
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

            client.startClient(function(err, data, isLive) {});

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

            client.startClient(function(err, data, isLive) {});

            httpBackend.flush().done(function() {
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
                            utils.mkMessage(roomOne, otherUserId, "hello")
                        ]
                    },
                    state: [
                        utils.mkEvent(
                            "m.room.name", roomOne, otherUserId,
                            {
                                name: "Old room name"
                            }
                        ),
                        utils.mkMembership(roomOne, "join", otherUserId),
                        utils.mkMembership(roomOne, "join", selfUserId),
                        utils.mkEvent(
                            "m.room.create", roomOne, selfUserId,
                            {
                                creator: selfUserId
                            }
                        )
                    ]
                },
                {
                    membership: "join",
                    room_id: roomTwo,
                    messages: {
                        start: "f_1_1",
                        end: "f_2_2",
                        chunk: [
                            utils.mkMessage(roomTwo, otherUserId, "hiii")
                        ]
                    },
                    state: [
                        utils.mkMembership(
                            roomTwo, "join", otherUserId, null, otherDisplayName
                        ),
                        utils.mkMembership(roomTwo, "join", selfUserId),
                        utils.mkEvent(
                            "m.room.create", roomTwo, selfUserId,
                            {
                                creator: selfUserId
                            }
                        )
                    ]
                }
            ]
        };
        var eventData = {
            start: "s_5_3",
            end: "e_6_7",
            chunk: [
                utils.mkEvent("m.room.name", roomOne, selfUserId, {
                    name: "A new room name"
                }),
                utils.mkMessage(roomTwo, otherUserId, msgText),
                utils.mkEvent("m.typing", roomTwo, undefined, {
                    user_ids: [otherUserId]
                })
            ]
        };

        it("should continually recalculate the right room name.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient(function(err, data, isLive) {});

            httpBackend.flush().done(function() {
                var room = client.getStore().getRoom(roomOne);
                // should have clobbered the name to the one from /events
                expect(room.name).toEqual(eventData.chunk[0].content.name);
                done();
            });
        });

        it("should store the right events in the timeline.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient(function(err, data, isLive) {});

            httpBackend.flush().done(function() {
                var room = client.getStore().getRoom(roomTwo);
                // should have added the message from /events
                expect(room.timeline.length).toEqual(2);
                expect(room.timeline[1].getContent().body).toEqual(msgText);
                done();
            });
        });

        it("should set the right room name.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient(function(err, data, isLive) {});
            httpBackend.flush().done(function() {
                var room = client.getStore().getRoom(roomTwo);
                // should use the display name of the other person.
                expect(room.name).toEqual(otherDisplayName);
                done();
            });
        });

        it("should set the right user's typing flag.", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            client.startClient(function(err, data, isLive) {});

            httpBackend.flush().done(function() {
                var room = client.getStore().getRoom(roomTwo);
                var member = room.getMember(otherUserId);
                expect(member).toBeDefined();
                expect(member.typing).toEqual(true);
                member = room.getMember(selfUserId);
                expect(member).toBeDefined();
                expect(member.typing).toEqual(false);
                done();
            });
        });
    });

});
