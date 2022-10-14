import { UNREAD_THREAD_NOTIFICATIONS } from "../../src/@types/sync";
import { Filter, IFilterDefinition } from "../../src/filter";
import { mkEvent } from "../test-utils/test-utils";
import { EventType } from "../../src";

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

    describe("setUnreadThreadNotifications", function() {
        it("setUnreadThreadNotifications", function() {
            filter.setUnreadThreadNotifications(true);
            expect(filter.getDefinition()).toEqual({
                room: {
                    timeline: {
                        [UNREAD_THREAD_NOTIFICATIONS.name]: true,
                    },
                },
            });
        });
    });

    describe("filterRoomTimeline", () => {
        it("should return input if no roomTimelineFilter and roomFilter", () => {
            const events = [mkEvent({ type: EventType.Sticker, content: {}, event: true })];
            expect(new Filter(undefined).filterRoomTimeline(events)).toStrictEqual(events);
        });

        it("should filter using components when present", () => {
            const definition: IFilterDefinition = {
                room: {
                    timeline: {
                        types: [EventType.Sticker],
                    },
                },
            };
            const filter = Filter.fromJson(userId, filterId, definition);
            const events = [
                mkEvent({ type: EventType.Sticker, content: {}, event: true }),
                mkEvent({ type: EventType.RoomMessage, content: {}, event: true }),
            ];
            expect(filter.filterRoomTimeline(events)).toStrictEqual([events[0]]);
        });
    });
});
