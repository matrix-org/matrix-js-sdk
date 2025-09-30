/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { Direction, type MatrixClient, MatrixEvent, Room } from "../../../src";
import type { MockedObject } from "jest-mock";

const CREATOR_USER_ID = "@creator:example.org";
const MODERATOR_USER_ID = "@moderator:example.org";

describe("Room", () => {
    function createMockClient(): MatrixClient {
        return {
            supportsThreads: jest.fn().mockReturnValue(true),
            decryptEventIfNeeded: jest.fn().mockReturnThis(),
            getUserId: jest.fn().mockReturnValue(CREATOR_USER_ID),
        } as unknown as MockedObject<MatrixClient>;
    }

    function createEvent(eventId: string): MatrixEvent {
        return new MatrixEvent({
            type: "m.room.message",
            content: {
                body: eventId, // we do this for ease of use, not practicality
            },
            event_id: eventId,
            sender: CREATOR_USER_ID,
        });
    }

    function createRedaction(redactsEventId: string): MatrixEvent {
        return new MatrixEvent({
            type: "m.room.redaction",
            redacts: redactsEventId,
            event_id: "$redacts_" + redactsEventId.substring(1),
            sender: CREATOR_USER_ID,
        });
    }

    function getNonStateMainTimelineLiveEvents(room: Room): Array<MatrixEvent> {
        return room
            .getLiveTimeline()
            .getEvents()
            .filter((e) => !e.isState());
    }

    it("should apply redactions locally", async () => {
        const mockClient = createMockClient();
        const room = new Room("!room:example.org", mockClient, CREATOR_USER_ID);
        const messageEvent = createEvent("$message_event");

        // Set up the room
        await room.addLiveEvents([messageEvent], { addToState: false });
        let timeline = getNonStateMainTimelineLiveEvents(room);
        expect(timeline.length).toEqual(1);
        expect(timeline[0].getId()).toEqual(messageEvent.getId());
        expect(timeline[0].isRedacted()).toEqual(false); // "should never happen"

        // Now redact
        const redactionEvent = createRedaction(messageEvent.getId()!);
        await room.addLiveEvents([redactionEvent], { addToState: false });
        timeline = getNonStateMainTimelineLiveEvents(room);
        expect(timeline.length).toEqual(2);
        expect(timeline[0].getId()).toEqual(messageEvent.getId());
        expect(timeline[0].isRedacted()).toEqual(true); // test case
        expect(timeline[1].getId()).toEqual(redactionEvent.getId());
        expect(timeline[1].isRedacted()).toEqual(false); // "should never happen"
    });

    describe("MSC4293: Redact on ban", () => {
        async function setupRoom(andGrantPermissions: boolean): Promise<{ room: Room; messageEvents: MatrixEvent[] }> {
            const mockClient = createMockClient();
            const room = new Room("!room:example.org", mockClient, CREATOR_USER_ID);

            // Pre-populate room
            const messageEvents: MatrixEvent[] = [];
            for (let i = 0; i < 3; i++) {
                messageEvents.push(createEvent(`$message_${i}`));
            }
            await room.addLiveEvents(messageEvents, { addToState: false });

            if (andGrantPermissions) {
                room.getLiveTimeline().getState(Direction.Forward)!.maySendRedactionForEvent = (ev, userId) => {
                    return true;
                };
            }

            return { room, messageEvents };
        }

        function createRedactOnMembershipChange(
            targetUserId: string,
            senderUserId: string,
            membership: string,
        ): MatrixEvent {
            return new MatrixEvent({
                type: "m.room.member",
                state_key: targetUserId,
                content: {
                    "membership": membership,
                    "org.matrix.msc4293.redact_events": true,
                },
                sender: senderUserId,
            });
        }

        function expectRedacted(messageEvents: MatrixEvent[], room: Room, shouldAllBeRedacted: boolean) {
            const actualEvents = getNonStateMainTimelineLiveEvents(room).filter((e) =>
                messageEvents.find((e2) => e2.getId() === e.getId()),
            );
            expect(actualEvents.length).toEqual(messageEvents.length);
            const redactedEvents = actualEvents.filter((e) => e.isRedacted());
            if (shouldAllBeRedacted) {
                expect(redactedEvents.length).toEqual(messageEvents.length);
            } else {
                expect(redactedEvents.length).toEqual(0);
            }
        }

        it("should apply on ban", async () => {
            const { room, messageEvents } = await setupRoom(true);
            const banEvent = createRedactOnMembershipChange(CREATOR_USER_ID, MODERATOR_USER_ID, "ban");
            await room.addLiveEvents([banEvent], { addToState: true });

            expectRedacted(messageEvents, room, true);
        });

        it("should apply on kick", async () => {
            const { room, messageEvents } = await setupRoom(true);
            const kickEvent = createRedactOnMembershipChange(CREATOR_USER_ID, MODERATOR_USER_ID, "leave");
            await room.addLiveEvents([kickEvent], { addToState: true });

            expectRedacted(messageEvents, room, true);
        });

        it("should not apply if the user doesn't have permission to redact", async () => {
            const { room, messageEvents } = await setupRoom(false); // difference from other tests here
            const banEvent = createRedactOnMembershipChange(CREATOR_USER_ID, MODERATOR_USER_ID, "ban");
            await room.addLiveEvents([banEvent], { addToState: true });

            expectRedacted(messageEvents, room, false);
        });

        it("should not apply to self-leaves", async () => {
            const { room, messageEvents } = await setupRoom(true);
            const leaveEvent = createRedactOnMembershipChange(CREATOR_USER_ID, CREATOR_USER_ID, "leave");
            await room.addLiveEvents([leaveEvent], { addToState: true });

            expectRedacted(messageEvents, room, false);
        });

        it("should not apply to invites", async () => {
            const { room, messageEvents } = await setupRoom(true);
            const leaveEvent = createRedactOnMembershipChange(CREATOR_USER_ID, CREATOR_USER_ID, "invite");
            await room.addLiveEvents([leaveEvent], { addToState: true });

            expectRedacted(messageEvents, room, false);
        });

        it("should not apply to joins", async () => {
            const { room, messageEvents } = await setupRoom(true);
            const leaveEvent = createRedactOnMembershipChange(CREATOR_USER_ID, CREATOR_USER_ID, "join");
            await room.addLiveEvents([leaveEvent], { addToState: true });

            expectRedacted(messageEvents, room, false);
        });

        it("should not apply to knocks", async () => {
            const { room, messageEvents } = await setupRoom(true);
            const leaveEvent = createRedactOnMembershipChange(CREATOR_USER_ID, CREATOR_USER_ID, "knock");
            await room.addLiveEvents([leaveEvent], { addToState: true });

            expectRedacted(messageEvents, room, false);
        });
    });
});
