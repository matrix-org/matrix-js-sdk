"use strict";
import 'source-map-support/register';
const sdk = require("../..");
const Filter = sdk.Filter;
const utils = require("../test-utils");

import expect from 'expect';

describe("Filter", function() {
    const filterId = "f1lt3ring15g00d4ursoul";
    const userId = "@sir_arthur_david:humming.tiger";
    let filter;

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
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
                event_format: "client",
            };
            filter.setDefinition(definition);
            expect(filter.getDefinition()).toEqual(definition);
        });
    });
});
