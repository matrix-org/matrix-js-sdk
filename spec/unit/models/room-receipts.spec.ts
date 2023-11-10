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

import { MatrixClient, MatrixEvent } from "../../../src";
import { Room } from "../../../src/models/room";

/**
 * Note, these tests check the functionality of the RoomReceipts class, but most
 * of them access that functionality via the surrounding Room class, because a
 * room is required for RoomReceipts to function, and this matches the pattern
 * of how this code is used in the wild.
 */
describe("RoomReceipts", () => {
    it("reports events unread if there are no receipts", () => {
        // Given there are no receipts in the room
        const room = createRoom();
        const [event] = createEvent();
        room.addLiveEvents([event]);

        // When I ask about any event, then it is unread
        expect(room.hasUserReadEvent(readerId, event.getId()!)).toBe(false);
    });

    it("reports events we sent as read even if there are no receipts", () => {
        // Given there are no receipts in the room
        const room = createRoom();
        const [event] = createEventSentBy(readerId);
        room.addLiveEvents([event]);

        // When I ask about an event I sent, it is read (because a synthetic
        // receipt was created and stored in RoomReceipts)
        expect(room.hasUserReadEvent(readerId, event.getId()!)).toBe(true);
    });

    it("reports read if we receive an unthreaded receipt for this event", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [event, eventId] = createEvent();
        room.addLiveEvents([event]);
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
        room.addLiveEvents([event1, event2]);

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
        room.addLiveEvents([liveEvent]);
        createOldTimeline(room, [oldEvent]);

        // When we receive a receipt for the live event
        room.addReceipt(createReceipt(readerId, liveEvent));

        // Then the earlier one is read
        expect(room.hasUserReadEvent(readerId, oldEventId)).toBe(true);
    });

    it("reports unread if we receive an unthreaded receipt for an earlier event", () => {
        // Given we have 2 events
        const room = createRoom();
        const [event1] = createEvent();
        const [event2, event2Id] = createEvent();
        room.addLiveEvents([event1, event2]);

        // When we receive a receipt for the earlier event
        room.addReceipt(createReceipt(readerId, event1));

        // Then the later one is unread
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(false);
    });

    it("reports unread if we receive an unthreaded receipt for a different user", () => {
        // Given my event exists and is unread
        const room = createRoom();
        const [event, eventId] = createEvent();
        room.addLiveEvents([event]);
        expect(room.hasUserReadEvent(readerId, eventId)).toBe(false);

        // When we receive a receipt for this event+user
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
        room.addLiveEvents([previousEvent, myEvent]);

        // And I just received a receipt for the previous event
        room.addReceipt(createReceipt(readerId, previousEvent));

        // When I ask about the event I sent, it is read (because of synthetic receipts)
        expect(room.hasUserReadEvent(readerId, myEvent.getId()!)).toBe(true);
    });

    it("correctly reports readness even when receipts arrive out of order", () => {
        // Given we have 3 events
        const room = createRoom();
        const [event1] = createEvent();
        const [event2, event2Id] = createEvent();
        const [event3, event3Id] = createEvent();
        room.addLiveEvents([event1, event2, event3]);

        // When we receive receipts for the older events out of order
        room.addReceipt(createReceipt(readerId, event2));
        room.addReceipt(createReceipt(readerId, event1));

        // Then we correctly ignore the older receipt
        expect(room.hasUserReadEvent(readerId, event2Id)).toBe(true);
        expect(room.hasUserReadEvent(readerId, event3Id)).toBe(false);
    });

    ("threaded receipts");
    ("mixture of threaded and unthreaded receipts");
});

function createFakeClient(): MatrixClient {
    return {
        getUserId: jest.fn(),
        getEventMapper: jest.fn().mockReturnValue(jest.fn()),
        isInitialSyncComplete: jest.fn().mockReturnValue(true),
        supportsThreads: jest.fn().mockReturnValue(true),
    } as unknown as MatrixClient;
}

const senderId = "sender:s.ss";
const readerId = "reader:r.rr";
const otherUserId = "other:o.oo";

function createRoom(): Room {
    return new Room("!rid", createFakeClient(), "@u:s.nz", { timelineSupport: true });
}

let idCounter = 0;
function nextId(): string {
    return "$" + (idCounter++).toString(10);
}

function createEvent(): [MatrixEvent, string] {
    return createEventSentBy(senderId);
}

function createEventSentBy(customSenderId: string): [MatrixEvent, string] {
    const event = new MatrixEvent({ sender: customSenderId, event_id: nextId() });
    return [event, event.getId()!];
}

function createReceipt(userId: string, referencedEvent: MatrixEvent): MatrixEvent {
    return new MatrixEvent({
        type: "m.receipt",
        content: {
            [referencedEvent.getId()!]: {
                "m.read": {
                    [userId]: {
                        ts: 123,
                    },
                },
            },
        },
    });
}

function createOldTimeline(room: Room, events: MatrixEvent[]) {
    const oldTimeline = room.getUnfilteredTimelineSet().addTimeline();
    room.getUnfilteredTimelineSet().addEventsToTimeline(events, true, oldTimeline);
}
