"use strict";
var sdk = require("../..");
var RoomMember = sdk.RoomMember;
var utils = require("../test-utils");

describe("RoomMember", function() {
    var roomId = "!foo:bar";
    var userA = "@alice:bar";
    var userB = "@bertha:bar";
    var userC = "@clarissa:bar";
    var member;

    beforeEach(function() {
        utils.beforeEach(this);
        member = new RoomMember(roomId, userA);
    });

    describe("setPowerLevelEvent", function() {
        it("should set 'powerLevel' and 'powerLevelNorm'.", function() {
            var event = utils.mkEvent({
                type: "m.room.power_levels",
                room: roomId,
                user: userA,
                content: {
                    users_default: 20,
                    users: {
                        "@bertha:bar": 200,
                        "@invalid:user": 10  // shouldn't barf on this.
                    }
                },
                event: true
            });
            member.setPowerLevelEvent(event);
            expect(member.powerLevel).toEqual(20);
            expect(member.powerLevelNorm).toEqual(10);

            var memberB = new RoomMember(roomId, userB);
            memberB.setPowerLevelEvent(event);
            expect(memberB.powerLevel).toEqual(200);
            expect(memberB.powerLevelNorm).toEqual(100);
        });
    });

    describe("setTypingEvent", function() {
        it("should set 'typing'", function() {
            member.typing = false;
            var memberB = new RoomMember(roomId, userB);
            memberB.typing = true;
            var memberC = new RoomMember(roomId, userC);
            memberC.typing = true;

            var event = utils.mkEvent({
                type: "m.typing",
                user: userA,
                room: roomId,
                content: {
                    user_ids: [
                        userA, userC
                    ]
                },
                event: true
            });
            member.setTypingEvent(event);
            memberB.setTypingEvent(event);
            memberC.setTypingEvent(event);

            expect(member.typing).toEqual(true);
            expect(memberB.typing).toEqual(false);
            expect(memberC.typing).toEqual(true);
        });
    });

});
