"use strict";
var sdk = require("../..");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient events", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var selfUserId = "@alice:localhost";
    var selfAccessToken = "aseukfgwef";

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
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
    });

    describe("emissions", function() {
        var SYNC_DATA = {
            next_batch: "s_5_3",
            presence: {
                events: [
                    utils.mkPresence({
                        user: "@foo:bar", name: "Foo Bar", presence: "online"
                    })
                ]
            },
            rooms: {
                join: {
                    "!erufh:bar": {
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: "!erufh:bar", user: "@foo:bar", msg: "hmmm"
                                })
                            ],
                            prev_batch: "s"
                        },
                        state: {
                            events: [
                                utils.mkMembership({
                                    room: "!erufh:bar", mship: "join", user: "@foo:bar"
                                }),
                                utils.mkEvent({
                                    type: "m.room.create", room: "!erufh:bar",
                                    user: "@foo:bar",
                                    content: {
                                        creator: "@foo:bar"
                                    }
                                })
                            ]
                        }
                    }
                }
            }
        };
        var NEXT_SYNC_DATA = {
            next_batch: "e_6_7",
            rooms: {
                join: {
                    "!erufh:bar": {
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: "!erufh:bar", user: "@foo:bar", msg: "ello ello"
                                }),
                                utils.mkMessage({
                                    room: "!erufh:bar", user: "@foo:bar", msg: ":D"
                                }),
                            ]
                        },
                        ephemeral: {
                            events: [
                                utils.mkEvent({
                                    type: "m.typing", room: "!erufh:bar", content: {
                                        user_ids: ["@foo:bar"]
                                    }
                                })
                            ]
                        }
                    }
                }
            }
        };

        it("should emit events from both the first and subsequent /sync calls",
        function(done) {
            httpBackend.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);

            var expectedEvents = [];
            expectedEvents = expectedEvents.concat(
                SYNC_DATA.presence.events,
                SYNC_DATA.rooms.join["!erufh:bar"].timeline.events,
                SYNC_DATA.rooms.join["!erufh:bar"].state.events,
                NEXT_SYNC_DATA.rooms.join["!erufh:bar"].timeline.events,
                NEXT_SYNC_DATA.rooms.join["!erufh:bar"].ephemeral.events
            );

            client.on("event", function(event) {
                var found = false;
                for (var i = 0; i < expectedEvents.length; i++) {
                    if (expectedEvents[i].event_id === event.getId()) {
                        expectedEvents.splice(i, 1);
                        found = true;
                        break;
                    }
                }
                expect(found).toBe(
                    true, "Unexpected 'event' emitted: " + event.getType()
                );
            });

            client.startClient();

            httpBackend.flush().done(function() {
                expect(expectedEvents.length).toEqual(
                    0, "Failed to see all events from /sync calls"
                );
                done();
            });
        });

        it("should emit User events", function(done) {
            httpBackend.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);
            var fired = false;
            client.on("User.presence", function(event, user) {
                fired = true;
                expect(user).toBeDefined();
                expect(event).toBeDefined();
                if (!user || !event) { return; }

                expect(event.event).toEqual(SYNC_DATA.presence.events[0]);
                expect(user.presence).toEqual(
                    SYNC_DATA.presence.events[0].content.presence
                );
            });
            client.startClient();

            httpBackend.flush().done(function() {
                expect(fired).toBe(true, "User.presence didn't fire.");
                done();
            });
        });

        it("should emit Room events", function(done) {
            httpBackend.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);
            var roomInvokeCount = 0;
            var roomNameInvokeCount = 0;
            var timelineFireCount = 0;
            client.on("Room", function(room) {
                roomInvokeCount++;
                expect(room.roomId).toEqual("!erufh:bar");
            });
            client.on("Room.timeline", function(event, room) {
                timelineFireCount++;
                expect(room.roomId).toEqual("!erufh:bar");
            });
            client.on("Room.name", function(room) {
                roomNameInvokeCount++;
            });

            client.startClient();

            httpBackend.flush().done(function() {
                expect(roomInvokeCount).toEqual(
                    1, "Room fired wrong number of times."
                );
                expect(roomNameInvokeCount).toEqual(
                    1, "Room.name fired wrong number of times."
                );
                expect(timelineFireCount).toEqual(
                    3, "Room.timeline fired the wrong number of times"
                );
                done();
            });
        });

        it("should emit RoomState events", function(done) {
            httpBackend.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);

            var roomStateEventTypes = [
                "m.room.member", "m.room.create"
            ];
            var eventsInvokeCount = 0;
            var membersInvokeCount = 0;
            var newMemberInvokeCount = 0;
            client.on("RoomState.events", function(event, state) {
                eventsInvokeCount++;
                var index = roomStateEventTypes.indexOf(event.getType());
                expect(index).not.toEqual(
                    -1, "Unexpected room state event type: " + event.getType()
                );
                if (index >= 0) {
                    roomStateEventTypes.splice(index, 1);
                }
            });
            client.on("RoomState.members", function(event, state, member) {
                membersInvokeCount++;
                expect(member.roomId).toEqual("!erufh:bar");
                expect(member.userId).toEqual("@foo:bar");
                expect(member.membership).toEqual("join");
            });
            client.on("RoomState.newMember", function(event, state, member) {
                newMemberInvokeCount++;
                expect(member.roomId).toEqual("!erufh:bar");
                expect(member.userId).toEqual("@foo:bar");
                expect(member.membership).toBeFalsy();
            });

            client.startClient();

            httpBackend.flush().done(function() {
                expect(membersInvokeCount).toEqual(
                    1, "RoomState.members fired wrong number of times"
                );
                expect(newMemberInvokeCount).toEqual(
                    1, "RoomState.newMember fired wrong number of times"
                );
                expect(eventsInvokeCount).toEqual(
                    2, "RoomState.events fired wrong number of times"
                );
                done();
            });
        });

        it("should emit RoomMember events", function(done) {
            httpBackend.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);

            var typingInvokeCount = 0;
            var powerLevelInvokeCount = 0;
            var nameInvokeCount = 0;
            var membershipInvokeCount = 0;
            client.on("RoomMember.name", function(event, member) {
                nameInvokeCount++;
            });
            client.on("RoomMember.typing", function(event, member) {
                typingInvokeCount++;
                expect(member.typing).toBe(true);
            });
            client.on("RoomMember.powerLevel", function(event, member) {
                powerLevelInvokeCount++;
            });
            client.on("RoomMember.membership", function(event, member) {
                membershipInvokeCount++;
                expect(member.membership).toEqual("join");
            });

            client.startClient();

            httpBackend.flush().done(function() {
                expect(typingInvokeCount).toEqual(
                    1, "RoomMember.typing fired wrong number of times"
                );
                expect(powerLevelInvokeCount).toEqual(
                    0, "RoomMember.powerLevel fired wrong number of times"
                );
                expect(nameInvokeCount).toEqual(
                    0, "RoomMember.name fired wrong number of times"
                );
                expect(membershipInvokeCount).toEqual(
                    1, "RoomMember.membership fired wrong number of times"
                );
                done();
            });
        });

        it("should emit Session.logged_out on M_UNKNOWN_TOKEN", function(done) {
            httpBackend.when("GET", "/sync").respond(401, { errcode: 'M_UNKNOWN_TOKEN' });

            var sessionLoggedOutCount = 0;
            client.on("Session.logged_out", function(event, member) {
                sessionLoggedOutCount++;
            });

            client.startClient();

            httpBackend.flush().done(function() {
                expect(sessionLoggedOutCount).toEqual(
                    1, "Session.logged_out fired wrong number of times"
                );
                done();
            });
        });
    });

});
