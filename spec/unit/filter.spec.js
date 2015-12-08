"use strict";
var sdk = require("../..");
var Filter = sdk.Filter;
var utils = require("../test-utils");

describe("Filter", function() {
    var filterId = "f1lt3ring15g00d4ursoul";
    var userId = "@sir_arthur_david:humming.tiger";
    var filter;

    beforeEach(function() {
        utils.beforeEach(this);
        filter = new Filter(userId);
    });

    describe("fromJson", function() {
        it("create a new Filter from the provided values", function() {
            var definition = {
                event_fields: ["type", "content"]
            };
            var f = Filter.fromJson(userId, filterId, definition);
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
                        limit: 10
                    }
                }
            });
        });
    });

    describe("setDefinition/getDefinition", function() {
        it("should set and get the filter body", function() {
            var definition = {
                event_format: "client"
            };
            filter.setDefinition(definition);
            expect(filter.getDefinition()).toEqual(definition);
        });
    });
});
