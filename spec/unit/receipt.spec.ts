import * as utils from "../test-utils";
import { RoomState } from "../../src/models/room-state";
import { Room } from "../../src/models/room";
import { MatrixEvent } from "../../src/models/event";

describe("Room", function() {
    const roomId = "!foo:bar";
    const userA = "@alice:bar";
    const userB = "@bertha:bar";
    const userC = "@clarissa:bar";
    const userD = "@dorothy:bar";
    let room;

    beforeEach(function() {
        room = new Room(roomId);
        // mock RoomStates
        room.oldState = room.getLiveTimeline().startState =
            utils.mock(RoomState, "oldState");
        room.currentState = room.getLiveTimeline().endState =
            utils.mock(RoomState, "currentState");
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
                    const listener = jest.fn();
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
});
