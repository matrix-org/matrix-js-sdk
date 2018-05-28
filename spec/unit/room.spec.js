"use strict";
import 'source-map-support/register';
const sdk = require("../..");
const Room = sdk.Room;
const RoomState = sdk.RoomState;
const MatrixEvent = sdk.MatrixEvent;
const EventStatus = sdk.EventStatus;
const EventTimeline = sdk.EventTimeline;
const utils = require("../test-utils");

import expect from 'expect';

describe("Room", function() {
    const roomId = "!foo:bar";
    const userA = "@alice:bar";
    const userB = "@bertha:bar";
    const userC = "@clarissa:bar";
    const userD = "@dorothy:bar";
    let room;

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
        room = new Room(roomId);
        // mock RoomStates
        room.oldState = room.getLiveTimeline()._startState =
            utils.mock(sdk.RoomState, "oldState");
        room.currentState = room.getLiveTimeline()._endState =
            utils.mock(sdk.RoomState, "currentState");
    });

    describe("getAvatarUrl", function() {
        const hsUrl = "https://my.home.server";

        it("should return the URL from m.room.avatar preferentially", function() {
            room.currentState.getStateEvents.andCall(function(type, key) {
                if (type === "m.room.avatar" && key === "") {
                    return utils.mkEvent({
                        event: true,
                        type: "m.room.avatar",
                        skey: "",
                        room: roomId,
                        user: userA,
                        content: {
                            url: "mxc://flibble/wibble",
                        },
                    });
                }
            });
            const url = room.getAvatarUrl(hsUrl);
            // we don't care about how the mxc->http conversion is done, other
            // than it contains the mxc body.
            expect(url.indexOf("flibble/wibble")).toNotEqual(-1);
        });

        it("should return an identicon HTTP URL if allowDefault was set and there " +
        "was no m.room.avatar event", function() {
            const url = room.getAvatarUrl(hsUrl, 64, 64, "crop", true);
            expect(url.indexOf("http")).toEqual(0); // don't care about form
        });

        it("should return nothing if there is no m.room.avatar and allowDefault=false",
        function() {
            const url = room.getAvatarUrl(hsUrl, 64, 64, "crop", false);
            expect(url).toEqual(null);
        });
    });

    describe("getMember", function() {
        beforeEach(function() {
            // clobber members property with test data
            room.currentState.members = {
                "@alice:bar": {
                    userId: userA,
                    roomId: roomId,
                },
            };
        });

        it("should return null if the member isn't in current state", function() {
            expect(room.getMember("@bar:foo")).toEqual(null);
        });

        it("should return the member from current state", function() {
            expect(room.getMember(userA)).toNotEqual(null);
        });
    });

    describe("addLiveEvents", function() {
        const events = [
            utils.mkMessage({
                room: roomId, user: userA, msg: "changing room name", event: true,
            }),
            utils.mkEvent({
                type: "m.room.name", room: roomId, user: userA, event: true,
                content: { name: "New Room Name" },
            }),
        ];

        it("should call RoomState.setTypingEvent on m.typing events", function() {
            room.currentState = utils.mock(RoomState);
            const typing = utils.mkEvent({
                room: roomId, type: "m.typing", event: true, content: {
                    user_ids: [userA],
                },
            });
            room.addLiveEvents([typing]);
            expect(room.currentState.setTypingEvent).toHaveBeenCalledWith(typing);
        });

        it("should throw if duplicateStrategy isn't 'replace' or 'ignore'", function() {
            expect(function() {
                room.addLiveEvents(events, "foo");
            }).toThrow();
        });

        it("should replace a timeline event if dupe strategy is 'replace'", function() {
            // make a duplicate
            const dupe = utils.mkMessage({
                room: roomId, user: userA, msg: "dupe", event: true,
            });
            dupe.event.event_id = events[0].getId();
            room.addLiveEvents(events);
            expect(room.timeline[0]).toEqual(events[0]);
            room.addLiveEvents([dupe], "replace");
            expect(room.timeline[0]).toEqual(dupe);
        });

        it("should ignore a given dupe event if dupe strategy is 'ignore'", function() {
            // make a duplicate
            const dupe = utils.mkMessage({
                room: roomId, user: userA, msg: "dupe", event: true,
            });
            dupe.event.event_id = events[0].getId();
            room.addLiveEvents(events);
            expect(room.timeline[0]).toEqual(events[0]);
            room.addLiveEvents([dupe], "ignore");
            expect(room.timeline[0]).toEqual(events[0]);
        });

        it("should emit 'Room.timeline' events",
        function() {
            let callCount = 0;
            room.on("Room.timeline", function(event, emitRoom, toStart) {
                callCount += 1;
                expect(room.timeline.length).toEqual(callCount);
                expect(event).toEqual(events[callCount - 1]);
                expect(emitRoom).toEqual(room);
                expect(toStart).toBeFalsy();
            });
            room.addLiveEvents(events);
            expect(callCount).toEqual(2);
        });

        it("should call setStateEvents on the right RoomState with the right " +
        "forwardLooking value for new events", function() {
            const events = [
                utils.mkMembership({
                    room: roomId, mship: "invite", user: userB, skey: userA, event: true,
                }),
                utils.mkEvent({
                    type: "m.room.name", room: roomId, user: userB, event: true,
                    content: {
                        name: "New room",
                    },
                }),
            ];
            room.addLiveEvents(events);
            expect(room.currentState.setStateEvents).toHaveBeenCalledWith(
                [events[0]],
            );
            expect(room.currentState.setStateEvents).toHaveBeenCalledWith(
                [events[1]],
            );
            expect(events[0].forwardLooking).toBe(true);
            expect(events[1].forwardLooking).toBe(true);
            expect(room.oldState.setStateEvents).toNotHaveBeenCalled();
        });

        it("should synthesize read receipts for the senders of events", function() {
            const sentinel = {
                userId: userA,
                membership: "join",
                name: "Alice",
            };
            room.currentState.getSentinelMember.andCall(function(uid) {
                if (uid === userA) {
                    return sentinel;
                }
                return null;
            });
            room.addLiveEvents(events);
            expect(room.getEventReadUpTo(userA)).toEqual(events[1].getId());
        });

        it("should emit Room.localEchoUpdated when a local echo is updated", function() {
            const localEvent = utils.mkMessage({
                room: roomId, user: userA, event: true,
            });
            localEvent.status = EventStatus.SENDING;
            const localEventId = localEvent.getId();

            const remoteEvent = utils.mkMessage({
                room: roomId, user: userA, event: true,
            });
            remoteEvent.event.unsigned = {transaction_id: "TXN_ID"};
            const remoteEventId = remoteEvent.getId();

            let callCount = 0;
            room.on("Room.localEchoUpdated",
                function(event, emitRoom, oldEventId, oldStatus) {
                    switch (callCount) {
                    case 0:
                        expect(event.getId()).toEqual(localEventId);
                        expect(event.status).toEqual(EventStatus.SENDING);
                        expect(emitRoom).toEqual(room);
                        expect(oldEventId).toBe(null);
                        expect(oldStatus).toBe(null);
                        break;
                    case 1:
                        expect(event.getId()).toEqual(remoteEventId);
                        expect(event.status).toBe(null);
                        expect(emitRoom).toEqual(room);
                        expect(oldEventId).toEqual(localEventId);
                        expect(oldStatus).toBe(EventStatus.SENDING);
                        break;
                    }
                    callCount += 1;
                },
            );

            // first add the local echo
            room.addPendingEvent(localEvent, "TXN_ID");
            expect(room.timeline.length).toEqual(1);

            // then the remoteEvent
            room.addLiveEvents([remoteEvent]);
            expect(room.timeline.length).toEqual(1);

            expect(callCount).toEqual(2);
        });
    });

    describe("addEventsToTimeline", function() {
        const events = [
            utils.mkMessage({
                room: roomId, user: userA, msg: "changing room name", event: true,
            }),
            utils.mkEvent({
                type: "m.room.name", room: roomId, user: userA, event: true,
                content: { name: "New Room Name" },
            }),
        ];

        it("should not be able to add events to the end", function() {
            expect(function() {
                room.addEventsToTimeline(events, false, room.getLiveTimeline());
            }).toThrow();
        });

        it("should be able to add events to the start", function() {
            room.addEventsToTimeline(events, true, room.getLiveTimeline());
            expect(room.timeline.length).toEqual(2);
            expect(room.timeline[0]).toEqual(events[1]);
            expect(room.timeline[1]).toEqual(events[0]);
        });

        it("should emit 'Room.timeline' events when added to the start",
        function() {
            let callCount = 0;
            room.on("Room.timeline", function(event, emitRoom, toStart) {
                callCount += 1;
                expect(room.timeline.length).toEqual(callCount);
                expect(event).toEqual(events[callCount - 1]);
                expect(emitRoom).toEqual(room);
                expect(toStart).toBe(true);
            });
            room.addEventsToTimeline(events, true, room.getLiveTimeline());
            expect(callCount).toEqual(2);
        });
    });

    describe("event metadata handling", function() {
        it("should set event.sender for new and old events", function() {
            const sentinel = {
                userId: userA,
                membership: "join",
                name: "Alice",
            };
            const oldSentinel = {
                userId: userA,
                membership: "join",
                name: "Old Alice",
            };
            room.currentState.getSentinelMember.andCall(function(uid) {
                if (uid === userA) {
                    return sentinel;
                }
                return null;
            });
            room.oldState.getSentinelMember.andCall(function(uid) {
                if (uid === userA) {
                    return oldSentinel;
                }
                return null;
            });

            const newEv = utils.mkEvent({
                type: "m.room.name", room: roomId, user: userA, event: true,
                content: { name: "New Room Name" },
            });
            const oldEv = utils.mkEvent({
                type: "m.room.name", room: roomId, user: userA, event: true,
                content: { name: "Old Room Name" },
            });
            room.addLiveEvents([newEv]);
            expect(newEv.sender).toEqual(sentinel);
            room.addEventsToTimeline([oldEv], true, room.getLiveTimeline());
            expect(oldEv.sender).toEqual(oldSentinel);
        });

        it("should set event.target for new and old m.room.member events",
        function() {
            const sentinel = {
                userId: userA,
                membership: "join",
                name: "Alice",
            };
            const oldSentinel = {
                userId: userA,
                membership: "join",
                name: "Old Alice",
            };
            room.currentState.getSentinelMember.andCall(function(uid) {
                if (uid === userA) {
                    return sentinel;
                }
                return null;
            });
            room.oldState.getSentinelMember.andCall(function(uid) {
                if (uid === userA) {
                    return oldSentinel;
                }
                return null;
            });

            const newEv = utils.mkMembership({
                room: roomId, mship: "invite", user: userB, skey: userA, event: true,
            });
            const oldEv = utils.mkMembership({
                room: roomId, mship: "ban", user: userB, skey: userA, event: true,
            });
            room.addLiveEvents([newEv]);
            expect(newEv.target).toEqual(sentinel);
            room.addEventsToTimeline([oldEv], true, room.getLiveTimeline());
            expect(oldEv.target).toEqual(oldSentinel);
        });

        it("should call setStateEvents on the right RoomState with the right " +
        "forwardLooking value for old events", function() {
            const events = [
                utils.mkMembership({
                    room: roomId, mship: "invite", user: userB, skey: userA, event: true,
                }),
                utils.mkEvent({
                    type: "m.room.name", room: roomId, user: userB, event: true,
                    content: {
                        name: "New room",
                    },
                }),
            ];

            room.addEventsToTimeline(events, true, room.getLiveTimeline());
            expect(room.oldState.setStateEvents).toHaveBeenCalledWith(
                [events[0]],
            );
            expect(room.oldState.setStateEvents).toHaveBeenCalledWith(
                [events[1]],
            );
            expect(events[0].forwardLooking).toBe(false);
            expect(events[1].forwardLooking).toBe(false);
            expect(room.currentState.setStateEvents).toNotHaveBeenCalled();
        });
    });

    const resetTimelineTests = function(timelineSupport) {
        let events = null;

        beforeEach(function() {
            room = new Room(roomId, {timelineSupport: timelineSupport});
            // set events each time to avoid resusing Event objects (which
            // doesn't work because they get frozen)
            events = [
                utils.mkMessage({
                    room: roomId, user: userA, msg: "A message", event: true,
                }),
                utils.mkEvent({
                    type: "m.room.name", room: roomId, user: userA, event: true,
                    content: { name: "New Room Name" },
                }),
                utils.mkEvent({
                    type: "m.room.name", room: roomId, user: userA, event: true,
                    content: { name: "Another New Name" },
                }),
            ];
        });

        it("should copy state from previous timeline", function() {
            room.addLiveEvents([events[0], events[1]]);
            expect(room.getLiveTimeline().getEvents().length).toEqual(2);
            room.resetLiveTimeline('sometoken', 'someothertoken');

            room.addLiveEvents([events[2]]);
            const oldState = room.getLiveTimeline().getState(EventTimeline.BACKWARDS);
            const newState = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
            expect(room.getLiveTimeline().getEvents().length).toEqual(1);
            expect(oldState.getStateEvents("m.room.name", "")).toEqual(events[1]);
            expect(newState.getStateEvents("m.room.name", "")).toEqual(events[2]);
        });

        it("should reset the legacy timeline fields", function() {
            room.addLiveEvents([events[0], events[1]]);
            expect(room.timeline.length).toEqual(2);
            room.resetLiveTimeline('sometoken', 'someothertoken');

            room.addLiveEvents([events[2]]);
            const newLiveTimeline = room.getLiveTimeline();
            expect(room.timeline).toEqual(newLiveTimeline.getEvents());
            expect(room.oldState).toEqual(
                newLiveTimeline.getState(EventTimeline.BACKWARDS));
            expect(room.currentState).toEqual(
                newLiveTimeline.getState(EventTimeline.FORWARDS));
        });

        it("should emit Room.timelineReset event and set the correct " +
                 "pagination token", function() {
            let callCount = 0;
            room.on("Room.timelineReset", function(emitRoom) {
                callCount += 1;
                expect(emitRoom).toEqual(room);

                // make sure that the pagination token has been set before the
                // event is emitted.
                const tok = emitRoom.getLiveTimeline()
                    .getPaginationToken(EventTimeline.BACKWARDS);

                expect(tok).toEqual("pagToken");
            });
            room.resetLiveTimeline("pagToken");
            expect(callCount).toEqual(1);
        });

        it("should " + (timelineSupport ? "remember" : "forget") +
                " old timelines", function() {
            room.addLiveEvents([events[0]]);
            expect(room.timeline.length).toEqual(1);
            const firstLiveTimeline = room.getLiveTimeline();
            room.resetLiveTimeline('sometoken', 'someothertoken');

            const tl = room.getTimelineForEvent(events[0].getId());
            expect(tl).toBe(timelineSupport ? firstLiveTimeline : null);
        });
    };

    describe("resetLiveTimeline with timelinesupport enabled",
             resetTimelineTests.bind(null, true));
    describe("resetLiveTimeline with timelinesupport disabled",
             resetTimelineTests.bind(null, false));

    describe("compareEventOrdering", function() {
        beforeEach(function() {
            room = new Room(roomId, {timelineSupport: true});
        });

        const events = [
            utils.mkMessage({
                room: roomId, user: userA, msg: "1111", event: true,
            }),
            utils.mkMessage({
                room: roomId, user: userA, msg: "2222", event: true,
            }),
            utils.mkMessage({
                room: roomId, user: userA, msg: "3333", event: true,
            }),
        ];

        it("should handle events in the same timeline", function() {
            room.addLiveEvents(events);

            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[0].getId(),
                                                               events[1].getId()))
                .toBeLessThan(0);
            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[2].getId(),
                                                               events[1].getId()))
                .toBeGreaterThan(0);
            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[1].getId(),
                                                               events[1].getId()))
                .toEqual(0);
        });

        it("should handle events in adjacent timelines", function() {
            const oldTimeline = room.addTimeline();
            oldTimeline.setNeighbouringTimeline(room.getLiveTimeline(), 'f');
            room.getLiveTimeline().setNeighbouringTimeline(oldTimeline, 'b');

            room.addEventsToTimeline([events[0]], false, oldTimeline);
            room.addLiveEvents([events[1]]);

            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[0].getId(),
                                                               events[1].getId()))
                .toBeLessThan(0);
            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[1].getId(),
                                                               events[0].getId()))
                .toBeGreaterThan(0);
        });

        it("should return null for events in non-adjacent timelines", function() {
            const oldTimeline = room.addTimeline();

            room.addEventsToTimeline([events[0]], false, oldTimeline);
            room.addLiveEvents([events[1]]);

            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[0].getId(),
                                                               events[1].getId()))
                .toBe(null);
            expect(room.getUnfilteredTimelineSet().compareEventOrdering(events[1].getId(),
                                                               events[0].getId()))
                .toBe(null);
        });

        it("should return null for unknown events", function() {
            room.addLiveEvents(events);

            expect(room.getUnfilteredTimelineSet()
                       .compareEventOrdering(events[0].getId(), "xxx"))
                       .toBe(null);
            expect(room.getUnfilteredTimelineSet()
                       .compareEventOrdering("xxx", events[0].getId()))
                       .toBe(null);
            expect(room.getUnfilteredTimelineSet()
                       .compareEventOrdering(events[0].getId(), events[0].getId()))
                       .toBe(0);
        });
    });

    describe("getJoinedMembers", function() {
        it("should return members whose membership is 'join'", function() {
            room.currentState.getMembers.andCall(function() {
                return [
                    { userId: "@alice:bar", membership: "join" },
                    { userId: "@bob:bar", membership: "invite" },
                    { userId: "@cleo:bar", membership: "leave" },
                ];
            });
            const res = room.getJoinedMembers();
            expect(res.length).toEqual(1);
            expect(res[0].userId).toEqual("@alice:bar");
        });

        it("should return an empty list if no membership is 'join'", function() {
            room.currentState.getMembers.andCall(function() {
                return [
                    { userId: "@bob:bar", membership: "invite" },
                ];
            });
            const res = room.getJoinedMembers();
            expect(res.length).toEqual(0);
        });
    });

    describe("hasMembershipState", function() {
        it("should return true for a matching userId and membership",
        function() {
            room.currentState.members = {
                "@alice:bar": { userId: "@alice:bar", membership: "join" },
                "@bob:bar": { userId: "@bob:bar", membership: "invite" },
            };
            expect(room.hasMembershipState("@bob:bar", "invite")).toBe(true);
        });

        it("should return false if match membership but no match userId",
        function() {
            room.currentState.members = {
                "@alice:bar": { userId: "@alice:bar", membership: "join" },
            };
            expect(room.hasMembershipState("@bob:bar", "join")).toBe(false);
        });

        it("should return false if match userId but no match membership",
        function() {
            room.currentState.members = {
                "@alice:bar": { userId: "@alice:bar", membership: "join" },
            };
            expect(room.hasMembershipState("@alice:bar", "ban")).toBe(false);
        });

        it("should return false if no match membership or userId",
        function() {
            room.currentState.members = {
                "@alice:bar": { userId: "@alice:bar", membership: "join" },
            };
            expect(room.hasMembershipState("@bob:bar", "invite")).toBe(false);
        });

        it("should return false if no members exist",
        function() {
            room.currentState.members = {};
            expect(room.hasMembershipState("@foo:bar", "join")).toBe(false);
        });
    });

    describe("recalculate", function() {
        let stateLookup = {
            // event.type + "$" event.state_key : MatrixEvent
        };

        const setJoinRule = function(rule) {
            stateLookup["m.room.join_rules$"] = utils.mkEvent({
                type: "m.room.join_rules", room: roomId, user: userA, content: {
                    join_rule: rule,
                }, event: true,
            });
        };
        const setAliases = function(aliases, stateKey) {
            if (!stateKey) {
                stateKey = "flibble";
            }
            stateLookup["m.room.aliases$" + stateKey] = utils.mkEvent({
                type: "m.room.aliases", room: roomId, skey: stateKey, content: {
                    aliases: aliases,
                }, event: true,
            });
        };
        const setRoomName = function(name) {
            stateLookup["m.room.name$"] = utils.mkEvent({
                type: "m.room.name", room: roomId, user: userA, content: {
                    name: name,
                }, event: true,
            });
        };
        const addMember = function(userId, state, opts) {
            if (!state) {
                state = "join";
            }
            opts = opts || {};
            opts.room = roomId;
            opts.mship = state;
            opts.user = opts.user || userId;
            opts.skey = userId;
            opts.event = true;
            stateLookup["m.room.member$" + userId] = utils.mkMembership(opts);
        };

        beforeEach(function() {
            stateLookup = {};
            room.currentState.getStateEvents.andCall(function(type, key) {
                if (key === undefined) {
                    const prefix = type + "$";
                    const list = [];
                    for (const stateBlob in stateLookup) {
                        if (!stateLookup.hasOwnProperty(stateBlob)) {
                            continue;
                        }
                        if (stateBlob.indexOf(prefix) === 0) {
                            list.push(stateLookup[stateBlob]);
                        }
                    }
                    return list;
                } else {
                    return stateLookup[type + "$" + key];
                }
            });
            room.currentState.getMembers.andCall(function() {
                const memberEvents = room.currentState.getStateEvents("m.room.member");
                const members = [];
                for (let i = 0; i < memberEvents.length; i++) {
                    members.push({
                        name: memberEvents[i].event.content &&
                                memberEvents[i].event.content.displayname ?
                                memberEvents[i].event.content.displayname :
                                memberEvents[i].getStateKey(),
                        userId: memberEvents[i].getStateKey(),
                        events: { member: memberEvents[i] },
                    });
                }
                return members;
            });
            room.currentState.getMember.andCall(function(userId) {
                const memberEvent = room.currentState.getStateEvents(
                    "m.room.member", userId,
                );
                return {
                    name: memberEvent.event.content &&
                            memberEvent.event.content.displayname ?
                            memberEvent.event.content.displayname :
                            memberEvent.getStateKey(),
                    userId: memberEvent.getStateKey(),
                    events: { member: memberEvent },
                };
            });
        });

        describe("Room.recalculate => Stripped State Events", function() {
            it("should set stripped state events as actual state events if the " +
            "room is an invite room", function() {
                const roomName = "flibble";

                addMember(userA, "invite");
                stateLookup["m.room.member$" + userA].event.invite_room_state = [
                    {
                        type: "m.room.name",
                        state_key: "",
                        content: {
                            name: roomName,
                        },
                    },
                ];

                room.recalculate(userA);
                expect(room.currentState.setStateEvents).toHaveBeenCalled();
                // first call, first arg (which is an array), first element in array
                const fakeEvent = room.currentState.setStateEvents.calls[0].
                      arguments[0][0];
                expect(fakeEvent.getContent()).toEqual({
                    name: roomName,
                });
            });

            it("should not clobber state events if it isn't an invite room", function() {
                addMember(userA, "join");
                stateLookup["m.room.member$" + userA].event.invite_room_state = [
                    {
                        type: "m.room.name",
                        state_key: "",
                        content: {
                            name: "flibble",
                        },
                    },
                ];

                room.recalculate(userA);
                expect(room.currentState.setStateEvents).toNotHaveBeenCalled();
            });
        });

        describe("Room.recalculate => Room Name", function() {
            it("should return the names of members in a private (invite join_rules)" +
            " room if a room name and alias don't exist and there are >3 members.",
            function() {
                setJoinRule("invite");
                addMember(userA);
                addMember(userB);
                addMember(userC);
                addMember(userD);
                room.recalculate(userA);
                const name = room.name;
                // we expect at least 1 member to be mentioned
                const others = [userB, userC, userD];
                let found = false;
                for (let i = 0; i < others.length; i++) {
                    if (name.indexOf(others[i]) !== -1) {
                        found = true;
                        break;
                    }
                }
                expect(found).toEqual(true, name);
            });

            it("should return the names of members in a private (invite join_rules)" +
            " room if a room name and alias don't exist and there are >2 members.",
            function() {
                setJoinRule("invite");
                addMember(userA);
                addMember(userB);
                addMember(userC);
                room.recalculate(userA);
                const name = room.name;
                expect(name.indexOf(userB)).toNotEqual(-1, name);
                expect(name.indexOf(userC)).toNotEqual(-1, name);
            });

            it("should return the names of members in a public (public join_rules)" +
            " room if a room name and alias don't exist and there are >2 members.",
            function() {
                setJoinRule("public");
                addMember(userA);
                addMember(userB);
                addMember(userC);
                room.recalculate(userA);
                const name = room.name;
                expect(name.indexOf(userB)).toNotEqual(-1, name);
                expect(name.indexOf(userC)).toNotEqual(-1, name);
            });

            it("should show the other user's name for public (public join_rules)" +
            " rooms if a room name and alias don't exist and it is a 1:1-chat.",
            function() {
                setJoinRule("public");
                addMember(userA);
                addMember(userB);
                room.recalculate(userA);
                const name = room.name;
                expect(name.indexOf(userB)).toNotEqual(-1, name);
            });

            it("should show the other user's name for private " +
            "(invite join_rules) rooms if a room name and alias don't exist and it" +
            " is a 1:1-chat.", function() {
                setJoinRule("invite");
                addMember(userA);
                addMember(userB);
                room.recalculate(userA);
                const name = room.name;
                expect(name.indexOf(userB)).toNotEqual(-1, name);
            });

            it("should show the other user's name for private" +
            " (invite join_rules) rooms if you are invited to it.", function() {
                setJoinRule("invite");
                addMember(userA, "invite", {user: userB});
                addMember(userB);
                room.recalculate(userA);
                const name = room.name;
                expect(name.indexOf(userB)).toNotEqual(-1, name);
            });

            it("should show the room alias if one exists for private " +
            "(invite join_rules) rooms if a room name doesn't exist.", function() {
                const alias = "#room_alias:here";
                setJoinRule("invite");
                setAliases([alias, "#another:one"]);
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual(alias);
            });

            it("should show the room alias if one exists for public " +
            "(public join_rules) rooms if a room name doesn't exist.", function() {
                const alias = "#room_alias:here";
                setJoinRule("public");
                setAliases([alias, "#another:one"]);
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual(alias);
            });

            it("should show the room name if one exists for private " +
            "(invite join_rules) rooms.", function() {
                const roomName = "A mighty name indeed";
                setJoinRule("invite");
                setRoomName(roomName);
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual(roomName);
            });

            it("should show the room name if one exists for public " +
            "(public join_rules) rooms.", function() {
                const roomName = "A mighty name indeed";
                setJoinRule("public");
                setRoomName(roomName);
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual(roomName);
            });

            it("should return 'Empty room' for private (invite join_rules) rooms if" +
            " a room name and alias don't exist and it is a self-chat.", function() {
                setJoinRule("invite");
                addMember(userA);
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual("Empty room");
            });

            it("should return 'Empty room' for public (public join_rules) rooms if a" +
            " room name and alias don't exist and it is a self-chat.", function() {
                setJoinRule("public");
                addMember(userA);
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual("Empty room");
            });

            it("should return 'Empty room' if there is no name, " +
               "alias or members in the room.",
            function() {
                room.recalculate(userA);
                const name = room.name;
                expect(name).toEqual("Empty room");
            });

            it("should return '[inviter display name] if state event " +
               "available",
            function() {
                setJoinRule("invite");
                addMember(userA, 'join', {name: "Alice"});
                addMember(userB, "invite", {user: userA});
                room.recalculate(userB);
                const name = room.name;
                expect(name).toEqual("Alice");
            });

            it("should return inviter mxid if display name not available",
            function() {
                setJoinRule("invite");
                addMember(userA);
                addMember(userB, "invite", {user: userA});
                room.recalculate(userB);
                const name = room.name;
                expect(name).toEqual(userA);
            });
        });
    });

    describe("receipts", function() {
        const eventToAck = utils.mkMessage({
            room: roomId, user: userA, msg: "PLEASE ACKNOWLEDGE MY EXISTENCE",
            event: true,
        });

        function mkReceipt(roomId, records) {
            const content = {};
            records.forEach(function(r) {
                if (!content[r.eventId]) {
                    content[r.eventId] = {};
                }
                if (!content[r.eventId][r.type]) {
                    content[r.eventId][r.type] = {};
                }
                content[r.eventId][r.type][r.userId] = {
                    ts: r.ts,
                };
            });
            return new MatrixEvent({
                content: content,
                room_id: roomId,
                type: "m.receipt",
            });
        }

        function mkRecord(eventId, type, userId, ts) {
            ts = ts || Date.now();
            return {
                eventId: eventId,
                type: type,
                userId: userId,
                ts: ts,
            };
        }

        describe("addReceipt", function() {
            it("should store the receipt so it can be obtained via getReceiptsForEvent",
            function() {
                const ts = 13787898424;
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.read", userB, ts),
                ]));
                expect(room.getReceiptsForEvent(eventToAck)).toEqual([{
                    type: "m.read",
                    userId: userB,
                    data: {
                        ts: ts,
                    },
                }]);
            });

            it("should emit an event when a receipt is added",
            function() {
                const listener = expect.createSpy();
                room.on("Room.receipt", listener);

                const ts = 13787898424;

                const receiptEvent = mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.read", userB, ts),
                ]);

                room.addReceipt(receiptEvent);
                expect(listener).toHaveBeenCalledWith(receiptEvent, room);
            });

            it("should clobber receipts based on type and user ID", function() {
                const nextEventToAck = utils.mkMessage({
                    room: roomId, user: userA, msg: "I AM HERE YOU KNOW",
                    event: true,
                });
                const ts = 13787898424;
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.read", userB, ts),
                ]));
                const ts2 = 13787899999;
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(nextEventToAck.getId(), "m.read", userB, ts2),
                ]));
                expect(room.getReceiptsForEvent(eventToAck)).toEqual([]);
                expect(room.getReceiptsForEvent(nextEventToAck)).toEqual([{
                    type: "m.read",
                    userId: userB,
                    data: {
                        ts: ts2,
                    },
                }]);
            });

            it("should persist multiple receipts for a single event ID", function() {
                const ts = 13787898424;
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.read", userB, ts),
                    mkRecord(eventToAck.getId(), "m.read", userC, ts),
                    mkRecord(eventToAck.getId(), "m.read", userD, ts),
                ]));
                expect(room.getUsersReadUpTo(eventToAck)).toEqual(
                    [userB, userC, userD],
                );
            });

            it("should persist multiple receipts for a single receipt type", function() {
                const eventTwo = utils.mkMessage({
                    room: roomId, user: userA, msg: "2222",
                    event: true,
                });
                const eventThree = utils.mkMessage({
                    room: roomId, user: userA, msg: "3333",
                    event: true,
                });
                const ts = 13787898424;
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.read", userB, ts),
                    mkRecord(eventTwo.getId(), "m.read", userC, ts),
                    mkRecord(eventThree.getId(), "m.read", userD, ts),
                ]));
                expect(room.getUsersReadUpTo(eventToAck)).toEqual([userB]);
                expect(room.getUsersReadUpTo(eventTwo)).toEqual([userC]);
                expect(room.getUsersReadUpTo(eventThree)).toEqual([userD]);
            });

            it("should persist multiple receipts for a single user ID", function() {
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.delivered", userB, 13787898424),
                    mkRecord(eventToAck.getId(), "m.read", userB, 22222222),
                    mkRecord(eventToAck.getId(), "m.seen", userB, 33333333),
                ]));
                expect(room.getReceiptsForEvent(eventToAck)).toEqual([
                {
                    type: "m.delivered",
                    userId: userB,
                    data: {
                        ts: 13787898424,
                    },
                },
                {
                    type: "m.read",
                    userId: userB,
                    data: {
                        ts: 22222222,
                    },
                },
                {
                    type: "m.seen",
                    userId: userB,
                    data: {
                        ts: 33333333,
                    },
                },
                ]);
            });

            it("should prioritise the most recent event", function() {
                const events = [
                    utils.mkMessage({
                        room: roomId, user: userA, msg: "1111",
                        event: true,
                    }),
                    utils.mkMessage({
                        room: roomId, user: userA, msg: "2222",
                        event: true,
                    }),
                    utils.mkMessage({
                        room: roomId, user: userA, msg: "3333",
                        event: true,
                    }),
                ];

                room.addLiveEvents(events);
                const ts = 13787898424;

                // check it initialises correctly
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(events[0].getId(), "m.read", userB, ts),
                ]));
                expect(room.getEventReadUpTo(userB)).toEqual(events[0].getId());

                // 2>0, so it should move forward
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(events[2].getId(), "m.read", userB, ts),
                ]));
                expect(room.getEventReadUpTo(userB)).toEqual(events[2].getId());

                // 1<2, so it should stay put
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(events[1].getId(), "m.read", userB, ts),
                ]));
                expect(room.getEventReadUpTo(userB)).toEqual(events[2].getId());
            });
        });

        describe("getUsersReadUpTo", function() {
            it("should return user IDs read up to the given event", function() {
                const ts = 13787898424;
                room.addReceipt(mkReceipt(roomId, [
                    mkRecord(eventToAck.getId(), "m.read", userB, ts),
                ]));
                expect(room.getUsersReadUpTo(eventToAck)).toEqual([userB]);
            });
        });
    });

    describe("tags", function() {
        function mkTags(roomId, tags) {
            const content = { "tags": tags };
            return new MatrixEvent({
                content: content,
                room_id: roomId,
                type: "m.tag",
            });
        }

        describe("addTag", function() {
            it("should set tags on rooms from event stream so " +
               "they can be obtained by the tags property",
            function() {
                const tags = { "m.foo": { "order": 0.5 } };
                room.addTags(mkTags(roomId, tags));
                expect(room.tags).toEqual(tags);
            });

            it("should emit Room.tags event when new tags are " +
               "received on the event stream",
            function() {
                const listener = expect.createSpy();
                room.on("Room.tags", listener);

                const tags = { "m.foo": { "order": 0.5 } };
                const event = mkTags(roomId, tags);
                room.addTags(event);
                expect(listener).toHaveBeenCalledWith(event, room);
            });

            // XXX: shouldn't we try injecting actual m.tag events onto the eventstream
            // rather than injecting via room.addTags()?
        });
    });

    describe("addPendingEvent", function() {
        it("should add pending events to the pendingEventList if " +
                      "pendingEventOrdering == 'detached'", function() {
            const room = new Room(roomId, {
                pendingEventOrdering: "detached",
            });
            const eventA = utils.mkMessage({
                room: roomId, user: userA, msg: "remote 1", event: true,
            });
            const eventB = utils.mkMessage({
                room: roomId, user: userA, msg: "local 1", event: true,
            });
            eventB.status = EventStatus.SENDING;
            const eventC = utils.mkMessage({
                room: roomId, user: userA, msg: "remote 2", event: true,
            });
            room.addLiveEvents([eventA]);
            room.addPendingEvent(eventB, "TXN1");
            room.addLiveEvents([eventC]);
            expect(room.timeline).toEqual(
                [eventA, eventC],
            );
            expect(room.getPendingEvents()).toEqual(
                [eventB],
            );
        });

        it("should add pending events to the timeline if " +
                      "pendingEventOrdering == 'chronological'", function() {
            room = new Room(roomId, {
                pendingEventOrdering: "chronological",
            });
            const eventA = utils.mkMessage({
                room: roomId, user: userA, msg: "remote 1", event: true,
            });
            const eventB = utils.mkMessage({
                room: roomId, user: userA, msg: "local 1", event: true,
            });
            eventB.status = EventStatus.SENDING;
            const eventC = utils.mkMessage({
                room: roomId, user: userA, msg: "remote 2", event: true,
            });
            room.addLiveEvents([eventA]);
            room.addPendingEvent(eventB, "TXN1");
            room.addLiveEvents([eventC]);
            expect(room.timeline).toEqual(
                [eventA, eventB, eventC],
            );
        });
    });

    describe("updatePendingEvent", function() {
        it("should remove cancelled events from the pending list", function() {
            const room = new Room(roomId, {
                pendingEventOrdering: "detached",
            });
            const eventA = utils.mkMessage({
                room: roomId, user: userA, event: true,
            });
            eventA.status = EventStatus.SENDING;
            const eventId = eventA.getId();

            room.addPendingEvent(eventA, "TXN1");
            expect(room.getPendingEvents()).toEqual(
                [eventA],
            );

            // the event has to have been failed or queued before it can be
            // cancelled
            room.updatePendingEvent(eventA, EventStatus.NOT_SENT);

            let callCount = 0;
            room.on("Room.localEchoUpdated",
                function(event, emitRoom, oldEventId, oldStatus) {
                    expect(event).toEqual(eventA);
                    expect(event.status).toEqual(EventStatus.CANCELLED);
                    expect(emitRoom).toEqual(room);
                    expect(oldEventId).toEqual(eventId);
                    expect(oldStatus).toEqual(EventStatus.NOT_SENT);
                    callCount++;
                });

            room.updatePendingEvent(eventA, EventStatus.CANCELLED);
            expect(room.getPendingEvents()).toEqual([]);
            expect(callCount).toEqual(1);
        });


        it("should remove cancelled events from the timeline", function() {
            const room = new Room(roomId);
            const eventA = utils.mkMessage({
                room: roomId, user: userA, event: true,
            });
            eventA.status = EventStatus.SENDING;
            const eventId = eventA.getId();

            room.addPendingEvent(eventA, "TXN1");
            expect(room.getLiveTimeline().getEvents()).toEqual(
                [eventA],
            );

            // the event has to have been failed or queued before it can be
            // cancelled
            room.updatePendingEvent(eventA, EventStatus.NOT_SENT);

            let callCount = 0;
            room.on("Room.localEchoUpdated",
                function(event, emitRoom, oldEventId, oldStatus) {
                    expect(event).toEqual(eventA);
                    expect(event.status).toEqual(EventStatus.CANCELLED);
                    expect(emitRoom).toEqual(room);
                    expect(oldEventId).toEqual(eventId);
                    expect(oldStatus).toEqual(EventStatus.NOT_SENT);
                    callCount++;
                });

            room.updatePendingEvent(eventA, EventStatus.CANCELLED);
            expect(room.getLiveTimeline().getEvents()).toEqual([]);
            expect(callCount).toEqual(1);
        });
    });
});
