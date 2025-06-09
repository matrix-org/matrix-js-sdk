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

import {MatrixClient, MatrixEvent, MatrixEventEvent, Room} from "../../../src";
import type {MockedObject} from "jest-mock";
import exp from "node:constants";

describe("Room", () => {
    function createMockClient(): MatrixClient {
        return {
            supportsThreads: jest.fn().mockReturnValue(true),
            decryptEventIfNeeded: jest.fn().mockReturnThis(),
            getUserId: jest.fn().mockReturnValue("@user:server"),
        } as unknown as MockedObject<MatrixClient>;
    }

    function createEvent(eventId: string): MatrixEvent {
        return new MatrixEvent({
            type: "m.room.message",
            content: {
                body: eventId, // we do this for ease of use, not practicality
            },
            event_id: eventId,
        });
    }

    function createRedaction(redactsEventId: string): MatrixEvent {
        return new MatrixEvent({
            type: "m.room.redaction",
            redacts: redactsEventId,
            event_id: "$redacts_" + redactsEventId.substring(1),
        });
    }

    function getNonStateMainTimelineLiveEvents(room: Room): Array<MatrixEvent> {
        return room.getLiveTimeline().getEvents().filter(e => !e.isState());
    }

    it("should apply redactions locally", async () => {
        const mockClient = createMockClient();
        const room = new Room("!room:example.org", mockClient, "name");
        const messageEvent = createEvent("$message_event");

        // Set up the room
        await room.addLiveEvents([messageEvent], {addToState: false});
        let timeline = getNonStateMainTimelineLiveEvents(room);
        expect(timeline.length).toEqual(1);
        expect(timeline[0].getId()).toEqual(messageEvent.getId());
        expect(timeline[0].isRedacted()).toEqual(false); // "should never happen"

        // Now redact
        const redactionEvent = createRedaction(messageEvent.getId()!);
        await room.addLiveEvents([redactionEvent], {addToState: false});
        timeline = getNonStateMainTimelineLiveEvents(room);
        expect(timeline.length).toEqual(2);
        expect(timeline[0].getId()).toEqual(messageEvent.getId());
        expect(timeline[0].isRedacted()).toEqual(true); // test case
        expect(timeline[1].getId()).toEqual(redactionEvent.getId());
        expect(timeline[1].isRedacted()).toEqual(false); // "should never happen"
    });
});
