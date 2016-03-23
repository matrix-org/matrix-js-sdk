"use strict";
var sdk = require("../..");
var RoomState = sdk.RoomState;
var RoomMember = sdk.RoomMember;
var utils = require("../test-utils");

describe("RoomState", function() {
    var roomId = "!foo:bar";
    var userA = "@alice:bar";
    var userB = "@bob:bar";
    var state;

    beforeEach(function() {
        utils.beforeEach(this);
        state = new RoomState(roomId);
        state.setStateEvents([
            utils.mkMembership({  // userA joined
                event: true, mship: "join", user: userA, room: roomId
            }),
            utils.mkMembership({  // userB joined
                event: true, mship: "join", user: userB, room: roomId
            }),
            utils.mkEvent({  // Room name is "Room name goes here"
                type: "m.room.name", user: userA, room: roomId, event: true, content: {
                    name: "Room name goes here"
                }
            }),
            utils.mkEvent({  // Room creation
                type: "m.room.create", user: userA, room: roomId, event: true, content: {
                    creator: userA
                }
            })
        ]);
    });

    describe("getMembers", function() {
        it("should return an empty list if there are no members", function() {
            state = new RoomState(roomId);
            expect(state.getMembers().length).toEqual(0);
        });

        it("should return a member for each m.room.member event", function() {
            var members = state.getMembers();
            expect(members.length).toEqual(2);
            // ordering unimportant
            expect([userA, userB].indexOf(members[0].userId)).not.toEqual(-1);
            expect([userA, userB].indexOf(members[1].userId)).not.toEqual(-1);
        });
    });

    describe("getMember", function() {
        it("should return null if there is no member", function() {
            expect(state.getMember("@no-one:here")).toEqual(null);
        });

        it("should return a member if they exist", function() {
            expect(state.getMember(userB)).toBeDefined();
        });

        it("should return a member which changes as state changes", function() {
            var member = state.getMember(userB);
            expect(member.membership).toEqual("join");
            expect(member.name).toEqual(userB);

            state.setStateEvents([
                utils.mkMembership({
                    room: roomId, user: userB, mship: "leave", event: true,
                    name: "BobGone"
                })
            ]);

            expect(member.membership).toEqual("leave");
            expect(member.name).toEqual("BobGone");
        });
    });

    describe("getSentinelMember", function() {
        it("should return null if there is no member", function() {
            expect(state.getSentinelMember("@no-one:here")).toEqual(null);
        });

        it("should return a member which doesn't change when the state is updated",
        function() {
            var preLeaveUser = state.getSentinelMember(userA);
            state.setStateEvents([
                utils.mkMembership({
                    room: roomId, user: userA, mship: "leave", event: true,
                    name: "AliceIsGone"
                })
            ]);
            var postLeaveUser = state.getSentinelMember(userA);

            expect(preLeaveUser.membership).toEqual("join");
            expect(preLeaveUser.name).toEqual(userA);

            expect(postLeaveUser.membership).toEqual("leave");
            expect(postLeaveUser.name).toEqual("AliceIsGone");
        });
    });

    describe("getStateEvents", function() {
        it("should return null if a state_key was specified and there was no match",
        function() {
            expect(state.getStateEvents("foo.bar.baz", "keyname")).toEqual(null);
        });

        it("should return an empty list if a state_key was not specified and there" +
            " was no match", function() {
            expect(state.getStateEvents("foo.bar.baz")).toEqual([]);
        });

        it("should return a list of matching events if no state_key was specified",
        function() {
            var events = state.getStateEvents("m.room.member");
            expect(events.length).toEqual(2);
            // ordering unimportant
            expect([userA, userB].indexOf(events[0].getStateKey())).not.toEqual(-1);
            expect([userA, userB].indexOf(events[1].getStateKey())).not.toEqual(-1);
        });

        it("should return a single MatrixEvent if a state_key was specified",
        function() {
            var event = state.getStateEvents("m.room.member", userA);
            expect(event.getContent()).toEqual({
                membership: "join"
            });
        });
    });

    describe("setStateEvents", function() {
        it("should emit 'RoomState.members' for each m.room.member event", function() {
            var memberEvents = [
                utils.mkMembership({
                    user: "@cleo:bar", mship: "invite", room: roomId, event: true
                }),
                utils.mkMembership({
                    user: "@daisy:bar", mship: "join", room: roomId, event: true
                })
            ];
            var emitCount = 0;
            state.on("RoomState.members", function(ev, st, mem) {
                expect(ev).toEqual(memberEvents[emitCount]);
                expect(st).toEqual(state);
                expect(mem).toEqual(state.getMember(ev.getSender()));
                emitCount += 1;
            });
            state.setStateEvents(memberEvents);
            expect(emitCount).toEqual(2);
        });

        it("should emit 'RoomState.newMember' for each new member added", function() {
            var memberEvents = [
                utils.mkMembership({
                    user: "@cleo:bar", mship: "invite", room: roomId, event: true
                }),
                utils.mkMembership({
                    user: "@daisy:bar", mship: "join", room: roomId, event: true
                })
            ];
            var emitCount = 0;
            state.on("RoomState.newMember", function(ev, st, mem) {
                expect(mem.userId).toEqual(memberEvents[emitCount].getSender());
                expect(mem.membership).toBeFalsy();  // not defined yet
                emitCount += 1;
            });
            state.setStateEvents(memberEvents);
            expect(emitCount).toEqual(2);
        });

        it("should emit 'RoomState.events' for each state event", function() {
            var events = [
                utils.mkMembership({
                    user: "@cleo:bar", mship: "invite", room: roomId, event: true
                }),
                utils.mkEvent({
                    user: userB, room: roomId, type: "m.room.topic", event: true,
                    content: {
                        topic: "boo!"
                    }
                }),
                utils.mkMessage({  // Not a state event
                    user: userA, room: roomId, event: true
                })
            ];
            var emitCount = 0;
            state.on("RoomState.events", function(ev, st) {
                expect(ev).toEqual(events[emitCount]);
                expect(st).toEqual(state);
                emitCount += 1;
            });
            state.setStateEvents(events);
            expect(emitCount).toEqual(2);
        });

        it("should call setPowerLevelEvent on each RoomMember for m.room.power_levels",
        function() {
            // mock up the room members
            state.members[userA] = utils.mock(RoomMember);
            state.members[userB] = utils.mock(RoomMember);

            var powerLevelEvent = utils.mkEvent({
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    users_default: 10,
                    state_default: 50,
                    events_default: 25
                }
            });

            state.setStateEvents([powerLevelEvent]);

            expect(state.members[userA].setPowerLevelEvent).toHaveBeenCalledWith(
                powerLevelEvent
            );
            expect(state.members[userB].setPowerLevelEvent).toHaveBeenCalledWith(
                powerLevelEvent
            );
        });

        it("should call setPowerLevelEvent on a new RoomMember if power levels exist",
        function() {
            var userC = "@cleo:bar";
            var memberEvent = utils.mkMembership({
                mship: "join", user: userC, room: roomId, event: true
            });
            var powerLevelEvent = utils.mkEvent({
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    users_default: 10,
                    state_default: 50,
                    events_default: 25,
                    users: {}
                }
            });

            state.setStateEvents([powerLevelEvent]);
            state.setStateEvents([memberEvent]);

            // TODO: We do this because we don't DI the RoomMember constructor
            // so we can't inject a mock :/ so we have to infer.
            expect(state.members[userC]).toBeDefined();
            expect(state.members[userC].powerLevel).toEqual(10);
        });

        it("should call setMembershipEvent on the right RoomMember", function() {
            // mock up the room members
            state.members[userA] = utils.mock(RoomMember);
            state.members[userB] = utils.mock(RoomMember);

            var memberEvent = utils.mkMembership({
                user: userB, mship: "leave", room: roomId, event: true
            });
            state.setStateEvents([memberEvent]);

            expect(state.members[userA].setMembershipEvent).not.toHaveBeenCalled();
            expect(state.members[userB].setMembershipEvent).toHaveBeenCalledWith(
                memberEvent, state
            );
        });
    });

    describe("setTypingEvent", function() {
        it("should call setTypingEvent on each RoomMember", function() {
            var typingEvent = utils.mkEvent({
                type: "m.typing", room: roomId, event: true, content: {
                    user_ids: [userA]
                }
            });
            // mock up the room members
            state.members[userA] = utils.mock(RoomMember);
            state.members[userB] = utils.mock(RoomMember);
            state.setTypingEvent(typingEvent);

            expect(state.members[userA].setTypingEvent).toHaveBeenCalledWith(
                typingEvent
            );
            expect(state.members[userB].setTypingEvent).toHaveBeenCalledWith(
                typingEvent
            );
        });
    });

    describe("maySendStateEvent", function() {
        it("should say non-joined members may not send state",
        function() {
            expect(state.maySendStateEvent(
                'm.room.name', "@nobody:nowhere"
            )).toEqual(false);
        });

        it("should say any member may send state with no power level event",
        function() {
            expect(state.maySendStateEvent('m.room.name', userA)).toEqual(true);
        });

        it("should say members with power >=50 may send state with power level event " +
        "but no state default",
        function() {
            var powerLevelEvent = {
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    users_default: 10,
                    // state_default: 50, "intentionally left blank"
                    events_default: 25,
                    users: {
                    }
                }
            };
            powerLevelEvent.content.users[userA] = 50;

            state.setStateEvents([utils.mkEvent(powerLevelEvent)]);

            expect(state.maySendStateEvent('m.room.name', userA)).toEqual(true);
            expect(state.maySendStateEvent('m.room.name', userB)).toEqual(false);
        });

        it("should obey state_default",
        function() {
            var powerLevelEvent = {
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    users_default: 10,
                    state_default: 30,
                    events_default: 25,
                    users: {
                    }
                }
            };
            powerLevelEvent.content.users[userA] = 30;
            powerLevelEvent.content.users[userB] = 29;

            state.setStateEvents([utils.mkEvent(powerLevelEvent)]);

            expect(state.maySendStateEvent('m.room.name', userA)).toEqual(true);
            expect(state.maySendStateEvent('m.room.name', userB)).toEqual(false);
        });

        it("should honour explicit event power levels in the power_levels event",
        function() {
            var powerLevelEvent = {
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    events: {
                        "m.room.other_thing": 76
                    },
                    users_default: 10,
                    state_default: 50,
                    events_default: 25,
                    users: {
                    }
                }
            };
            powerLevelEvent.content.users[userA] = 80;
            powerLevelEvent.content.users[userB] = 50;

            state.setStateEvents([utils.mkEvent(powerLevelEvent)]);

            expect(state.maySendStateEvent('m.room.name', userA)).toEqual(true);
            expect(state.maySendStateEvent('m.room.name', userB)).toEqual(true);

            expect(state.maySendStateEvent('m.room.other_thing', userA)).toEqual(true);
            expect(state.maySendStateEvent('m.room.other_thing', userB)).toEqual(false);
        });
    });

    describe("maySendEvent", function() {
        it("should say non-joined members may not send events",
        function() {
            expect(state.maySendEvent(
                'm.room.message', "@nobody:nowhere"
            )).toEqual(false);
            expect(state.maySendMessage("@nobody:nowhere")).toEqual(false);
        });

        it("should say any member may send events with no power level event",
        function() {
            expect(state.maySendEvent('m.room.message', userA)).toEqual(true);
            expect(state.maySendMessage(userA)).toEqual(true);
        });

        it("should obey events_default",
        function() {
            var powerLevelEvent = {
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    users_default: 10,
                    state_default: 30,
                    events_default: 25,
                    users: {
                    }
                }
            };
            powerLevelEvent.content.users[userA] = 26;
            powerLevelEvent.content.users[userB] = 24;

            state.setStateEvents([utils.mkEvent(powerLevelEvent)]);

            expect(state.maySendEvent('m.room.message', userA)).toEqual(true);
            expect(state.maySendEvent('m.room.message', userB)).toEqual(false);

            expect(state.maySendMessage(userA)).toEqual(true);
            expect(state.maySendMessage(userB)).toEqual(false);
        });

        it("should honour explicit event power levels in the power_levels event",
        function() {
            var powerLevelEvent = {
                type: "m.room.power_levels", room: roomId, user: userA, event: true,
                content: {
                    events: {
                        "m.room.other_thing": 33
                    },
                    users_default: 10,
                    state_default: 50,
                    events_default: 25,
                    users: {
                    }
                }
            };
            powerLevelEvent.content.users[userA] = 40;
            powerLevelEvent.content.users[userB] = 30;

            state.setStateEvents([utils.mkEvent(powerLevelEvent)]);

            expect(state.maySendEvent('m.room.message', userA)).toEqual(true);
            expect(state.maySendEvent('m.room.message', userB)).toEqual(true);

            expect(state.maySendMessage(userA)).toEqual(true);
            expect(state.maySendMessage(userB)).toEqual(true);

            expect(state.maySendEvent('m.room.other_thing', userA)).toEqual(true);
            expect(state.maySendEvent('m.room.other_thing', userB)).toEqual(false);
        });
    });
});
