"use strict";
var sdk = require("../..");
var RoomState = sdk.RoomState;
var utils = require("../test-utils");

describe("RoomState", function() {
    var roomId = "!foo:bar";
    var state;

    beforeEach(function() {
        utils.beforeEach(this);
        state = new RoomState(roomId);
    });

    describe("getMembers", function() {
        it("should return an empty list if there are no members", function() {

        });

        it("should return a member for each m.room.member event", function() {

        });
    });

    describe("getMember", function() {
        it("should return null if there is no member", function() {

        });

        it("should return a member if they exist", function() {

        });
    });

    describe("getSentinelMember", function() {
        it("should return null if there is no member", function() {

        });

        it("should return a member which doesn't change when the state is updated",
        function() {

        });
    });

    describe("getStateEvents", function() {
        it("should return null if a state_key was specified and there was no match",
        function() {

        });

        it("should return an empty list if a state_key was not specified and there" +
            " was no match", function() {

        });

        it("should return a list of matching events if no state_key was specified",
        function() {

        });

        it("should return a single MatrixEvent if a state_key was specified",
        function() {

        });
    });

    describe("setStateEvents", function() {
        it("should emit 'RoomState.members' for each m.room.member event", function() {

        });

        it("should emit 'RoomState.newMember' for each new member added", function() {

        });

        it("should emit 'RoomState.events' for each state event", function() {

        });

        it("should call setPowerLevelEvent on each RoomMember for m.room.power_levels",
        function() {

        });

        it("should call setPowerLevelEvent on a new RoomMember if power levels exist",
        function() {

        });

        it("should call setMembershipEvent on the right RoomMember", function() {

        });
    });

    describe("setTypingEvent", function() {
        it("should call setTypingEvent on each RoomMember", function() {

        });
    });
});