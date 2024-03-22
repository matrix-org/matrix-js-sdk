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

import { IEvent } from "../../src";
import { randomString } from "../../src/randomstring";
import { getRelationsThreadFilter } from "../../src/thread-utils";

function makeEvent(relatesToEvent: string, relType: string): Partial<IEvent> {
    return {
        event_id: randomString(10),
        type: "m.room.message",
        content: {
            "msgtype": "m.text",
            "body": "foo",
            "m.relates_to": {
                rel_type: relType,
                event_id: relatesToEvent,
            },
        },
    };
}

describe("getRelationsThreadFilter", () => {
    it("should filter out relations directly to the thread root event", () => {
        const threadId = "thisIsMyThreadRoot";

        const reactionToRoot = makeEvent(threadId, "m.annotation");
        const editToRoot = makeEvent(threadId, "m.replace");
        const firstThreadedReply = makeEvent(threadId, "m.thread");
        const reactionToThreadedEvent = makeEvent(firstThreadedReply.event_id!, "m.annotation");

        const filteredEvents = [reactionToRoot, editToRoot, firstThreadedReply, reactionToThreadedEvent].filter(
            getRelationsThreadFilter(threadId),
        );

        expect(filteredEvents).toEqual([firstThreadedReply, reactionToThreadedEvent]);
    });
});
