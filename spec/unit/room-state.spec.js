"use strict";
var sdk = require("../..");
var RoomState = sdk.RoomState;
var MatrixEvent = sdk.MatrixEvent;
var utils = require("../test-utils");

describe("RoomState", function() {
    var roomId = "!foo:bar";
    var userA = "@alice:bar";
    var userB = "@bertha:bar";
    var userC = "@clarissa:bar";
    var state;

    beforeEach(function() {
        utils.beforeEach(this);
        state = new RoomState(roomId);
    });

    // FIXME: Skip - This now belongs in RoomMember UTs
    xit("should set power levels for members on m.room.power_levels events",
    function() {
        // monkey-patch members (we aren't testing RoomMember logic here). Set
        // the levels to -1 to make sure that RoomState is 0ing-out the values.
        state.members = {
            "@alice:bar": {
                powerLevel: -1,
                powerLevelNorm: -1,
                roomId: roomId,
                userId: userA
            },
            "@bertha:bar": {
                powerLevel: -1,
                powerLevelNorm: -1,
                roomId: roomId,
                userId: userB
            }
        };

        state.setStateEvents([
            new MatrixEvent(
                utils.mkEvent("m.room.power_levels", roomId, userA, {
                    users_default: 20,
                    users: {
                        "@bertha:bar": 200,
                        "@invalid:user": 10  // shouldn't barf on this.
                    }
                })
            )
        ]);
        expect(state.members[userA].powerLevel).toEqual(20);
        expect(state.members[userA].powerLevelNorm).toEqual(10);
        expect(state.members[userB].powerLevel).toEqual(200);
        expect(state.members[userB].powerLevelNorm).toEqual(100);
    });

    // FIXME: Skip - This now belongs in RoomMember UTs
    xit("should set power levels retrospectively for members",
    function() {
        state.setStateEvents([
            new MatrixEvent(
                utils.mkEvent("m.room.power_levels", roomId, userA, {
                    users_default: 20,
                    users: {
                        "@clarissa:bar": 200
                    }
                })
            )
        ]);

        // Now add the room member events (it should calc power levels)
        state.setStateEvents([
            new MatrixEvent(utils.mkMembership(roomId, "join", userA)),
            new MatrixEvent(utils.mkMembership(roomId, "join", userA)),
            new MatrixEvent(
                utils.mkMembership(
                    roomId, "invite", userB, userC
                )
            )
        ]);

        expect(state.members[userA].powerLevel).toEqual(20);
        expect(state.members[userA].powerLevelNorm).toEqual(10);
        expect(state.members[userC].powerLevel).toEqual(200);
        expect(state.members[userC].powerLevelNorm).toEqual(100);
    });

    // FIXME: Skip - This now belongs in RoomMember UTs
    xit("should set typing notifications correctly on room members", function() {
        state.members = {
            "@alice:bar": {
                powerLevel: 0,
                powerLevelNorm: 0,
                typing: false,
                roomId: roomId,
                userId: userA
            },
            "@bertha:bar": {
                powerLevel: 0,
                powerLevelNorm: 0,
                typing: true,
                roomId: roomId,
                userId: userB
            },
            "@clarissa:bar": {
                powerLevel: 0,
                powerLevelNorm: 0,
                typing: true,
                roomId: roomId,
                userId: userC
            }
        };

        state.setTypingEvent(new MatrixEvent(
            utils.mkEvent("m.typing", roomId, userA, {
                user_ids: [
                    userA, userC
                ]
            })
        ));

        expect(state.members[userA].typing).toEqual(true);
        expect(state.members[userB].typing).toEqual(false);
        expect(state.members[userC].typing).toEqual(true);
    });

});
