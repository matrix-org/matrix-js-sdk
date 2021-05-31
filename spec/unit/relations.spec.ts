/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { EventTimelineSet } from "../../src/models/event-timeline-set";
import { MatrixEvent } from "../../src/models/event";
import { Relations } from "../../src/models/relations";

// Helper
function createRelationEvent() {
    return new MatrixEvent({
        "sender": "@bob:example.com",
        "type": "m.reaction",
        "event_id": "$cZ1biX33ENJqIm00ks0W_hgiO_6CHrsAc3ZQrnLeNTw",
        "room_id": "!pzVjCQSoQPpXQeHpmK:example.com",
        "content": {
            "m.relates_to": {
                "event_id": "$2s4yYpEkVQrPglSCSqB_m6E8vDhWsg0yFNyOJdVIb_o",
                "key": "👍️",
                "rel_type": "m.annotation",
            },
        },
    });
}

function createTargetEvent() {
    return new MatrixEvent({
        "sender": "@bob:example.com",
        "type": "m.room.message",
        "event_id": "$2s4yYpEkVQrPglSCSqB_m6E8vDhWsg0yFNyOJdVIb_o",
        "room_id": "!pzVjCQSoQPpXQeHpmK:example.com",
        "content": {},
    });
}

describe("Relations", function() {
    it("should deduplicate annotations", function() {
        const relations = new Relations("m.annotation", "m.reaction");

        // Create an instance of an annotation
        const eventA = createRelationEvent();

        // Add the event once and check results
        {
            relations.addEvent(eventA);
            const annotationsByKey = relations.getSortedAnnotationsByKey();
            expect(annotationsByKey.length).toEqual(1);
            const [key, events] = annotationsByKey[0];
            expect(key).toEqual("👍️");
            expect(events.size).toEqual(1);
        }

        // Add the event again and expect the same
        {
            relations.addEvent(eventA);
            const annotationsByKey = relations.getSortedAnnotationsByKey();
            expect(annotationsByKey.length).toEqual(1);
            const [key, events] = annotationsByKey[0];
            expect(key).toEqual("👍️");
            expect(events.size).toEqual(1);
        }

        // Create a fresh object with the same event content
        const eventB = createRelationEvent();

        // Add the event again and expect the same
        {
            relations.addEvent(eventB);
            const annotationsByKey = relations.getSortedAnnotationsByKey();
            expect(annotationsByKey.length).toEqual(1);
            const [key, events] = annotationsByKey[0];
            expect(key).toEqual("👍️");
            expect(events.size).toEqual(1);
        }
    });

    it("should emit created regardless of ordering", async function() {
        const targetEvent = createTargetEvent();
        const relationEvent = createRelationEvent();

        // Stub the room
        const room = {
            getPendingEvent() { return null; },
            getUnfilteredTimelineSet() { return null; },
        };

        // Add the target event first, then the relation event
        {
            const relationsCreated = new Promise(resolve => {
                targetEvent.once("Event.relationsCreated", resolve);
            })

            const timelineSet = new EventTimelineSet(room, {
                unstableClientRelationAggregation: true,
            });
            timelineSet.addLiveEvent(targetEvent);
            timelineSet.addLiveEvent(relationEvent);

            await relationsCreated;
        }

        // Add the relation event first, then the target event
        {
            const relationsCreated = new Promise(resolve => {
                targetEvent.once("Event.relationsCreated", resolve);
            })

            const timelineSet = new EventTimelineSet(room, {
                unstableClientRelationAggregation: true,
            });
            timelineSet.addLiveEvent(relationEvent);
            timelineSet.addLiveEvent(targetEvent);

            await relationsCreated;
        }
    });

    it("should return relations object with no relations set when getRelationsForEvent", async function() {
        const targetEvent = createTargetEvent();
        // Stub the room
        const room = {
            getPendingEvent() { return null; },
            getUnfilteredTimelineSet() { return null; },
        };

        // Add the target event to a timeline set
        const timelineSet = new EventTimelineSet(room, {
            unstableClientRelationAggregation: true,
        });
        timelineSet.addLiveEvent(targetEvent);

        // Get a relation for the event
        const eventRelations = timelineSet.getRelationsForEvent(targetEvent.getId(), "m.annotation", "m.reaction");

        // The relation exists
        expect(eventRelations).not.toBeUndefined();
        expect(eventRelations.getRelations()).toEqual([]);

        // When getting the relation again, we get the same reference
        const eventRelations2 = timelineSet.getRelationsForEvent(targetEvent.getId(), "m.annotation", "m.reaction");
        expect(eventRelations).toBe(eventRelations2);

        // Add a relation event to the timeline
        const relationsCreated = new Promise(resolve => {
            targetEvent.once("Event.relationsCreated", resolve);
        });

        const relationEvent = createRelationEvent();
        timelineSet.addLiveEvent(relationEvent);
        await relationsCreated;

        // Getting the relation again, i˙ts still the same:
        const eventRelations3 = timelineSet.getRelationsForEvent(targetEvent.getId(), "m.annotation", "m.reaction");
        expect(eventRelations2).toBe(eventRelations3);
        // a new relation event exists:
        expect(eventRelations3.getRelations()).toHaveLength(1);
    })
});
