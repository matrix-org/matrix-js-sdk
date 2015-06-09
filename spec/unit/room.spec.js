"use strict";
var sdk = require("../..");
var Room = sdk.Room;
var MatrixEvent = sdk.MatrixEvent;
var utils = require("../test-utils");

describe("Room", function() {
    var roomId = "!foo:bar";
    var userA = "@alice:bar";
    var room;

    beforeEach(function() {
        utils.beforeEach(this);
        room = new Room(roomId);
    });

    describe("getMember", function() {
        beforeEach(function() {
            room.currentState.members = {
                "@alice:bar": {
                    userId: userA,
                    roomId: roomId
                }
            };
        });

        it("should return null if the member isn't in current state", function() {
            expect(room.getMember("@bar:foo")).toEqual(null);
        });

        it("should return the member from current state", function() {
            expect(room.getMember(userA)).not.toEqual(null);
        });
    });

    describe("addEventsToTimeline", function() {
        var events = [
            new MatrixEvent(utils.mkMessage(roomId, userA, "changing room name")),
            new MatrixEvent(utils.mkEvent("m.room.name", roomId, userA, {
                name: "New Room Name"
            }))
        ];
        it("should be able to add events to the end", function() {
            room.addEventsToTimeline(events);
            expect(room.timeline.length).toEqual(2);
            expect(room.timeline[0]).toEqual(events[0]);
            expect(room.timeline[1]).toEqual(events[1]);
        });

        it("should be able to add events to the start", function() {
            room.addEventsToTimeline(events, true);
            expect(room.timeline.length).toEqual(2);
            expect(room.timeline[0]).toEqual(events[1]);
            expect(room.timeline[1]).toEqual(events[0]);
        });
    });
});
