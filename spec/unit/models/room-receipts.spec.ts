/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
    FeatureSupport,
    type MatrixClient,
    MatrixEvent,
    type ReceiptContent,
    ReceiptType,
    THREAD_RELATION_TYPE,
    Thread,
} from "../../../src";
import { Room } from "../../../src/models/room";

/**
 * Note, these tests check the functionality of the RoomReceipts class, but most
 * of them access that functionality via the surrounding Room class, because a
 * room is required for RoomReceipts to function, and this matches the pattern
 * of how this code is used in the wild.
 */
describe("RoomReceipts", () => {
    beforeAll(() => {
        vi.spyOn(Thread, "hasServerSideSupport", "get").mockReturnValue(FeatureSupport.Stable);
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    it("reports events unread if there are no receipts", () => {
        // Given there are no receipts in the room
        const room = createRoom();
        const [event] = createEvent();
        room.addLiveEvents([event], { addToState: false });

        // When I ask about any event, then it is unread
        expect(room.hasUserReadEvent(readerId, event.getId()!)).toBe(false);
    });

    it("reports events we sent as read even if there are no (real) receipts", () => {
        // Given there are no receipts in the room
        const room = createRoom();
        const [event] = createEventSentBy(readerId);
        room.addLiveEvents([event], { addToState: false });

        // When I ask about an event I sent, it is read (because a synthetic
        // receipt was created and stored in RoomReceipts)
        expect(room.hasUserReadEvent(readerId, event.getId()!)).toBe(true);
    });

    it("reports read if we receive an unthreaded receipt for this event", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [event, eventId] = createEvent();
        room.addLiveEvents([event], { addToState: false });
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // When we receive a receipt for this event+user
        room.addReceipt(createReceipt(readerId, event));

        // Then that event is read
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(true);
    });

    it("reports read if we receive an unthreaded receipt for a later event", () => {
        // Given we have 2 events
        const room = createRoom();
        const [event1, event1Id] = createEvent();
        const [event2] = createEvent();
        room.addLiveEvents([event1, event2], { addToState: false });

        // When we receive a receipt for the later event
        room.addReceipt(createReceipt(readerId, event2));

        // Then the earlier one is read
        expect(room.hasUserReadEvent(readerId, event1Id)).toBe(true);
    });

    it("reports read for a non-live event if we receive an unthreaded receipt for a live one", () => {
        // Given we have 2 events: one live and one old
        const room = createRoom();
        const [oldEvent, oldEventId] = createEvent();
        const [liveEvent] = createEvent();
        room.addLiveEvents([liveEvent], { addToState: false });
        createOldTimeline(room, [oldEvent]);

        // When we receive a receipt for the live event
        room.addReceipt(createReceipt(readerId, liveEvent));

        // Then the earlier one is read
        expect(room.hasUserReadEvent(readerId, oldEventId)).toBe(true);
    });

    it("compares by timestamp if two events are in separate old timelines", () => {
        // Given we have 2 events, both in old timelines, with event2 after
        // event1 in terms of timestamps
        const room = createRoom();
        const [event1, event1Id] = createEvent();
        const [event2, event2Id] = createEvent();
        event1.event.origin_server_ts = 1;
        event2.event.origin_server_ts = 2;
        createOldTimeline(room, [event1]);
        createOldTimeline(room, [event2]);

        // When we receive a receipt for the older event
        room.addReceipt(createReceipt(readerId, event1));

        // Then the earlier one is read and the later one is not
        expect(room.hasUserReadEvent(readerId, event1Id)).toBe(true);
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(false);
    });

    it("reports unread if we receive an unthreaded receipt for an earlier event", () => {
        // Given we have 2 events
        const room = createRoom();
        const [event1] = createEvent();
        const [event2, event2Id] = createEvent();
        room.addLiveEvents([event1, event2], { addToState: false });

        // When we receive a receipt for the earlier event
        room.addReceipt(createReceipt(readerId, event1));

        // Then the later one is unread
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(false);
    });

    it("reports unread if we receive an unthreaded receipt for a different user", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [event, eventId] = createEvent();
        room.addLiveEvents([event], { addToState: false });
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // When we receive a receipt for another user
        room.addReceipt(createReceipt(otherUserId, event));

        // Then the event is still unread since the receipt was not for us
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // But it's read for the other person
        expect(room.hasUserReadEvent(otherUserId, eventId)).toBe(true);
    });

    it("reports events we sent as read even if an earlier receipt arrives", () => {
        // Given we sent an event after some other event
        const room = createRoom();
        const [previousEvent] = createEvent();
        const [myEvent] = createEventSentBy(readerId);
        room.addLiveEvents([previousEvent, myEvent], { addToState: false });

        // And I just received a receipt for the previous event
        room.addReceipt(createReceipt(readerId, previousEvent));

        // When I ask about the event I sent, it is read (because of synthetic receipts)
        expect(room.hasUserReadEvent(readerId, myEvent.getId()!)).toBe(true);
    });

    it("considers events after ones we sent to be unread", () => {
        // Given we sent an event, then another event came in
        const room = createRoom();
        const [myEvent] = createEventSentBy(readerId);
        const [laterEvent] = createEvent();
        room.addLiveEvents([myEvent, laterEvent], { addToState: false });

        // When I ask about the later event, it is unread (because it's after the synthetic receipt)
        expect(room.hasUserReadEvent(readerId, laterEvent.getId()!)).toBe(false);
    });

    it("correctly reports readness even when receipts arrive out of order", () => {
        // Given we have 3 events
        const room = createRoom();
        const [event1] = createEvent();
        const [event2, event2Id] = createEvent();
        const [event3, event3Id] = createEvent();
        room.addLiveEvents([event1, event2, event3], { addToState: false });

        // When we receive receipts for the older events out of order
        room.addReceipt(createReceipt(readerId, event2));
        room.addReceipt(createReceipt(readerId, event1));

        // Then we correctly ignore the older receipt
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(true);
        expect(room.hasUserReadEvent(readerId, event3Id)).toBe(false);
    });

    it("reports read if we receive a threaded receipt for this event (main)", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [event, eventId] = createEvent();
        room.addLiveEvents([event], { addToState: false });
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // When we receive a receipt for this event+user
        room.addReceipt(createThreadedReceipt(readerId, event, "main"));

        // Then that event is read
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(true);
    });

    it("reports read if we receive a threaded receipt for this event (non-main)", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [root, rootId] = createEvent();
        const [event, eventId] = createThreadedEvent(root);
        setupThread(room, root);
        room.addLiveEvents([root, event], { addToState: false });
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // When we receive a receipt for this event on this thread
        room.addReceipt(createThreadedReceipt(readerId, event, rootId));

        // Then that event is read
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(true);
    });

    it("reports read if we receive an threaded receipt for a later event", () => {
        // Given we have 2 events in a thread
        const room = createRoom();
        const [root, rootId] = createEvent();
        const [event1, event1Id] = createThreadedEvent(root);
        const [event2] = createThreadedEvent(root);
        setupThread(room, root);
        room.addLiveEvents([root, event1, event2], { addToState: false });

        // When we receive a receipt for the later event
        room.addReceipt(createThreadedReceipt(readerId, event2, rootId));

        // Then the earlier one is read
        expect(room.hasUserReadEvent(readerId, event1Id)).toBe(true);
    });

    it("reports unread if we receive an threaded receipt for an earlier event", () => {
        // Given we have 2 events in a thread
        const room = createRoom();
        const [root, rootId] = createEvent();
        const [event1] = createThreadedEvent(root);
        const [event2, event2Id] = createThreadedEvent(root);
        setupThread(room, root);
        room.addLiveEvents([root, event1, event2], { addToState: false });

        // When we receive a receipt for the earlier event
        room.addReceipt(createThreadedReceipt(readerId, event1, rootId));

        // Then the later one is unread
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(false);
    });

    it("reports unread if we receive an threaded receipt for a different user", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [root, rootId] = createEvent();
        const [event, eventId] = createThreadedEvent(root);
        setupThread(room, root);
        room.addLiveEvents([root, event], { addToState: false });
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // When we receive a receipt for another user
        room.addReceipt(createThreadedReceipt(otherUserId, event, rootId));

        // Then the event is still unread since the receipt was not for us
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // But it's read for the other person
        expect(room.hasUserReadEvent(otherUserId, eventId)).toBe(true);
    });

    it("reports unread if we receive a receipt for a later event in a different thread", () => {
        // Given 2 events exist in different threads
        const room = createRoom();
        const [root1] = createEvent();
        const [root2] = createEvent();
        const [thread1, thread1Id] = createThreadedEvent(root1);
        const [thread2] = createThreadedEvent(root2);
        setupThread(room, root1);
        setupThread(room, root2);
        room.addLiveEvents([root1, root2, thread1, thread2], { addToState: false });

        // When we receive a receipt for the later event
        room.addReceipt(createThreadedReceipt(readerId, thread2, root2.getId()!));

        // Then the old one is still unread since the receipt was not for this thread
        expect(room.hasUserReadEvent(readerId, thread1Id)).toBe(false);
    });

    it("correctly reports readness even when threaded receipts arrive out of order", () => {
        // Given we have 3 events
        const room = createRoom();
        const [root, rootId] = createEvent();
        const [event1] = createThreadedEvent(root);
        const [event2, event2Id] = createThreadedEvent(root);
        const [event3, event3Id] = createThreadedEvent(root);
        setupThread(room, root);
        room.addLiveEvents([root, event1, event2, event3], { addToState: false });

        // When we receive receipts for the older events out of order
        room.addReceipt(createThreadedReceipt(readerId, event2, rootId));
        room.addReceipt(createThreadedReceipt(readerId, event1, rootId));

        // Then we correctly ignore the older receipt
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(true);
        expect(room.hasUserReadEvent(readerId, event3Id)).toBe(false);
    });

    it("correctly reports readness when mixing threaded and unthreaded receipts", () => {
        // Given we have a setup from this presentation:
        // https://docs.google.com/presentation/d/1H1gxRmRFAm8d71hCILWmpOYezsvdlb7cB6ANl-20Gns/edit?usp=sharing
        //
        //                     Main1----\
        //                       |       ---Thread1a <- threaded receipt
        //                       |             |
        //                       |          Thread1b
        // threaded receipt -> Main2--\
        //                       |     ----------------Thread2a <- unthreaded receipt
        //                     Main3                      |
        //                                             Thread2b <- threaded receipt
        //
        const room = createRoom();
        const [main1, main1Id] = createEvent();
        const [main2, main2Id] = createEvent();
        const [main3, main3Id] = createEvent();
        const [thread1a, thread1aId] = createThreadedEvent(main1);
        const [thread1b, thread1bId] = createThreadedEvent(main1);
        const [thread2a, thread2aId] = createThreadedEvent(main2);
        const [thread2b, thread2bId] = createThreadedEvent(main2);
        setupThread(room, main1);
        setupThread(room, main2);
        room.addLiveEvents([main1, thread1a, thread1b, main2, thread2a, main3, thread2b], { addToState: false });

        // And the timestamps on the events are consistent with the order above
        main1.event.origin_server_ts = 1;
        thread1a.event.origin_server_ts = 2;
        thread1b.event.origin_server_ts = 3;
        main2.event.origin_server_ts = 4;
        thread2a.event.origin_server_ts = 5;
        main3.event.origin_server_ts = 6;
        thread2b.event.origin_server_ts = 7;
        // (Note: in principle, we have the information needed to order these
        // events without using their timestamps, since they all came in via
        // addLiveEvents. In reality, some of them would have come in via the
        // /relations API, making it impossible to get the correct ordering
        // without MSC4033, which is why we fall back to timestamps. I.e. we
        // definitely could fix the code to make the above
        // timestamp-manipulation unnecessary, but it would only make this test
        // neater, not actually help in the real world.)

        // When the receipts arrive
        room.addReceipt(createThreadedReceipt(readerId, main2, "main"));
        room.addReceipt(createThreadedReceipt(readerId, thread1a, main1Id));
        room.addReceipt(createReceipt(readerId, thread2a));
        room.addReceipt(createThreadedReceipt(readerId, thread2b, main2Id));

        // Then we correctly identify that only main3 is unread
        expect(room.hasUserReadEvent(readerId, main1Id)).toBe(true);
        expect(room.hasUserReadEvent(readerId, main2Id)).toBe(true);
        expect(room.hasUserReadEvent(readerId, main3Id)).toBe(false);
        expect(room.hasUserReadEvent(readerId, thread1aId)).toBe(true);
        expect(room.hasUserReadEvent(readerId, thread1bId)).toBe(true);
        expect(room.hasUserReadEvent(readerId, thread2aId)).toBe(true);
        expect(room.hasUserReadEvent(readerId, thread2bId)).toBe(true);
    });

    describe("RoomReceipts public surface", () => {
        // These tests target the new `RoomReceipts` methods directly. PR 2 will
        // wire them up to `Room`; until then we go through `getRoomReceipts`.

        describe("getReceiptsForEvent / getUsersReadUpTo", () => {
            it("returns an empty list when no receipts are known", () => {
                const room = createRoom();
                const [, eventId] = createEvent();
                // Event not pushed into the timeline, so no synthetic receipt is created.
                expect(getRoomReceipts(room).getReceiptsForEvent(eventId)).toEqual([]);
                expect(getRoomReceipts(room).getUsersReadUpTo(eventId)).toEqual([]);
            });

            it("returns the user's receipt cached by event", () => {
                const room = createRoom();
                const [event, eventId] = createEvent();
                room.addReceipt(createReceipt(readerId, event));
                expect(getRoomReceipts(room).getReceiptsForEvent(eventId)).toEqual([
                    { type: ReceiptType.Read, userId: readerId, data: { ts: 123 } },
                ]);
                expect(getRoomReceipts(room).getUsersReadUpTo(eventId)).toEqual([readerId]);
            });

            it("preserves insertion order across multiple receipt types for the same user/event", () => {
                const room = createRoom();
                const [event, eventId] = createEvent();
                room.addReceipt(makeMultiTypeReceipt(readerId, event, ["m.delivered", "m.read", "m.seen"]));

                expect(
                    getRoomReceipts(room)
                        .getReceiptsForEvent(eventId)
                        .map((r) => r.type),
                ).toEqual(["m.delivered", "m.read", "m.seen"]);
            });

            it("evicts the user's prior cache entry when their receipt moves to a later event", () => {
                const room = createRoom();
                const [event1, event1Id] = createEvent();
                const [event2, event2Id] = createEvent();
                room.addLiveEvents([event1, event2], { addToState: false });

                room.addReceipt(createReceipt(readerId, event1));
                expect(
                    getRoomReceipts(room)
                        .getReceiptsForEvent(event1Id)
                        .filter((r) => r.userId === readerId),
                ).toHaveLength(1);

                room.addReceipt(createReceipt(readerId, event2));
                expect(
                    getRoomReceipts(room)
                        .getReceiptsForEvent(event1Id)
                        .filter((r) => r.userId === readerId),
                ).toEqual([]);
                expect(
                    getRoomReceipts(room)
                        .getReceiptsForEvent(event2Id)
                        .filter((r) => r.userId === readerId),
                ).toHaveLength(1);
            });

            it("filters m.fully_read out of getUsersReadUpTo but keeps it in getReceiptsForEvent", () => {
                const room = createRoom();
                const [event, eventId] = createEvent();
                room.addReceipt(makeMultiTypeReceipt(readerId, event, ["m.fully_read", "m.read"]));

                expect(
                    getRoomReceipts(room)
                        .getReceiptsForEvent(eventId)
                        .map((r) => r.type)
                        .sort(),
                ).toEqual(["m.fully_read", "m.read"].sort());
                expect(getRoomReceipts(room).getUsersReadUpTo(eventId)).toEqual([readerId]);
            });

            it("populates the cache for dangling receipts whose event is not loaded yet", () => {
                const room = createRoom();
                const [event, eventId] = createEvent();
                // Event not added to the timeline — receipt is dangling.
                room.addReceipt(createReceipt(readerId, event));

                expect(getRoomReceipts(room).getReceiptsForEvent(eventId)).toEqual([
                    { type: ReceiptType.Read, userId: readerId, data: { ts: 123 } },
                ]);
            });
        });

        describe("synthetic vs real receipts", () => {
            it("the synthetic wins when it points at a later event", () => {
                const room = createRoom();
                const [event1] = createEvent();
                const [event2, event2Id] = createEvent();
                room.addLiveEvents([event1, event2], { addToState: false });

                room.addReceipt(createReceipt(readerId, event1));
                room.addReceipt(createReceipt(readerId, event2), true);

                expect(getRoomReceipts(room).getEventReadUpTo(readerId)).toEqual(event2Id);
                expect(
                    getRoomReceipts(room)
                        .getReceiptsForEvent(event2Id)
                        .filter((r) => r.userId === readerId),
                ).toHaveLength(1);
            });

            it("ignoreSynthesized exposes the most recent real receipt", () => {
                const room = createRoom();
                const [event1] = createEvent();
                const [event2, event2Id] = createEvent();
                const [event3, event3Id] = createEvent();
                room.addLiveEvents([event1, event2, event3], { addToState: false });

                room.addReceipt(createReceipt(readerId, event1));
                room.addReceipt(createReceipt(readerId, event3), true);
                room.addReceipt(createReceipt(readerId, event2));

                expect(getRoomReceipts(room).getEventReadUpTo(readerId)).toEqual(event3Id);
                expect(getRoomReceipts(room).getEventReadUpTo(readerId, true)).toEqual(event2Id);
            });
        });

        describe("Read vs ReadPrivate precedence", () => {
            it("getEventReadUpTo prefers the later receipt across types", () => {
                const room = createRoom();
                const [event1] = createEvent();
                const [event2, event2Id] = createEvent();
                room.addLiveEvents([event1, event2], { addToState: false });

                room.addReceipt(createReceipt(readerId, event1, ReceiptType.Read));
                room.addReceipt(createReceipt(readerId, event2, ReceiptType.ReadPrivate));

                expect(getRoomReceipts(room).getEventReadUpTo(readerId)).toEqual(event2Id);
            });

            it("getReadReceiptForUserId can be scoped to a specific receipt type", () => {
                const room = createRoom();
                const [event1, event1Id] = createEvent();
                const [event2, event2Id] = createEvent();
                room.addLiveEvents([event1, event2], { addToState: false });

                room.addReceipt(createReceipt(readerId, event1, ReceiptType.Read));
                room.addReceipt(createReceipt(readerId, event2, ReceiptType.ReadPrivate));

                expect(
                    getRoomReceipts(room).getReadReceiptForUserId(readerId, false, ReceiptType.Read)?.eventId,
                ).toEqual(event1Id);
                expect(
                    getRoomReceipts(room).getReadReceiptForUserId(readerId, false, ReceiptType.ReadPrivate)?.eventId,
                ).toEqual(event2Id);
            });
        });

        describe("getEventReadUpTo validity", () => {
            it("returns null when the receipt points at an event we don't have", () => {
                const room = createRoom();
                const [missing] = createEvent();
                room.addReceipt(createReceipt(readerId, missing));
                expect(getRoomReceipts(room).getEventReadUpTo(readerId)).toBeNull();
            });
        });

        describe("getLastUnthreadedReceiptFor", () => {
            it("returns the raw unthreaded Receipt", () => {
                const room = createRoom();
                const [event] = createEvent();
                room.addLiveEvents([event], { addToState: false });
                room.addReceipt(createReceipt(readerId, event));
                expect(getRoomReceipts(room).getLastUnthreadedReceiptFor(readerId)).toEqual({ ts: 123 });
            });

            it("returns undefined when only threaded receipts exist", () => {
                const room = createRoom();
                const [root] = createEvent();
                const [event] = createThreadedEvent(root);
                setupThread(room, root);
                room.addLiveEvents([root, event], { addToState: false });
                room.addReceipt(createThreadedReceipt(readerId, event, root.getId()!));
                expect(getRoomReceipts(room).getLastUnthreadedReceiptFor(readerId)).toBeUndefined();
            });
        });

        describe("getOldestThreadedReceiptTs", () => {
            it("tracks the minimum ts of threaded receipts per user", () => {
                const room = createRoom();
                const [root] = createEvent();
                const [event1] = createThreadedEvent(root);
                const [event2] = createThreadedEvent(root);
                setupThread(room, root);
                room.addLiveEvents([root, event1, event2], { addToState: false });

                room.addReceipt(threadedReceiptWithTs(readerId, event1, root.getId()!, 500));
                room.addReceipt(threadedReceiptWithTs(readerId, event2, root.getId()!, 200));

                expect(getRoomReceipts(room).getOldestThreadedReceiptTs(readerId)).toEqual(200);
            });

            it("returns Infinity if the user has no threaded receipts", () => {
                const room = createRoom();
                expect(getRoomReceipts(room).getOldestThreadedReceiptTs(readerId)).toEqual(Infinity);
            });
        });
    });

    describe("dangling receipts", () => {
        it("reports unread if the unthreaded receipt is in a dangling state", () => {
            const room = createRoom();
            const [event, eventId] = createEvent();
            // When we receive a receipt for this event+user
            room.addReceipt(createReceipt(readerId, event));

            // The event is not added in the room
            // So the receipt is in a dangling state
            expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

            // Add the event to the room
            // The receipt is removed from the dangling state
            room.addLiveEvents([event], { addToState: false });

            // Then the event is read
            expect(room.hasUserReadEvent(readerId, eventId)).toBe(true);
        });

        it("reports unread if the threaded receipt is in a dangling state", () => {
            const room = createRoom();
            const [root, rootId] = createEvent();
            const [event, eventId] = createThreadedEvent(root);
            setupThread(room, root);

            // When we receive a receipt for this event+user
            room.addReceipt(createThreadedReceipt(readerId, event, rootId));

            // The event is not added in the room
            // So the receipt is in a dangling state
            expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

            // Add the events to the room
            // The receipt is removed from the dangling state
            room.addLiveEvents([root, event], { addToState: false });

            // Then the event is read
            expect(room.hasUserReadEvent(readerId, eventId)).toBe(true);
        });

        it("should handle multiple dangling receipts for the same event", () => {
            const room = createRoom();
            const [event, eventId] = createEvent();
            // When we receive a receipt for this event+user
            room.addReceipt(createReceipt(readerId, event));
            // We receive another receipt in the same event for another user
            room.addReceipt(createReceipt(otherUserId, event));

            // The event is not added in the room
            // So the receipt is in a dangling state
            expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

            // Add the event to the room
            // The two receipts should be processed
            room.addLiveEvents([event], { addToState: false });

            // Then the event is read
            // We expect that the receipt of `otherUserId` didn't replace/erase the receipt of `readerId`
            expect(room.hasUserReadEvent(readerId, eventId)).toBe(true);
        });
    });
});

function createFakeClient(): MatrixClient {
    return {
        getUserId: vi.fn(),
        getEventMapper: vi.fn().mockReturnValue(vi.fn()),
        isInitialSyncComplete: vi.fn().mockReturnValue(true),
        supportsThreads: vi.fn().mockReturnValue(true),
        fetchRoomEvent: vi.fn().mockResolvedValue({}),
        paginateEventTimeline: vi.fn(),
        canSupport: { get: vi.fn() },
    } as unknown as MatrixClient;
}

const senderId = "sender:s.ss";
const readerId = "reader:r.rr";
const otherUserId = "other:o.oo";

function createRoom(): Room {
    return new Room("!rid", createFakeClient(), "@u:s.nz", { timelineSupport: true });
}

// PR 1 of the receipt-storage migration adds the new public surface to
// `RoomReceipts` but does not yet wire it up to `Room`. Until PR 2 lands,
// tests for the new methods reach into the private field.
function getRoomReceipts(room: Room): {
    getReceiptsForEvent: (eventId: string) => Array<{ type: string; userId: string; data: { ts: number } }>;
    getUsersReadUpTo: (eventId: string) => string[];
    getReadReceiptForUserId: (
        userId: string,
        ignoreSynthesized?: boolean,
        receiptType?: ReceiptType,
    ) => { eventId: string; data: { ts: number } } | null;
    getEventReadUpTo: (userId: string, ignoreSynthesized?: boolean) => string | null;
    getLastUnthreadedReceiptFor: (userId: string) => { ts: number } | undefined;
    getOldestThreadedReceiptTs: (userId: string) => number;
} {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (room as any).roomReceipts;
}

let idCounter = 0;
function nextId(): string {
    return "$" + (idCounter++).toString(10);
}

/**
 * Create an event and return it and its ID.
 */
function createEvent(): [MatrixEvent, string] {
    return createEventSentBy(senderId);
}

/**
 * Create an event with the supplied sender and return it and its ID.
 */
function createEventSentBy(customSenderId: string): [MatrixEvent, string] {
    const event = new MatrixEvent({ sender: customSenderId, event_id: nextId() });
    return [event, event.getId()!];
}

/**
 * Create an event in the thread of the supplied root and return it and its ID.
 */
function createThreadedEvent(root: MatrixEvent): [MatrixEvent, string] {
    const rootEventId = root.getId()!;
    const event = new MatrixEvent({
        sender: senderId,
        event_id: nextId(),
        content: {
            "m.relates_to": {
                "event_id": rootEventId,
                "rel_type": THREAD_RELATION_TYPE.name,
                ["m.in_reply_to"]: {
                    event_id: rootEventId,
                },
            },
        },
    });
    return [event, event.getId()!];
}

function createReceipt(
    userId: string,
    referencedEvent: MatrixEvent,
    receiptType: string = ReceiptType.Read,
): MatrixEvent {
    const content: ReceiptContent = {
        [referencedEvent.getId()!]: {
            [receiptType]: {
                [userId]: {
                    ts: 123,
                },
            },
        },
    };

    return new MatrixEvent({
        type: "m.receipt",
        content,
    });
}

function makeMultiTypeReceipt(userId: string, referencedEvent: MatrixEvent, receiptTypes: string[]): MatrixEvent {
    const perType: Record<string, Record<string, { ts: number }>> = {};
    for (const t of receiptTypes) {
        perType[t] = { [userId]: { ts: 123 } };
    }
    const content: ReceiptContent = { [referencedEvent.getId()!]: perType };
    return new MatrixEvent({ type: "m.receipt", content });
}

function threadedReceiptWithTs(
    userId: string,
    referencedEvent: MatrixEvent,
    threadId: string,
    ts: number,
): MatrixEvent {
    const content: ReceiptContent = {
        [referencedEvent.getId()!]: {
            "m.read": {
                [userId]: { ts, thread_id: threadId },
            },
        },
    };
    return new MatrixEvent({ type: "m.receipt", content });
}

function createThreadedReceipt(userId: string, referencedEvent: MatrixEvent, threadId: string): MatrixEvent {
    const content: ReceiptContent = {
        [referencedEvent.getId()!]: {
            "m.read": {
                [userId]: {
                    ts: 123,
                    thread_id: threadId,
                },
            },
        },
    };

    return new MatrixEvent({
        type: "m.receipt",
        content,
    });
}

/**
 * Create a timeline in the timeline set that is not the live timeline.
 */
function createOldTimeline(room: Room, events: MatrixEvent[]) {
    const oldTimeline = room.getUnfilteredTimelineSet().addTimeline();
    room.getUnfilteredTimelineSet().addEventsToTimeline(events, true, false, oldTimeline);
}

/**
 * Perform the hacks required for this room to create a thread based on the root
 * event supplied.
 */
function setupThread(room: Room, root: MatrixEvent) {
    const thread = room.createThread(root.getId()!, root, [root], false);
    thread.initialEventsFetched = true;
}
