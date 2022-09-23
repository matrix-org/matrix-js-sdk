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

import { Filter, IFilterDefinition } from "../../src/filter";

describe("Filter", function() {
    const filterId = "f1lt3ring15g00d4ursoul";
    const userId = "@sir_arthur_david:humming.tiger";
    let filter: Filter;

    beforeEach(function() {
        filter = new Filter(userId);
    });

    describe("fromJson", function() {
        it("create a new Filter from the provided values", function() {
            const definition = {
                event_fields: ["type", "content"],
            };
            const f = Filter.fromJson(userId, filterId, definition);
            expect(f.getDefinition()).toEqual(definition);
            expect(f.userId).toEqual(userId);
            expect(f.filterId).toEqual(filterId);
        });
    });

    describe("setTimelineLimit", function() {
        it("should set room.timeline.limit of the filter definition", function() {
            filter.setTimelineLimit(10);
            expect(filter.getDefinition()).toEqual({
                room: {
                    timeline: {
                        limit: 10,
                    },
                },
            });
        });
    });

    describe("setDefinition/getDefinition", function() {
        it("should set and get the filter body", function() {
            const definition = {
                event_format: "client" as IFilterDefinition['event_format'],
            };
            filter.setDefinition(definition);
            expect(filter.getDefinition()).toEqual(definition);
        });
    });
});
