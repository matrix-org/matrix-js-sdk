"use strict";
var sdk = require("../..");
var RoomState = sdk.RoomState;
var MatrixEvent = sdk.MatrixEvent;
var utils = require("../test-utils");

describe("RoomState", function() {
    var roomId = "!foo:bar";
    var state;

    beforeEach(function() {
        utils.beforeEach(this);
        state = new RoomState(roomId);
    });

    it("should set power levels for members on m.room.power_levels events",
    function() {
        // monkey-patch members (we aren't testing RoomMember logic here). Set
        // the levels to -1 to make sure that RoomState is 0ing-out the values.
        state.members = {
            "@alice:bar": {
                powerLevel: -1,
                powerLevelNorm: -1,
                roomId: roomId,
                userId: "@alice:bar"
            },
            "@bertha:bar": {
                powerLevel: -1,
                powerLevelNorm: -1,
                roomId: roomId,
                userId: "@bertha:bar"
            }
        };

        state.setStateEvents([
            new MatrixEvent(
                utils.mkEvent("m.room.power_levels", roomId, "@alice:bar", {
                    users_default: 20,
                    users: {
                        "@bertha:bar": 200,
                        "@invalid:user": 10  // shouldn't barf on this.
                    }
                })
            )
        ]);
        expect(state.members["@alice:bar"].powerLevel).toEqual(20);
        expect(state.members["@alice:bar"].powerLevelNorm).toEqual(10);
        expect(state.members["@bertha:bar"].powerLevel).toEqual(200);
        expect(state.members["@bertha:bar"].powerLevelNorm).toEqual(100);
    });

    it("should set power levels retrospectively for members",
    function() {
        state.setStateEvents([
            new MatrixEvent(
                utils.mkEvent("m.room.power_levels", roomId, "@alice:bar", {
                    users_default: 20,
                    users: {
                        "@clarissa:bar": 200
                    }
                })
            )
        ]);

        // Now add the room member events (it should calc power levels)
        state.setStateEvents([
            new MatrixEvent(utils.mkMembership(roomId, "join", "@alice:bar")),
            new MatrixEvent(utils.mkMembership(roomId, "join", "@bertha:bar")),
            new MatrixEvent(
                utils.mkMembership(
                    roomId, "invite", "@bertha:bar", "@clarissa:bar"
                )
            )
        ]);

        expect(state.members["@alice:bar"].powerLevel).toEqual(20);
        expect(state.members["@alice:bar"].powerLevelNorm).toEqual(10);
        expect(state.members["@clarissa:bar"].powerLevel).toEqual(200);
        expect(state.members["@clarissa:bar"].powerLevelNorm).toEqual(100);
    });

});
