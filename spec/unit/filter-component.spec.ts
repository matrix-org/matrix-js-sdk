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

import { describe, expect, it } from "@jest/globals";

import { RelationType } from "../../src";
import { FilterComponent } from "../../src/filter-component";
import { mkEvent } from "../test-utils/test-utils";

describe("Filter Component", function () {
    describe("types", function () {
        it("should filter out events with other types", function () {
            const filter = new FilterComponent({ types: ["m.room.message"] });
            const event = mkEvent({
                type: "m.room.member",
                content: {},
                room: "roomId",
                event: true,
            });

            const checkResult = filter.check(event);

            expect(checkResult).toBe(false);
        });

        it("should validate events with the same type", function () {
            const filter = new FilterComponent({ types: ["m.room.message"] });
            const event = mkEvent({
                type: "m.room.message",
                content: {},
                room: "roomId",
                event: true,
            });

            const checkResult = filter.check(event);

            expect(checkResult).toBe(true);
        });

        it("should filter out events by relation participation", function () {
            const currentUserId = "@me:server.org";
            const filter = new FilterComponent(
                {
                    related_by_senders: [currentUserId],
                },
                currentUserId,
            );

            const threadRootNotParticipated = mkEvent({
                type: "m.room.message",
                content: {},
                room: "roomId",
                user: "@someone-else:server.org",
                event: true,
                unsigned: {
                    "m.relations": {
                        "m.thread": {
                            count: 2,
                            current_user_participated: false,
                        },
                    },
                },
            });

            expect(filter.check(threadRootNotParticipated)).toBe(false);
        });

        it("should keep events by relation participation", function () {
            const currentUserId = "@me:server.org";
            const filter = new FilterComponent(
                {
                    related_by_senders: [currentUserId],
                },
                currentUserId,
            );

            const threadRootParticipated = mkEvent({
                type: "m.room.message",
                content: {},
                unsigned: {
                    "m.relations": {
                        "m.thread": {
                            count: 2,
                            current_user_participated: true,
                        },
                    },
                },
                user: "@someone-else:server.org",
                room: "roomId",
                event: true,
            });

            expect(filter.check(threadRootParticipated)).toBe(true);
        });

        it("should filter out events by relation type", function () {
            const filter = new FilterComponent({
                related_by_rel_types: ["m.thread"],
            });

            const referenceRelationEvent = mkEvent({
                type: "m.room.message",
                content: {},
                room: "roomId",
                event: true,
                unsigned: {
                    "m.relations": {
                        [RelationType.Reference]: {},
                    },
                },
            });

            expect(filter.check(referenceRelationEvent)).toBe(false);
        });

        it("should keep events by relation type", function () {
            const filter = new FilterComponent({
                related_by_rel_types: ["m.thread"],
            });

            const threadRootEvent = mkEvent({
                type: "m.room.message",
                content: {},
                unsigned: {
                    "m.relations": {
                        "m.thread": {
                            count: 2,
                            current_user_participated: true,
                        },
                    },
                },
                room: "roomId",
                event: true,
            });

            const eventWithMultipleRelations = mkEvent({
                type: "m.room.message",
                content: {},
                unsigned: {
                    "m.relations": {
                        "testtesttest": {},
                        "m.annotation": {
                            chunk: [
                                {
                                    type: "m.reaction",
                                    key: "🤫",
                                    count: 1,
                                },
                            ],
                        },
                        "m.thread": {
                            count: 2,
                            current_user_participated: true,
                        },
                    },
                },
                room: "roomId",
                event: true,
            });

            const noMatchEvent = mkEvent({
                type: "m.room.message",
                content: {},
                unsigned: {
                    "m.relations": {
                        testtesttest: {},
                    },
                },
                room: "roomId",
                event: true,
            });

            expect(filter.check(threadRootEvent)).toBe(true);
            expect(filter.check(eventWithMultipleRelations)).toBe(true);
            expect(filter.check(noMatchEvent)).toBe(false);
        });
    });

    describe("toJSON", () => {
        it("should omit empty values", () => {
            const filter = new FilterComponent({ types: ["m.room.message"], senders: ["@alice:example.com"] });
            expect(filter.toJSON()).toEqual({ types: ["m.room.message"], senders: ["@alice:example.com"] });
        });
    });
});
