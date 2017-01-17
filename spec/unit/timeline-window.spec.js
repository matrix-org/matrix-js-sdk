"use strict";
let q = require("q");
let sdk = require("../..");
let EventTimeline = sdk.EventTimeline;
let TimelineWindow = sdk.TimelineWindow;
let TimelineIndex = require("../../lib/timeline-window").TimelineIndex;

let utils = require("../test-utils");

let ROOM_ID = "roomId";
let USER_ID = "userId";

/*
 * create a timeline with a bunch (default 3) events.
 * baseIndex is 1 by default.
 */
function createTimeline(numEvents, baseIndex) {
    if (numEvents === undefined) {
        numEvents = 3;
    }
    if (baseIndex === undefined) {
        baseIndex = 1;
    }

    // XXX: this is a horrid hack
    let timelineSet = { room: { roomId: ROOM_ID }};
    timelineSet.room.getUnfilteredTimelineSet = function() {
        return timelineSet;
    };

    let timeline = new EventTimeline(timelineSet);

    // add the events after the baseIndex first
    addEventsToTimeline(timeline, numEvents - baseIndex, false);

    // then add those before the baseIndex
    addEventsToTimeline(timeline, baseIndex, true);

    expect(timeline.getBaseIndex()).toEqual(baseIndex);
    return timeline;
}

function addEventsToTimeline(timeline, numEvents, atStart) {
    for (let i = 0; i < numEvents; i++) {
        timeline.addEvent(
            utils.mkMessage({
                room: ROOM_ID, user: USER_ID,
                event: true,
            }), atStart
        );
    }
}


/*
 * create a pair of linked timelines
 */
function createLinkedTimelines() {
    let tl1 = createTimeline();
    let tl2 = createTimeline();
    tl1.setNeighbouringTimeline(tl2, EventTimeline.FORWARDS);
    tl2.setNeighbouringTimeline(tl1, EventTimeline.BACKWARDS);
    return [tl1, tl2];
}


describe("TimelineIndex", function() {
    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
    });

    describe("minIndex", function() {
        it("should return the min index relative to BaseIndex", function() {
            let timelineIndex = new TimelineIndex(createTimeline(), 0);
            expect(timelineIndex.minIndex()).toEqual(-1);
        });
    });

    describe("maxIndex", function() {
        it("should return the max index relative to BaseIndex", function() {
            let timelineIndex = new TimelineIndex(createTimeline(), 0);
            expect(timelineIndex.maxIndex()).toEqual(2);
        });
    });

    describe("advance", function() {
        it("should advance up to the end of the timeline", function() {
            let timelineIndex = new TimelineIndex(createTimeline(), 0);
            let result = timelineIndex.advance(3);
            expect(result).toEqual(2);
            expect(timelineIndex.index).toEqual(2);
        });

        it("should retreat back to the start of the timeline", function() {
            let timelineIndex = new TimelineIndex(createTimeline(), 0);
            let result = timelineIndex.advance(-2);
            expect(result).toEqual(-1);
            expect(timelineIndex.index).toEqual(-1);
        });

        it("should advance into the next timeline", function() {
            let timelines = createLinkedTimelines();
            let tl1 = timelines[0];
            let tl2 = timelines[1];

            // initialise the index pointing at the end of the first timeline
            let timelineIndex = new TimelineIndex(tl1, 2);

            let result = timelineIndex.advance(1);
            expect(result).toEqual(1);
            expect(timelineIndex.timeline).toBe(tl2);

            // we expect the index to be the zero (ie, the same as the
            // BaseIndex), because the BaseIndex points at the second event,
            // and we've advanced past the first.
            expect(timelineIndex.index).toEqual(0);
        });

        it("should retreat into the previous timeline", function() {
            let timelines = createLinkedTimelines();
            let tl1 = timelines[0];
            let tl2 = timelines[1];

            // initialise the index pointing at the start of the second
            // timeline
            let timelineIndex = new TimelineIndex(tl2, -1);

            let result = timelineIndex.advance(-1);
            expect(result).toEqual(-1);
            expect(timelineIndex.timeline).toBe(tl1);
            expect(timelineIndex.index).toEqual(1);
        });
    });

    describe("retreat", function() {
        it("should retreat up to the start of the timeline", function() {
            let timelineIndex = new TimelineIndex(createTimeline(), 0);
            let result = timelineIndex.retreat(2);
            expect(result).toEqual(1);
            expect(timelineIndex.index).toEqual(-1);
        });
    });
});


describe("TimelineWindow", function() {
    /**
     * create a dummy eventTimelineSet and client, and a TimelineWindow
     * attached to them.
     */
    let timelineSet;
    let client;
    function createWindow(timeline, opts) {
        timelineSet = {};
        client = {};
        client.getEventTimeline = function(timelineSet0, eventId0) {
            expect(timelineSet0).toBe(timelineSet);
            return q(timeline);
        };

        return new TimelineWindow(client, timelineSet, opts);
    }

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
    });

    describe("load", function() {
        it("should initialise from the live timeline", function(done) {
            let liveTimeline = createTimeline();
            let room = {};
            room.getLiveTimeline = function() {
                return liveTimeline;
            };

            let timelineWindow = new TimelineWindow(undefined, room);
            timelineWindow.load(undefined, 2).then(function() {
                let expectedEvents = liveTimeline.getEvents().slice(1);
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);
            }).catch(utils.failTest).done(done);
        });

        it("should initialise from a specific event", function(done) {
            let timeline = createTimeline();
            let eventId = timeline.getEvents()[1].getId();

            let timelineSet = {};
            let client = {};
            client.getEventTimeline = function(timelineSet0, eventId0) {
                expect(timelineSet0).toBe(timelineSet);
                expect(eventId0).toEqual(eventId);
                return q(timeline);
            };

            let timelineWindow = new TimelineWindow(client, timelineSet);
            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = timeline.getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);
            }).catch(utils.failTest).done(done);
        });

        it("canPaginate should return false until load has returned",
           function(done) {
            let timeline = createTimeline();
            timeline.setPaginationToken("toktok1", EventTimeline.BACKWARDS);
            timeline.setPaginationToken("toktok2", EventTimeline.FORWARDS);

            let eventId = timeline.getEvents()[1].getId();

            let timelineSet = {};
            let client = {};

            let timelineWindow = new TimelineWindow(client, timelineSet);

            client.getEventTimeline = function(timelineSet0, eventId0) {
                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);
                return q(timeline);
            };

            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = timeline.getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);
                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);
            }).catch(utils.failTest).done(done);
        });
    });

    describe("pagination", function() {
        it("should be able to advance across the initial timeline",
           function(done) {
            let timeline = createTimeline();
            let eventId = timeline.getEvents()[1].getId();
            let timelineWindow = createWindow(timeline);

            timelineWindow.load(eventId, 1).then(function() {
                let expectedEvents = [timeline.getEvents()[1]];
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);

                return timelineWindow.paginate(EventTimeline.FORWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                let expectedEvents = timeline.getEvents().slice(1);
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);

                return timelineWindow.paginate(EventTimeline.FORWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(false);

                return timelineWindow.paginate(EventTimeline.BACKWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                let expectedEvents = timeline.getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);
                return timelineWindow.paginate(EventTimeline.BACKWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(false);
            }).catch(utils.failTest).done(done);
        });

        it("should advance into next timeline", function(done) {
            let tls = createLinkedTimelines();
            let eventId = tls[0].getEvents()[1].getId();
            let timelineWindow = createWindow(tls[0], {windowLimit: 5});

            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = tls[0].getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);

                return timelineWindow.paginate(EventTimeline.FORWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                let expectedEvents = tls[0].getEvents()
                    .concat(tls[1].getEvents().slice(0, 2));
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);

                return timelineWindow.paginate(EventTimeline.FORWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                // the windowLimit should have made us drop an event from
                // tls[0]
                let expectedEvents = tls[0].getEvents().slice(1)
                    .concat(tls[1].getEvents());
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);
                return timelineWindow.paginate(EventTimeline.FORWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(false);
            }).catch(utils.failTest).done(done);
        });

        it("should retreat into previous timeline", function(done) {
            let tls = createLinkedTimelines();
            let eventId = tls[1].getEvents()[1].getId();
            let timelineWindow = createWindow(tls[1], {windowLimit: 5});

            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = tls[1].getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);

                return timelineWindow.paginate(EventTimeline.BACKWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                let expectedEvents = tls[0].getEvents().slice(1, 3)
                    .concat(tls[1].getEvents());
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);

                return timelineWindow.paginate(EventTimeline.BACKWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                // the windowLimit should have made us drop an event from
                // tls[1]
                let expectedEvents = tls[0].getEvents()
                    .concat(tls[1].getEvents().slice(0, 2));
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);
                return timelineWindow.paginate(EventTimeline.BACKWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(false);
            }).catch(utils.failTest).done(done);
        });

        it("should make forward pagination requests", function(done) {
            let timeline = createTimeline();
            timeline.setPaginationToken("toktok", EventTimeline.FORWARDS);

            let timelineWindow = createWindow(timeline, {windowLimit: 5});
            let eventId = timeline.getEvents()[1].getId();

            client.paginateEventTimeline = function(timeline0, opts) {
                expect(timeline0).toBe(timeline);
                expect(opts.backwards).toBe(false);
                expect(opts.limit).toEqual(2);

                addEventsToTimeline(timeline, 3, false);
                return q(true);
            };

            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = timeline.getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);
                return timelineWindow.paginate(EventTimeline.FORWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                let expectedEvents = timeline.getEvents().slice(0, 5);
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);
            }).catch(utils.failTest).done(done);
        });


        it("should make backward pagination requests", function(done) {
            let timeline = createTimeline();
            timeline.setPaginationToken("toktok", EventTimeline.BACKWARDS);

            let timelineWindow = createWindow(timeline, {windowLimit: 5});
            let eventId = timeline.getEvents()[1].getId();

            client.paginateEventTimeline = function(timeline0, opts) {
                expect(timeline0).toBe(timeline);
                expect(opts.backwards).toBe(true);
                expect(opts.limit).toEqual(2);

                addEventsToTimeline(timeline, 3, true);
                return q(true);
            };

            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = timeline.getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(true);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(false);
                return timelineWindow.paginate(EventTimeline.BACKWARDS, 2);
            }).then(function(success) {
                expect(success).toBe(true);
                let expectedEvents = timeline.getEvents().slice(1, 6);
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);
            }).catch(utils.failTest).done(done);
        });

        it("should limit the number of unsuccessful pagination requests",
        function(done) {
            let timeline = createTimeline();
            timeline.setPaginationToken("toktok", EventTimeline.FORWARDS);

            let timelineWindow = createWindow(timeline, {windowLimit: 5});
            let eventId = timeline.getEvents()[1].getId();

            let paginateCount = 0;
            client.paginateEventTimeline = function(timeline0, opts) {
                expect(timeline0).toBe(timeline);
                expect(opts.backwards).toBe(false);
                expect(opts.limit).toEqual(2);
                paginateCount += 1;
                return q(true);
            };

            timelineWindow.load(eventId, 3).then(function() {
                let expectedEvents = timeline.getEvents();
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);
                return timelineWindow.paginate(EventTimeline.FORWARDS, 2, true, 3);
            }).then(function(success) {
                expect(success).toBe(false);
                expect(paginateCount).toEqual(3);
                let expectedEvents = timeline.getEvents().slice(0, 3);
                expect(timelineWindow.getEvents()).toEqual(expectedEvents);

                expect(timelineWindow.canPaginate(EventTimeline.BACKWARDS))
                    .toBe(false);
                expect(timelineWindow.canPaginate(EventTimeline.FORWARDS))
                    .toBe(true);
            }).catch(utils.failTest).done(done);
        });
    });
});
