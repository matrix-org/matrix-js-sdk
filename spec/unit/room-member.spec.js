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

    describe("getAvatarUrl", function() {
        var hsUrl = "https://my.home.server";

        it("should return the URL from m.room.member preferentially", function() {
            member.events.member = utils.mkEvent({
                event: true,
                type: "m.room.member",
                skey: userA,
                room: roomId,
                user: userA,
                content: {
                    membership: "join",
                    avatar_url: "mxc://flibble/wibble"
                }
            });
            var url = member.getAvatarUrl(hsUrl);
            // we don't care about how the mxc->http conversion is done, other
            // than it contains the mxc body.
            expect(url.indexOf("flibble/wibble")).not.toEqual(-1);
        });

        it("should return an identicon HTTP URL if allowDefault was set and there " +
        "was no m.room.member event", function() {
            var url = member.getAvatarUrl(hsUrl, 64, 64, "crop", true);
            expect(url.indexOf("http")).toEqual(0); // don't care about form
        });

        it("should return nothing if there is no m.room.member and allowDefault=false",
        function() {
            var url = member.getAvatarUrl(hsUrl, 64, 64, "crop", false);
            expect(url).toEqual(null);
        });
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

        it("should emit 'RoomMember.powerLevel' if the power level changes.",
        function() {
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
            var emitCount = 0;

            member.on("RoomMember.powerLevel", function(emitEvent, emitMember) {
                emitCount += 1;
                expect(emitMember).toEqual(member);
                expect(emitEvent).toEqual(event);
            });

            member.setPowerLevelEvent(event);
            expect(emitCount).toEqual(1);
            member.setPowerLevelEvent(event); // no-op
            expect(emitCount).toEqual(1);
        });

        it("should honour power levels of zero.",
        function() {
            var event = utils.mkEvent({
                type: "m.room.power_levels",
                room: roomId,
                user: userA,
                content: {
                    users_default: 20,
                    users: {
                        "@alice:bar": 0,
                    }
                },
                event: true
            });
            var emitCount = 0;

            // set the power level to something other than zero or we
            // won't get an event
            member.powerLevel = 1;
            member.on("RoomMember.powerLevel", function(emitEvent, emitMember) {
                emitCount += 1;
                expect(emitMember.userId).toEqual('@alice:bar');
                expect(emitMember.powerLevel).toEqual(0);
                expect(emitEvent).toEqual(event);
            });

            member.setPowerLevelEvent(event);
            expect(member.powerLevel).toEqual(0);
            expect(emitCount).toEqual(1);
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

        it("should emit 'RoomMember.typing' if the typing state changes",
        function() {
            var event = utils.mkEvent({
                type: "m.typing",
                room: roomId,
                content: {
                    user_ids: [
                        userA, userC
                    ]
                },
                event: true
            });
            var emitCount = 0;
            member.on("RoomMember.typing", function(ev, mem) {
                expect(mem).toEqual(member);
                expect(ev).toEqual(event);
                emitCount += 1;
            });
            member.typing = false;
            member.setTypingEvent(event);
            expect(emitCount).toEqual(1);
            member.setTypingEvent(event); // no-op
            expect(emitCount).toEqual(1);
        });
    });

    describe("setMembershipEvent", function() {
        var joinEvent = utils.mkMembership({
            event: true,
            mship: "join",
            user: userA,
            room: roomId,
            name: "Alice"
        });

        var inviteEvent = utils.mkMembership({
            event: true,
            mship: "invite",
            user: userB,
            skey: userA,
            room: roomId
        });

        it("should set 'membership' and assign the event to 'events.member'.",
        function() {
            member.setMembershipEvent(inviteEvent);
            expect(member.membership).toEqual("invite");
            expect(member.events.member).toEqual(inviteEvent);
            member.setMembershipEvent(joinEvent);
            expect(member.membership).toEqual("join");
            expect(member.events.member).toEqual(joinEvent);
        });

        it("should set 'name' based on user_id, displayname and room state",
        function() {
            var roomState = {
                getStateEvents: function(type) {
                    if (type !== "m.room.member") { return []; }
                    return [
                        utils.mkMembership({
                            event: true, mship: "join", room: roomId,
                            user: userB
                        }),
                        utils.mkMembership({
                            event: true, mship: "join", room: roomId,
                            user: userC, name: "Alice"
                        }),
                        joinEvent
                    ];
                },
                getUserIdsWithDisplayName: function(displayName) {
                    return [userA, userC];
                }
            };
            expect(member.name).toEqual(userA); // default = user_id
            member.setMembershipEvent(joinEvent);
            expect(member.name).toEqual("Alice"); // prefer displayname
            member.setMembershipEvent(joinEvent, roomState);
            expect(member.name).not.toEqual("Alice"); // it should disambig.
            // user_id should be there somewhere
            expect(member.name.indexOf(userA)).not.toEqual(-1);
        });

        it("should emit 'RoomMember.membership' if the membership changes", function() {
            var emitCount = 0;
            member.on("RoomMember.membership", function(ev, mem) {
                emitCount += 1;
                expect(mem).toEqual(member);
                expect(ev).toEqual(inviteEvent);
            });
            member.setMembershipEvent(inviteEvent);
            expect(emitCount).toEqual(1);
            member.setMembershipEvent(inviteEvent); // no-op
            expect(emitCount).toEqual(1);
        });

        it("should emit 'RoomMember.name' if the name changes", function() {
            var emitCount = 0;
            member.on("RoomMember.name", function(ev, mem) {
                emitCount += 1;
                expect(mem).toEqual(member);
                expect(ev).toEqual(joinEvent);
            });
            member.setMembershipEvent(joinEvent);
            expect(emitCount).toEqual(1);
            member.setMembershipEvent(joinEvent); // no-op
            expect(emitCount).toEqual(1);
        });


    });

});
