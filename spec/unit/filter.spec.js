"use strict";
let sdk = require("../..");
let Filter = sdk.Filter;
let utils = require("../test-utils");

describe("Filter", function() {
    let filterId = "f1lt3ring15g00d4ursoul";
    let userId = "@sir_arthur_david:humming.tiger";
    let filter;

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
        filter = new Filter(userId);
    });

    describe("fromJson", function() {
        it("create a new Filter from the provided values", function() {
            let definition = {
                event_fields: ["type", "content"],
            };
            let f = Filter.fromJson(userId, filterId, definition);
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
            let definition = {
                event_format: "client",
            };
            filter.setDefinition(definition);
            expect(filter.getDefinition()).toEqual(definition);
        });
    });
});
