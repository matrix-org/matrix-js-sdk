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

import { MatrixClient, PendingEventOrdering } from "../../../src/client";
import { Room } from "../../../src/models/room";
import { Thread, THREAD_RELATION_TYPE, ThreadEvent } from "../../../src/models/thread";
import { mkThread } from "../../test-utils/thread";
import { TestClient } from "../../TestClient";
import { emitPromise, mkMessage } from "../../test-utils/test-utils";
import { EventStatus } from "../../../src";

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
        const myUserId = "@bob:example.org";
        let client: MatrixClient;
        let room: Room;

        beforeEach(() => {
            const testClient = new TestClient(myUserId, "DEVICE", "ACCESS_TOKEN", undefined, {
                timelineSupport: false,
            });
            client = testClient.client;
            room = new Room("123", client, myUserId);

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

            expect(thread.hasUserReadEvent(myUserId, events.at(-1)!.getId() ?? "")).toBeTruthy();
        });

        it("considers other events with no RR as unread", () => {
            const { thread, events } = mkThread({
                room,
                client,
                authorId: myUserId,
                participantUserIds: ["@alice:example.org"],
                length: 2,
            });

            expect(thread.hasUserReadEvent("@alice:example.org", events.at(-1)!.getId() ?? "")).toBeFalsy();
        });
    });
});
