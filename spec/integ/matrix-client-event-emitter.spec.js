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
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("emissions", function() {
        var initialSync = {
            end: "s_5_3",
            presence: [{
                event_id: "$wefiuewh:bar",
                type: "m.presence",
                content: {
                    user_id: "@foo:bar",
                    displayname: "Foo Bar",
                    presence: "online"
                }
            }],
            rooms: [{
                room_id: "!erufh:bar",
                membership: "join",
                messages: {
                    start: "s",
                    end: "t",
                    chunk: [
                        utils.mkMessage({
                            room: "!erufh:bar", user: "@foo:bar", msg: "hmmm"
                        })
                    ]
                },
                state: [
                    utils.mkMembership({
                        room: "!erufh:bar", mship: "join", user: "@foo:bar"
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: "!erufh:bar", user: "@foo:bar",
                        content: {
                            creator: "@foo:bar"
                        }
                    })
                ]
            }]
        };
        var eventData = {
            start: "s_5_3",
            end: "e_6_7",
            chunk: [
                utils.mkMessage({
                    room: "!erufh:bar", user: "@foo:bar", msg: "ello ello"
                }),
                utils.mkMessage({
                    room: "!erufh:bar", user: "@foo:bar", msg: ":D"
                }),
                utils.mkEvent({
                    type: "m.typing", room: "!erufh:bar", content: {
                        user_ids: ["@foo:bar"]
                    }
                })
            ]
        };

        it("should emit events from both /initialSync and /events", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

            // initial sync events are unordered, so make an array of the types
            // that should be emitted and we'll just pick them off one by one,
            // so long as this is emptied we're good.
            var initialSyncEventTypes = [
                "m.presence", "m.room.member", "m.room.message", "m.room.create"
            ];
            var chunkIndex = 0;
            client.on("event", function(event) {
                if (initialSyncEventTypes.length === 0) {
                    if (chunkIndex + 1 >= eventData.chunk.length) {
                        return;
                    }
                    // this should be /events now
                    expect(eventData.chunk[chunkIndex].event_id).toEqual(
                        event.getId()
                    );
                    chunkIndex++;
                    return;
                }
                var index = initialSyncEventTypes.indexOf(event.getType());
                expect(index).not.toEqual(
                    -1, "Unexpected event type: " + event.getType()
                );
                if (index >= 0) {
                    initialSyncEventTypes.splice(index, 1);
                }
            });

            client.startClient();

            httpBackend.flush().done(function() {
                expect(initialSyncEventTypes.length).toEqual(
                    0, "Failed to see all events from /initialSync"
                );
                expect(chunkIndex + 1).toEqual(
                    eventData.chunk.length, "Failed to see all events from /events"
                );
                done();
            });
        });

        it("should emit User events", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);
            var fired = false;
            client.on("User.presence", function(event, user) {
                fired = true;
                expect(user).toBeDefined();
                expect(event).toBeDefined();
                if (!user || !event) { return; }

                expect(event.event).toEqual(initialSync.presence[0]);
                expect(user.presence).toEqual(
                    initialSync.presence[0].content.presence
                );
            });
            client.startClient();

            httpBackend.flush().done(function() {
                expect(fired).toBe(true, "User.presence didn't fire.");
                done();
            });
        });

        it("should emit Room events", function(done) {
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);
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
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

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
            httpBackend.when("GET", "/initialSync").respond(200, initialSync);
            httpBackend.when("GET", "/events").respond(200, eventData);

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
    });

});
