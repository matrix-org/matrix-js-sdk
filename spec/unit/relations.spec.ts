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
import { MatrixEvent, MatrixEventEvent } from "../../src/models/event";
import { Room } from "../../src/models/room";
import { Relations } from "../../src/models/relations";

describe("Relations", function() {
    it("should deduplicate annotations", function() {
        const room = new Room("room123", null, null);
        const relations = new Relations("m.annotation", "m.reaction", room);

        // Create an instance of an annotation
        const eventData = {
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
        };
        const eventA = new MatrixEvent(eventData);

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
        const eventB = new MatrixEvent(eventData);

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
        const targetEvent = new MatrixEvent({
            "sender": "@bob:example.com",
            "type": "m.room.message",
            "event_id": "$2s4yYpEkVQrPglSCSqB_m6E8vDhWsg0yFNyOJdVIb_o",
            "room_id": "!pzVjCQSoQPpXQeHpmK:example.com",
            "content": {},
        });
        const relationEvent = new MatrixEvent({
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

        // Add the target event first, then the relation event
        {
            const room = new Room("room123", null, null);
            const relationsCreated = new Promise(resolve => {
                targetEvent.once(MatrixEventEvent.RelationsCreated, resolve);
            });

            const timelineSet = new EventTimelineSet(room);
            timelineSet.addLiveEvent(targetEvent);
            timelineSet.addLiveEvent(relationEvent);

            await relationsCreated;
        }

        // Add the relation event first, then the target event
        {
            const room = new Room("room123", null, null);
            const relationsCreated = new Promise(resolve => {
                targetEvent.once(MatrixEventEvent.RelationsCreated, resolve);
            });

            const timelineSet = new EventTimelineSet(room);
            timelineSet.addLiveEvent(relationEvent);
            timelineSet.addLiveEvent(targetEvent);

            await relationsCreated;
        }
    });

    it("should re-use Relations between all timeline sets in a room", async () => {
        const room = new Room("room123", null, null);
        const timelineSet1 = new EventTimelineSet(room);
        const timelineSet2 = new EventTimelineSet(room);
        expect(room.relations).toBe(timelineSet1.relations);
        expect(room.relations).toBe(timelineSet2.relations);
    });

    it("should ignore m.replace for state events", async () => {
        const userId = "@bob:example.com";
        const room = new Room("room123", null, userId);
        const relations = new Relations("m.replace", "m.room.topic", room);

        // Create an instance of a state event with rel_type m.replace
        const originalTopic = new MatrixEvent({
            "sender": userId,
            "type": "m.room.topic",
            "event_id": "$orig",
            "room_id": room.roomId,
            "content": {
                "topic": "orig",
            },
            "state_key": "",
        });
        const badlyEditedTopic = new MatrixEvent({
            "sender": userId,
            "type": "m.room.topic",
            "event_id": "$orig",
            "room_id": room.roomId,
            "content": {
                "topic": "topic",
                "m.new_content": {
                    "topic": "edit",
                },
                "m.relates_to": {
                    "event_id": "$orig",
                    "rel_type": "m.replace",
                },
            },
            "state_key": "",
        });

        await relations.setTargetEvent(originalTopic);
        expect(originalTopic.replacingEvent()).toBe(null);
        expect(originalTopic.getContent().topic).toBe("orig");
        expect(badlyEditedTopic.isRelation()).toBe(false);
        expect(badlyEditedTopic.isRelation("m.replace")).toBe(false);

        await relations.addEvent(badlyEditedTopic);
        expect(originalTopic.replacingEvent()).toBe(null);
        expect(originalTopic.getContent().topic).toBe("orig");
        expect(badlyEditedTopic.replacingEvent()).toBe(null);
        expect(badlyEditedTopic.getContent().topic).toBe("topic");
    });
});
