/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import MockHttpBackend from "matrix-mock-request";

import { MAIN_ROOM_TIMELINE, ReceiptType, WrappedReceipt } from "../../src/@types/read_receipts";
import { MatrixClient } from "../../src/client";
import { EventType, MatrixEvent, RelationType, Room, threadIdForReceipt } from "../../src/matrix";
import { synthesizeReceipt } from "../../src/models/read-receipt";
import { encodeUri } from "../../src/utils";
import * as utils from "../test-utils/test-utils";

// Jest now uses @sinonjs/fake-timers which exposes tickAsync() and a number of
// other async methods which break the event loop, letting scheduled promise
// callbacks run. Unfortunately, Jest doesn't expose these, so we have to do
// it manually (this is what sinon does under the hood). We do both in a loop
// until the thing we expect happens: hopefully this is the least flakey way
// and avoids assuming anything about the app's behaviour.
const realSetTimeout = setTimeout;
function flushPromises() {
    return new Promise((r) => {
        realSetTimeout(r, 1);
    });
}

let client: MatrixClient;
let httpBackend: MockHttpBackend;

const THREAD_ID = "$thread_event_id";
const ROOM_ID = "!123:matrix.org";

describe("Read receipt", () => {
    let threadRoot: MatrixEvent;
    let threadEvent: MatrixEvent;
    let roomEvent: MatrixEvent;
    let editOfThreadRoot: MatrixEvent;

    beforeEach(() => {
        httpBackend = new MockHttpBackend();
        client = new MatrixClient({
            userId: "@user:server",
            baseUrl: "https://my.home.server",
            accessToken: "my.access.token",
            fetchFn: httpBackend.fetchFn as typeof global.fetch,
        });
        client.isGuest = () => false;
        client.supportsThreads = () => true;

        threadRoot = utils.mkEvent({
            event: true,
            type: EventType.RoomMessage,
            user: "@bob:matrix.org",
            room: ROOM_ID,
            content: { body: "This is the thread root" },
        });
        threadRoot.event.event_id = THREAD_ID;

        threadEvent = utils.mkEvent({
            event: true,
            type: EventType.RoomMessage,
            user: "@bob:matrix.org",
            room: ROOM_ID,
            content: {
                "body": "Hello from a thread",
                "m.relates_to": {
                    "event_id": THREAD_ID,
                    "m.in_reply_to": {
                        event_id: THREAD_ID,
                    },
                    "rel_type": "m.thread",
                },
            },
        });
        roomEvent = utils.mkEvent({
            event: true,
            type: EventType.RoomMessage,
            user: "@bob:matrix.org",
            room: ROOM_ID,
            content: {
                body: "Hello from a room",
            },
        });

        editOfThreadRoot = utils.mkEdit(threadRoot, client, "@bob:matrix.org", ROOM_ID);
        editOfThreadRoot.setThreadId(THREAD_ID);
    });

    describe("sendReceipt", () => {
        it("sends a thread read receipt", async () => {
            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: threadEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(THREAD_ID);
                })
                .respond(200, {});

            client.sendReceipt(threadEvent, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("sends an unthreaded receipt", async () => {
            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: threadEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toBeUndefined();
                })
                .respond(200, {});

            client.sendReadReceipt(threadEvent, ReceiptType.Read, true);

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("sends a room read receipt", async () => {
            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: roomEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(MAIN_ROOM_TIMELINE);
                })
                .respond(200, {});

            client.sendReceipt(roomEvent, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("should send a main timeline read receipt for a reaction to a thread root", async () => {
            roomEvent.event.event_id = THREAD_ID;
            const reaction = utils.mkReaction(roomEvent, client, client.getSafeUserId(), ROOM_ID);
            const thread = new Room(ROOM_ID, client, client.getSafeUserId()).createThread(
                THREAD_ID,
                roomEvent,
                [threadEvent],
                false,
            );
            threadEvent.setThread(thread);
            reaction.setThread(thread);

            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: reaction.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(MAIN_ROOM_TIMELINE);
                })
                .respond(200, {});

            client.sendReceipt(reaction, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });

        it("should always send unthreaded receipts if threads support is disabled", async () => {
            client.supportsThreads = () => false;

            httpBackend
                .when(
                    "POST",
                    encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
                        $roomId: ROOM_ID,
                        $receiptType: ReceiptType.Read,
                        $eventId: roomEvent.getId()!,
                    }),
                )
                .check((request) => {
                    expect(request.data.thread_id).toEqual(undefined);
                })
                .respond(200, {});

            client.sendReceipt(roomEvent, ReceiptType.Read, {});

            await httpBackend.flushAllExpected();
            await flushPromises();
        });
    });

    describe("synthesizeReceipt", () => {
        it.each([
            { getEvent: () => roomEvent, destinationId: MAIN_ROOM_TIMELINE },
            { getEvent: () => threadEvent, destinationId: THREAD_ID },
            { getEvent: () => editOfThreadRoot, destinationId: MAIN_ROOM_TIMELINE },
        ])("adds the receipt to $destinationId", ({ getEvent, destinationId }) => {
            const event = getEvent();
            const userId = "@bob:example.org";
            const receiptType = ReceiptType.Read;

            const fakeReadReceipt = synthesizeReceipt(userId, event, receiptType);

            const content = fakeReadReceipt.getContent()[event.getId()!][receiptType][userId];

            expect(content.thread_id).toEqual(destinationId);
        });
    });

    describe("addReceiptToStructure", () => {
        it("should not allow an older unthreaded receipt to clobber a `main` threaded one", () => {
            const userId = client.getSafeUserId();
            const room = new Room(ROOM_ID, client, userId);
            room.findEventById = jest.fn().mockReturnValue({} as MatrixEvent);

            const unthreadedReceipt: WrappedReceipt = {
                eventId: "$olderEvent",
                data: {
                    ts: 1234567880,
                },
            };
            const mainTimelineReceipt: WrappedReceipt = {
                eventId: "$newerEvent",
                data: {
                    ts: 1234567890,
                },
            };

            room.addReceiptToStructure(
                mainTimelineReceipt.eventId,
                ReceiptType.ReadPrivate,
                userId,
                mainTimelineReceipt.data,
                false,
            );
            expect(room.getEventReadUpTo(userId)).toBe(mainTimelineReceipt.eventId);

            room.addReceiptToStructure(
                unthreadedReceipt.eventId,
                ReceiptType.ReadPrivate,
                userId,
                unthreadedReceipt.data,
                false,
            );
            expect(room.getEventReadUpTo(userId)).toBe(mainTimelineReceipt.eventId);
        });
    });

    describe("Determining the right thread ID for a receipt", () => {
        it("provides the thread root ID for a normal threaded message", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomMessage,
                user: "@bob:matrix.org",
                room: "!roomx",
                content: {
                    "body": "Hello from a thread",
                    "m.relates_to": {
                        "event_id": "$thread1",
                        "m.in_reply_to": {
                            event_id: "$thread1",
                        },
                        "rel_type": "m.thread",
                    },
                },
            });

            expect(threadIdForReceipt(event)).toEqual("$thread1");
        });

        it("provides 'main' for a non-thread message", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomMessage,
                user: "@bob:matrix.org",
                room: "!roomx",
                content: { body: "Hello" },
            });

            expect(threadIdForReceipt(event)).toEqual("main");
        });

        it("provides 'main' for a thread root", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomMessage,
                user: "@bob:matrix.org",
                room: "!roomx",
                content: { body: "Hello" },
            });
            // Set thread ID to this event's ID, meaning this is the thread root
            event.setThreadId(event.getId());

            expect(threadIdForReceipt(event)).toEqual("main");
        });

        it("provides 'main' for a reaction to a thread root", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.Reaction,
                user: "@bob:matrix.org",
                room: "!roomx",
                content: {
                    "m.relates_to": {
                        rel_type: RelationType.Annotation,
                        event_id: "$thread1",
                        key: Math.random().toString(),
                    },
                },
            });

            // Set thread Id, meaning this looks like it's in the thread (this
            // happens for relations like this, so that they appear in the
            // thread's timeline).
            event.setThreadId("$thread1");

            // But because it's a reaction to the thread root, it's in main
            expect(threadIdForReceipt(event)).toEqual("main");
        });

        it("provides the thread ID for a reaction to a threaded message", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.Reaction,
                user: "@bob:matrix.org",
                room: "!roomx",
                content: {
                    "m.relates_to": {
                        rel_type: RelationType.Annotation,
                        event_id: "$withinthread2",
                        key: Math.random().toString(),
                    },
                },
            });

            // Set thread Id, to say this message is in the thread. This happens
            // when the message arrived and is classified.
            event.setThreadId("$thread1");

            // It's in the thread because it refers to something else, not the
            // thread root
            expect(threadIdForReceipt(event)).toEqual("$thread1");
        });

        it("(suprisingly?) provides 'main' for a redaction of a threaded message", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomRedaction,
                content: {
                    reason: "Spamming",
                },
                redacts: "$withinthread2",
                room: "!roomx",
                user: "@bob:matrix.org",
            });

            // Set thread Id, to say this message is in the thread.
            event.setThreadId("$thread1");

            // Because redacting a message removes all its m.relations, the
            // message is no longer in the thread, so we must send a receipt for
            // it in the main timeline.
            //
            // This is surprising, but it follows the spec (at least up to
            // current latest room version, 11). In fact, the event should no
            // longer have a thread ID set on it, so this testcase should not
            // come up. (At time of writing, this is not the case though - it
            // does still have threadId set.)
            expect(threadIdForReceipt(event)).toEqual("main");
        });

        it("provides the thread ID for an edit of a threaded message", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomRedaction,
                content: {
                    "body": "Edited!",
                    "m.new_content": {
                        body: "Edited!",
                    },
                    "m.relates_to": {
                        rel_type: RelationType.Replace,
                        event_id: "$withinthread2",
                    },
                },
                room: "!roomx",
                user: "@bob:matrix.org",
            });

            // Set thread Id, to say this message is in the thread.
            event.setThreadId("$thread1");

            // It's in the thread, because it redacts something inside the
            // thread (not the thread root)
            expect(threadIdForReceipt(event)).toEqual("$thread1");
        });

        it("provides 'main' for an edit of a thread root", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomRedaction,
                content: {
                    "body": "Edited!",
                    "m.new_content": {
                        body: "Edited!",
                    },
                    "m.relates_to": {
                        rel_type: RelationType.Replace,
                        event_id: "$thread1",
                    },
                },
                room: "!roomx",
                user: "@bob:matrix.org",
            });

            // Set thread Id, to say this message is in the thread.
            event.setThreadId("$thread1");

            // It's in the thread, because it redacts something inside the
            // thread (not the thread root)
            expect(threadIdForReceipt(event)).toEqual("main");
        });

        it("provides 'main' for a redaction of the thread root", () => {
            const event = utils.mkEvent({
                event: true,
                type: EventType.RoomRedaction,
                content: {
                    reason: "Spamming",
                },
                redacts: "$thread1",
                room: "!roomx",
                user: "@bob:matrix.org",
            });

            // Set thread Id, to say this message is in the thread.
            event.setThreadId("$thread1");

            // It's in the thread, because it redacts something inside the
            // thread (not the thread root)
            expect(threadIdForReceipt(event)).toEqual("main");
        });
    });
});
