/*
Copyright 2022 - 2023 The Matrix.org Foundation C.I.C.

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

import { MatrixClient, PendingEventOrdering } from "../../../src/client";
import { Room } from "../../../src/models/room";
import { Thread, THREAD_RELATION_TYPE, ThreadEvent } from "../../../src/models/thread";
import { mkThread } from "../../test-utils/thread";
import { TestClient } from "../../TestClient";
import { emitPromise, mkMessage, mock } from "../../test-utils/test-utils";
import { Direction, EventStatus, MatrixEvent } from "../../../src";
import { ReceiptType } from "../../../src/@types/read_receipts";
import { getMockClientWithEventEmitter, mockClientMethodsUser } from "../../test-utils/client";
import { ReEmitter } from "../../../src/ReEmitter";
import { Feature, ServerSupport } from "../../../src/feature";

describe("Thread", () => {
    describe("constructor", () => {
        it("should explode for element-web#22141 logging", () => {
            // Logging/debugging for https://github.com/vector-im/element-web/issues/22141
            expect(() => {
                new Thread("$event", undefined, {} as any); // deliberate cast to test error case
            }).toThrow("element-web#22141: A thread requires a room in order to function");
        });
    });

    it("includes pending events in replyCount", async () => {
        const myUserId = "@bob:example.org";
        const testClient = new TestClient(myUserId, "DEVICE", "ACCESS_TOKEN", undefined, { timelineSupport: false });
        const client = testClient.client;
        const room = new Room("123", client, myUserId, {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        jest.spyOn(client, "getRoom").mockReturnValue(room);

        const { thread } = mkThread({
            room,
            client,
            authorId: myUserId,
            participantUserIds: ["@alice:example.org"],
            length: 3,
        });
        await emitPromise(thread, ThreadEvent.Update);
        expect(thread.length).toBe(2);

        const event = mkMessage({
            room: room.roomId,
            user: myUserId,
            msg: "thread reply",
            relatesTo: {
                rel_type: THREAD_RELATION_TYPE.name,
                event_id: thread.id,
            },
            event: true,
        });
        await thread.processEvent(event);
        event.setStatus(EventStatus.SENDING);
        room.addPendingEvent(event, "txn01");

        await emitPromise(thread, ThreadEvent.Update);
        expect(thread.length).toBe(3);
    });

    describe("hasUserReadEvent", () => {
        let myUserId: string;
        let client: MatrixClient;
        let room: Room;

        beforeEach(() => {
            client = getMockClientWithEventEmitter({
                ...mockClientMethodsUser(),
                getRoom: jest.fn().mockImplementation(() => room),
                decryptEventIfNeeded: jest.fn().mockResolvedValue(void 0),
                supportsExperimentalThreads: jest.fn().mockReturnValue(true),
            });
            client.reEmitter = mock(ReEmitter, "ReEmitter");
            client.canSupport = new Map();
            Object.keys(Feature).forEach((feature) => {
                client.canSupport.set(feature as Feature, ServerSupport.Stable);
            });

            myUserId = client.getUserId()!;

            room = new Room("123", client, myUserId);

            const receipt = new MatrixEvent({
                type: "m.receipt",
                room_id: "!foo:bar",
                content: {
                    // first threaded receipt
                    "$event0:localhost": {
                        [ReceiptType.Read]: {
                            [client.getUserId()!]: { ts: 100, thread_id: "$threadId:localhost" },
                        },
                    },
                    // last unthreaded receipt
                    "$event1:localhost": {
                        [ReceiptType.Read]: {
                            [client.getUserId()!]: { ts: 200 },
                            ["@alice:example.org"]: { ts: 200 },
                        },
                    },
                    // last threaded receipt
                    "$event2:localhost": {
                        [ReceiptType.Read]: {
                            [client.getUserId()!]: { ts: 300, thread_id: "$threadId" },
                        },
                    },
                },
            });
            room.addReceipt(receipt);

            jest.spyOn(client, "getRoom").mockReturnValue(room);
        });

        afterAll(() => {
            jest.resetAllMocks();
        });

        it("considers own events with no RR as read", () => {
            const { thread, events } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: [myUserId],
                length: 2,
            });

            // The event is automatically considered read as the current user is the sender
            expect(thread.hasUserReadEvent(myUserId, events.at(-1)!.getId() ?? "")).toBeTruthy();
        });

        it("considers other events with no RR as unread", () => {
            const { thread, events } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: [myUserId],
                length: 25,
                ts: 190,
            });

            // Before alice's last unthreaded receipt
            expect(thread.hasUserReadEvent("@alice:example.org", events.at(1)!.getId() ?? "")).toBeTruthy();

            // After alice's last unthreaded receipt
            expect(thread.hasUserReadEvent("@alice:example.org", events.at(-1)!.getId() ?? "")).toBeFalsy();
        });

        it("considers event as read if there's a more recent unthreaded receipt", () => {
            const { thread, events } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: ["@alice:example.org"],
                length: 2,
                ts: 150, // before the latest unthreaded receipt
            });
            expect(thread.hasUserReadEvent(client.getUserId()!, events.at(-1)!.getId() ?? "")).toBe(true);
        });

        it("considers event as unread if there's no more recent unthreaded receipt", () => {
            const { thread, events } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: ["@alice:example.org"],
                length: 2,
                ts: 1000,
            });
            expect(thread.hasUserReadEvent(client.getUserId()!, events.at(-1)!.getId() ?? "")).toBe(false);
        });
    });

    describe("getEventReadUpTo", () => {
        let myUserId: string;
        let client: MatrixClient;
        let room: Room;

        beforeEach(() => {
            client = getMockClientWithEventEmitter({
                ...mockClientMethodsUser(),
                getRoom: jest.fn().mockImplementation(() => room),
                decryptEventIfNeeded: jest.fn().mockResolvedValue(void 0),
                supportsExperimentalThreads: jest.fn().mockReturnValue(true),
            });
            client.reEmitter = mock(ReEmitter, "ReEmitter");
            client.canSupport = new Map();
            Object.keys(Feature).forEach((feature) => {
                client.canSupport.set(feature as Feature, ServerSupport.Stable);
            });

            myUserId = client.getUserId()!;

            room = new Room("123", client, myUserId);

            jest.spyOn(client, "getRoom").mockReturnValue(room);
        });

        afterAll(() => {
            jest.resetAllMocks();
        });

        it("uses unthreaded receipt to figure out read up to", () => {
            const receipt = new MatrixEvent({
                type: "m.receipt",
                room_id: "!foo:bar",
                content: {
                    // last unthreaded receipt
                    "$event1:localhost": {
                        [ReceiptType.Read]: {
                            ["@alice:example.org"]: { ts: 200 },
                        },
                    },
                },
            });
            room.addReceipt(receipt);

            const { thread, events } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: [myUserId],
                length: 25,
                ts: 190,
            });

            // The 10th event has been read, as alice's last unthreaded receipt is at ts 200
            // and `mkThread` increment every thread response by 1ms.
            expect(thread.getEventReadUpTo("@alice:example.org")).toBe(events.at(9)!.getId());
        });

        it("considers thread created before the first threaded receipt to be read", () => {
            const receipt = new MatrixEvent({
                type: "m.receipt",
                room_id: "!foo:bar",
                content: {
                    // last unthreaded receipt
                    "$event1:localhost": {
                        [ReceiptType.Read]: {
                            [myUserId]: { ts: 200, thread_id: "$threadId" },
                        },
                    },
                },
            });
            room.addReceipt(receipt);

            const { thread, events } = mkThread({
                room,
                client,
                authorId: "@alice:example.org",
                participantUserIds: ["@alice:example.org"],
                length: 2,
                ts: 10,
            });

            // This is marked as read as it is before alice's first threaded receipt...
            expect(thread.getEventReadUpTo(myUserId)).toBe(events.at(-1)!.getId());

            const { thread: thread2 } = mkThread({
                room,
                client,
                authorId: "@alice:example.org",
                participantUserIds: ["@alice:example.org"],
                length: 2,
                ts: 1000,
            });

            // Nothing has been read, this thread is after the first threaded receipt...
            expect(thread2.getEventReadUpTo(myUserId)).toBe(null);
        });
    });

    describe("resetLiveTimeline", () => {
        // ResetLiveTimeline is used when we have missing messages between the current live timeline's end and newly
        // received messages. In that case, we want to replace the existing live timeline. To ensure pagination
        // continues working correctly, new pagination tokens need to be set on both the old live timeline (which is
        // now a regular timeline) and the new live timeline.
        it("replaces the live timeline and correctly sets pagination tokens", async () => {
            const myUserId = "@bob:example.org";
            const testClient = new TestClient(myUserId, "DEVICE", "ACCESS_TOKEN", undefined, {
                timelineSupport: false,
            });
            const client = testClient.client;
            const room = new Room("123", client, myUserId, {
                pendingEventOrdering: PendingEventOrdering.Detached,
            });

            jest.spyOn(client, "getRoom").mockReturnValue(room);

            const { thread } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: ["@alice:example.org"],
                length: 3,
            });
            await emitPromise(thread, ThreadEvent.Update);
            expect(thread.length).toBe(2);

            jest.spyOn(client, "createMessagesRequest").mockImplementation((_, token) =>
                Promise.resolve({
                    chunk: [],
                    start: `${token}-new`,
                    end: `${token}-new`,
                }),
            );

            function timelines(): [string | null, string | null][] {
                return thread.timelineSet
                    .getTimelines()
                    .map((it) => [it.getPaginationToken(Direction.Backward), it.getPaginationToken(Direction.Forward)]);
            }

            expect(timelines()).toEqual([[null, null]]);
            const promise = thread.resetLiveTimeline("b1", "f1");
            expect(timelines()).toEqual([
                [null, "f1"],
                ["b1", null],
            ]);
            await promise;
            expect(timelines()).toEqual([
                [null, "f1-new"],
                ["b1-new", null],
            ]);
        });

        // As the pagination tokens cannot be used right now, resetLiveTimeline needs to replace them before they can
        // be used. But if in the future the bug in synapse is fixed, and they can actually be used, we can get into a
        // state where the client has paginated (and changed the tokens) while resetLiveTimeline tries to set the
        // corrected tokens. To prevent such a race condition, we make sure that resetLiveTimeline respects any
        // changes done to the pagination tokens.
        it("replaces the live timeline but does not replace changed pagination tokens", async () => {
            const myUserId = "@bob:example.org";
            const testClient = new TestClient(myUserId, "DEVICE", "ACCESS_TOKEN", undefined, {
                timelineSupport: false,
            });
            const client = testClient.client;
            const room = new Room("123", client, myUserId, {
                pendingEventOrdering: PendingEventOrdering.Detached,
            });

            jest.spyOn(client, "getRoom").mockReturnValue(room);

            const { thread } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: ["@alice:example.org"],
                length: 3,
            });
            await emitPromise(thread, ThreadEvent.Update);
            expect(thread.length).toBe(2);

            jest.spyOn(client, "createMessagesRequest").mockImplementation((_, token) =>
                Promise.resolve({
                    chunk: [],
                    start: `${token}-new`,
                    end: `${token}-new`,
                }),
            );

            function timelines(): [string | null, string | null][] {
                return thread.timelineSet
                    .getTimelines()
                    .map((it) => [it.getPaginationToken(Direction.Backward), it.getPaginationToken(Direction.Forward)]);
            }

            expect(timelines()).toEqual([[null, null]]);
            const promise = thread.resetLiveTimeline("b1", "f1");
            expect(timelines()).toEqual([
                [null, "f1"],
                ["b1", null],
            ]);
            thread.timelineSet.getTimelines()[0].setPaginationToken("f2", Direction.Forward);
            thread.timelineSet.getTimelines()[1].setPaginationToken("b2", Direction.Backward);
            await promise;
            expect(timelines()).toEqual([
                [null, "f2"],
                ["b2", null],
            ]);
        });

        it("is correctly called by the room", async () => {
            const myUserId = "@bob:example.org";
            const testClient = new TestClient(myUserId, "DEVICE", "ACCESS_TOKEN", undefined, {
                timelineSupport: false,
            });
            const client = testClient.client;
            const room = new Room("123", client, myUserId, {
                pendingEventOrdering: PendingEventOrdering.Detached,
            });

            jest.spyOn(client, "getRoom").mockReturnValue(room);

            const { thread } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: ["@alice:example.org"],
                length: 3,
            });
            await emitPromise(thread, ThreadEvent.Update);
            expect(thread.length).toBe(2);
            const mock = jest.spyOn(thread, "resetLiveTimeline");
            mock.mockReturnValue(Promise.resolve());

            room.resetLiveTimeline("b1", "f1");
            expect(mock).toHaveBeenCalledWith("b1", "f1");
        });
    });
});
