import * as utils from "../test-utils/test-utils";
import { EventTimeline, Filter, MatrixEvent } from "../../src/matrix";
import { logger } from "../../src/logger";
import { TestClient } from "../TestClient";
import { Thread, THREAD_RELATION_TYPE } from "../../src/models/thread";

const userId = "@alice:localhost";
const userName = "Alice";
const accessToken = "aseukfgwef";
const roomId = "!foo:bar";
const otherUserId = "@bob:localhost";

const USER_MEMBERSHIP_EVENT = utils.mkMembership({
    room: roomId, mship: "join", user: userId, name: userName,
});

const ROOM_NAME_EVENT = utils.mkEvent({
    type: "m.room.name", room: roomId, user: otherUserId,
    content: {
        name: "Old room name",
    },
});

const INITIAL_SYNC_DATA = {
    next_batch: "s_5_3",
    rooms: {
        join: {
            "!foo:bar": {  // roomId
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomId, user: otherUserId, msg: "hello",
                        }),
                    ],
                    prev_batch: "f_1_1",
                },
                state: {
                    events: [
                        ROOM_NAME_EVENT,
                        utils.mkMembership({
                            room: roomId, mship: "join",
                            user: otherUserId, name: "Bob",
                        }),
                        USER_MEMBERSHIP_EVENT,
                        utils.mkEvent({
                            type: "m.room.create", room: roomId, user: userId,
                            content: {
                                creator: userId,
                            },
                        }),
                    ],
                },
            },
        },
    },
};

const EVENTS = [
    utils.mkMessage({
        room: roomId, user: userId, msg: "we",
    }),
    utils.mkMessage({
        room: roomId, user: userId, msg: "could",
    }),
    utils.mkMessage({
        room: roomId, user: userId, msg: "be",
    }),
    utils.mkMessage({
        room: roomId, user: userId, msg: "heroes",
    }),
];

const THREAD_ROOT = utils.mkEvent({
    room: roomId,
    user: userId,
    type: "m.room.message",
    content: {
        "body": "thread root",
        "msgtype": "m.text",
    },
    unsigned: {
        "m.relations": {
            "io.element.thread": {
                "latest_event": undefined,
                "count": 1,
                "current_user_participated": true,
            },
        },
    },
});

const THREAD_REPLY = utils.mkEvent({
    room: roomId,
    user: userId,
    type: "m.room.message",
    content: {
        "body": "thread reply",
        "msgtype": "m.text",
        "m.relates_to": {
            // We can't use the const here because we change server support mode for test
            rel_type: "io.element.thread",
            event_id: THREAD_ROOT.event_id,
        },
    },
});

THREAD_ROOT.unsigned["m.relations"]["io.element.thread"].latest_event = THREAD_REPLY;

// start the client, and wait for it to initialise
function startClient(httpBackend, client) {
    httpBackend.when("GET", "/versions").respond(200, {});
    httpBackend.when("GET", "/pushrules").respond(200, {});
    httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
    httpBackend.when("GET", "/sync").respond(200, INITIAL_SYNC_DATA);

    client.startClient();

    // set up a promise which will resolve once the client is initialised
    const prom = new Promise((resolve) => {
        client.on("sync", function(state) {
            logger.log("sync", state);
            if (state != "SYNCING") {
                return;
            }
            resolve();
        });
    });

    return Promise.all([
        httpBackend.flushAllExpected(),
        prom,
    ]);
}

describe("getEventTimeline support", function() {
    let httpBackend;
    let client;

    beforeEach(function() {
        const testClient = new TestClient(userId, "DEVICE", accessToken);
        client = testClient.client;
        httpBackend = testClient.httpBackend;
    });

    afterEach(function() {
        if (client) {
            client.stopClient();
        }
        return httpBackend.stop();
    });

    it("timeline support must be enabled to work", function() {
        return startClient(httpBackend, client).then(function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];
            expect(client.getEventTimeline(timelineSet, "event")).rejects.toBeTruthy();
        });
    });

    it("timeline support works when enabled", function() {
        const testClient = new TestClient(
            userId,
            "DEVICE",
            accessToken,
            undefined,
            { timelineSupport: true },
        );
        client = testClient.client;
        httpBackend = testClient.httpBackend;

        return startClient(httpBackend, client).then(() => {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];
            expect(client.getEventTimeline(timelineSet, "event")).rejects.toBeFalsy();
        });
    });

    it("scrollback should be able to scroll back to before a gappy /sync", function() {
        // need a client with timelineSupport disabled to make this work
        let room;

        return startClient(httpBackend, client).then(function() {
            room = client.getRoom(roomId);

            httpBackend.when("GET", "/sync").respond(200, {
                next_batch: "s_5_4",
                rooms: {
                    join: {
                        "!foo:bar": {
                            timeline: {
                                events: [
                                    EVENTS[0],
                                ],
                                prev_batch: "f_1_1",
                            },
                        },
                    },
                },
            });

            httpBackend.when("GET", "/sync").respond(200, {
                next_batch: "s_5_5",
                rooms: {
                    join: {
                        "!foo:bar": {
                            timeline: {
                                events: [
                                    EVENTS[1],
                                ],
                                limited: true,
                                prev_batch: "f_1_2",
                            },
                        },
                    },
                },
            });

            return Promise.all([
                httpBackend.flushAllExpected(),
                utils.syncPromise(client, 2),
            ]);
        }).then(function() {
            expect(room.timeline.length).toEqual(1);
            expect(room.timeline[0].event).toEqual(EVENTS[1]);

            httpBackend.when("GET", "/messages").respond(200, {
                chunk: [EVENTS[0]],
                start: "pagin_start",
                end: "pagin_end",
            });
            httpBackend.flush("/messages", 1);
            return client.scrollback(room);
        }).then(function() {
            expect(room.timeline.length).toEqual(2);
            expect(room.timeline[0].event).toEqual(EVENTS[0]);
            expect(room.timeline[1].event).toEqual(EVENTS[1]);
            expect(room.oldState.paginationToken).toEqual("pagin_end");
        });
    });
});

describe("MatrixClient event timelines", function() {
    let client = null;
    let httpBackend = null;

    beforeEach(function() {
        const testClient = new TestClient(
            userId,
            "DEVICE",
            accessToken,
            undefined,
            { timelineSupport: true },
        );
        client = testClient.client;
        httpBackend = testClient.httpBackend;

        return startClient(httpBackend, client);
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
        Thread.setServerSideSupport(false);
    });

    describe("getEventTimeline", function() {
        it("should create a new timeline for new events", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];
            httpBackend.when("GET", "/rooms/!foo%3Abar/context/event1%3Abar")
                .respond(200, function() {
                    return {
                        start: "start_token",
                        events_before: [EVENTS[1], EVENTS[0]],
                        event: EVENTS[2],
                        events_after: [EVENTS[3]],
                        state: [
                            ROOM_NAME_EVENT,
                            USER_MEMBERSHIP_EVENT,
                        ],
                        end: "end_token",
                    };
                });

            return Promise.all([
                client.getEventTimeline(timelineSet, "event1:bar").then(function(tl) {
                    expect(tl.getEvents().length).toEqual(4);
                    for (let i = 0; i < 4; i++) {
                        expect(tl.getEvents()[i].event).toEqual(EVENTS[i]);
                        expect(tl.getEvents()[i].sender.name).toEqual(userName);
                    }
                    expect(tl.getPaginationToken(EventTimeline.BACKWARDS))
                        .toEqual("start_token");
                    expect(tl.getPaginationToken(EventTimeline.FORWARDS))
                        .toEqual("end_token");
                }),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should return existing timeline for known events", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];
            httpBackend.when("GET", "/sync").respond(200, {
                next_batch: "s_5_4",
                rooms: {
                    join: {
                        "!foo:bar": {
                            timeline: {
                                events: [
                                    EVENTS[0],
                                ],
                                prev_batch: "f_1_2",
                            },
                        },
                    },
                },
            });

            return Promise.all([
                httpBackend.flush("/sync"),
                utils.syncPromise(client),
            ]).then(function() {
                return client.getEventTimeline(timelineSet, EVENTS[0].event_id);
            }).then(function(tl) {
                expect(tl.getEvents().length).toEqual(2);
                expect(tl.getEvents()[1].event).toEqual(EVENTS[0]);
                expect(tl.getEvents()[1].sender.name).toEqual(userName);
                expect(tl.getPaginationToken(EventTimeline.BACKWARDS))
                    .toEqual("f_1_1");
                // expect(tl.getPaginationToken(EventTimeline.FORWARDS))
                //    .toEqual("s_5_4");
            });
        });

        it("should update timelines where they overlap a previous /sync", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];
            httpBackend.when("GET", "/sync").respond(200, {
                next_batch: "s_5_4",
                rooms: {
                    join: {
                        "!foo:bar": {
                            timeline: {
                                events: [
                                    EVENTS[3],
                                ],
                                prev_batch: "f_1_2",
                            },
                        },
                    },
                },
            });

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[2].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token",
                        events_before: [EVENTS[1]],
                        event: EVENTS[2],
                        events_after: [EVENTS[3]],
                        end: "end_token",
                        state: [],
                    };
                });

            const prom = new Promise((resolve, reject) => {
                client.on("sync", function() {
                    client.getEventTimeline(timelineSet, EVENTS[2].event_id,
                    ).then(function(tl) {
                        expect(tl.getEvents().length).toEqual(4);
                        expect(tl.getEvents()[0].event).toEqual(EVENTS[1]);
                        expect(tl.getEvents()[1].event).toEqual(EVENTS[2]);
                        expect(tl.getEvents()[3].event).toEqual(EVENTS[3]);
                        expect(tl.getPaginationToken(EventTimeline.BACKWARDS))
                            .toEqual("start_token");
                        // expect(tl.getPaginationToken(EventTimeline.FORWARDS))
                        //    .toEqual("s_5_4");
                    }).then(resolve, reject);
                });
            });

            return Promise.all([
                httpBackend.flushAllExpected(),
                prom,
            ]);
        });

        it("should join timelines where they overlap a previous /context", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            // we fetch event 0, then 2, then 3, and finally 1. 1 is returned
            // with context which joins them all up.
            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[0].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: EVENTS[0],
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[2].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token2",
                        events_before: [],
                        event: EVENTS[2],
                        events_after: [],
                        end: "end_token2",
                        state: [],
                    };
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[3].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token3",
                        events_before: [],
                        event: EVENTS[3],
                        events_after: [],
                        end: "end_token3",
                        state: [],
                    };
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[1].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token4",
                        events_before: [EVENTS[0]],
                        event: EVENTS[1],
                        events_after: [EVENTS[2], EVENTS[3]],
                        end: "end_token4",
                        state: [],
                    };
                });

            let tl0;
            let tl3;
            return Promise.all([
                client.getEventTimeline(timelineSet, EVENTS[0].event_id,
                ).then(function(tl) {
                    expect(tl.getEvents().length).toEqual(1);
                    tl0 = tl;
                    return client.getEventTimeline(timelineSet, EVENTS[2].event_id);
                }).then(function(tl) {
                    expect(tl.getEvents().length).toEqual(1);
                    return client.getEventTimeline(timelineSet, EVENTS[3].event_id);
                }).then(function(tl) {
                    expect(tl.getEvents().length).toEqual(1);
                    tl3 = tl;
                    return client.getEventTimeline(timelineSet, EVENTS[1].event_id);
                }).then(function(tl) {
                    // we expect it to get merged in with event 2
                    expect(tl.getEvents().length).toEqual(2);
                    expect(tl.getEvents()[0].event).toEqual(EVENTS[1]);
                    expect(tl.getEvents()[1].event).toEqual(EVENTS[2]);
                    expect(tl.getNeighbouringTimeline(EventTimeline.BACKWARDS))
                        .toBe(tl0);
                    expect(tl.getNeighbouringTimeline(EventTimeline.FORWARDS))
                        .toBe(tl3);
                    expect(tl0.getPaginationToken(EventTimeline.BACKWARDS))
                        .toEqual("start_token0");
                    expect(tl0.getPaginationToken(EventTimeline.FORWARDS))
                        .toBe(null);
                    expect(tl3.getPaginationToken(EventTimeline.BACKWARDS))
                        .toBe(null);
                    expect(tl3.getPaginationToken(EventTimeline.FORWARDS))
                        .toEqual("end_token3");
                }),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should fail gracefully if there is no event field", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];
            // we fetch event 0, then 2, then 3, and finally 1. 1 is returned
            // with context which joins them all up.
            httpBackend.when("GET", "/rooms/!foo%3Abar/context/event1")
                .respond(200, function() {
                    return {
                        start: "start_token",
                        events_before: [],
                        events_after: [],
                        end: "end_token",
                        state: [],
                    };
                });

            return Promise.all([
                client.getEventTimeline(timelineSet, "event1",
                ).then(function(tl) {
                    // could do with a fail()
                    expect(true).toBeFalsy();
                }, function(e) {
                    expect(String(e)).toMatch(/'event'/);
                }),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should handle thread replies with server support by fetching a contiguous thread timeline", async () => {
            client.clientOpts.experimentalThreadSupport = true;
            Thread.setServerSideSupport(true);
            client.stopClient(); // we don't need the client to be syncing at this time
            const room = client.getRoom(roomId);
            const thread = room.createThread(THREAD_ROOT.event_id, undefined, [], false);
            const timelineSet = thread.timelineSet;

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" + encodeURIComponent(THREAD_REPLY.event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: THREAD_REPLY,
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/event/" + encodeURIComponent(THREAD_ROOT.event_id))
                .respond(200, function() {
                    return THREAD_ROOT;
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/relations/" +
                encodeURIComponent(THREAD_ROOT.event_id) + "/" +
                encodeURIComponent(THREAD_RELATION_TYPE.name) + "?limit=20")
                .respond(200, function() {
                    return {
                        original_event: THREAD_ROOT,
                        chunk: [THREAD_REPLY],
                        // no next batch as this is the oldest end of the timeline
                    };
                });

            const timelinePromise = client.getEventTimeline(timelineSet, THREAD_REPLY.event_id);
            await httpBackend.flushAllExpected();

            const timeline = await timelinePromise;

            expect(timeline.getEvents().find(e => e.getId() === THREAD_ROOT.event_id)).toBeTruthy();
            expect(timeline.getEvents().find(e => e.getId() === THREAD_REPLY.event_id)).toBeTruthy();
        });

        it("should return relevant timeline from non-thread timelineSet when asking for the thread root", async () => {
            client.clientOpts.experimentalThreadSupport = true;
            Thread.setServerSideSupport(true);
            client.stopClient(); // we don't need the client to be syncing at this time
            const room = client.getRoom(roomId);
            const threadRoot = new MatrixEvent(THREAD_ROOT);
            const thread = room.createThread(THREAD_ROOT.event_id, threadRoot, [threadRoot], false);
            const timelineSet = room.getTimelineSets()[0];

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" + encodeURIComponent(THREAD_ROOT.event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: THREAD_ROOT,
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            const [timeline] = await Promise.all([
                client.getEventTimeline(timelineSet, THREAD_ROOT.event_id),
                httpBackend.flushAllExpected(),
            ]);

            expect(timeline).not.toBe(thread.liveTimeline);
            expect(timelineSet.getTimelines()).toContain(timeline);
            expect(timeline.getEvents().find(e => e.getId() === THREAD_ROOT.event_id)).toBeTruthy();
        });

        it("should return undefined when event is not in the thread that the given timelineSet is representing", () => {
            client.clientOpts.experimentalThreadSupport = true;
            Thread.setServerSideSupport(true);
            client.stopClient(); // we don't need the client to be syncing at this time
            const room = client.getRoom(roomId);
            const threadRoot = new MatrixEvent(THREAD_ROOT);
            const thread = room.createThread(THREAD_ROOT.event_id, threadRoot, [threadRoot], false);
            const timelineSet = thread.timelineSet;

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" + encodeURIComponent(EVENTS[0].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: EVENTS[0],
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            return Promise.all([
                expect(client.getEventTimeline(timelineSet, EVENTS[0].event_id)).resolves.toBeUndefined(),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should return undefined when event is within a thread but timelineSet is not", () => {
            client.clientOpts.experimentalThreadSupport = true;
            Thread.setServerSideSupport(true);
            client.stopClient(); // we don't need the client to be syncing at this time
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" + encodeURIComponent(THREAD_REPLY.event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: THREAD_REPLY,
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            return Promise.all([
                expect(client.getEventTimeline(timelineSet, THREAD_REPLY.event_id)).resolves.toBeUndefined(),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should should add lazy loading filter when requested", async () => {
            client.clientOpts.lazyLoadMembers = true;
            client.stopClient(); // we don't need the client to be syncing at this time
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            const req = httpBackend.when("GET", "/rooms/!foo%3Abar/context/" + encodeURIComponent(EVENTS[0].event_id));
            req.respond(200, function() {
                return {
                    start: "start_token0",
                    events_before: [],
                    event: EVENTS[0],
                    events_after: [],
                    end: "end_token0",
                    state: [],
                };
            });
            req.check((request) => {
                expect(request.opts.qs.filter).toEqual(JSON.stringify(Filter.LAZY_LOADING_MESSAGES_FILTER));
            });

            await Promise.all([
                client.getEventTimeline(timelineSet, EVENTS[0].event_id),
                httpBackend.flushAllExpected(),
            ]);
        });
    });

    describe("getLatestTimeline", function() {
        it("should create a new timeline for new events", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            const latestMessageId = 'event1:bar';

            httpBackend.when("GET", "/rooms/!foo%3Abar/messages")
                .respond(200, function() {
                    return {
                        chunk: [{
                            event_id: latestMessageId,
                        }],
                    };
                });

            httpBackend.when("GET", `/rooms/!foo%3Abar/context/${encodeURIComponent(latestMessageId)}`)
                .respond(200, function() {
                    return {
                        start: "start_token",
                        events_before: [EVENTS[1], EVENTS[0]],
                        event: EVENTS[2],
                        events_after: [EVENTS[3]],
                        state: [
                            ROOM_NAME_EVENT,
                            USER_MEMBERSHIP_EVENT,
                        ],
                        end: "end_token",
                    };
                });

            return Promise.all([
                client.getLatestTimeline(timelineSet).then(function(tl) {
                    // Instead of this assertion logic, we could just add a spy
                    // for `getEventTimeline` and make sure it's called with the
                    // correct parameters. This doesn't feel too bad to make sure
                    // `getLatestTimeline` is doing the right thing though.
                    expect(tl.getEvents().length).toEqual(4);
                    for (let i = 0; i < 4; i++) {
                        expect(tl.getEvents()[i].event).toEqual(EVENTS[i]);
                        expect(tl.getEvents()[i].sender.name).toEqual(userName);
                    }
                    expect(tl.getPaginationToken(EventTimeline.BACKWARDS))
                        .toEqual("start_token");
                    expect(tl.getPaginationToken(EventTimeline.FORWARDS))
                        .toEqual("end_token");
                }),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should throw error when /messages does not return a message", () => {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            httpBackend.when("GET", "/rooms/!foo%3Abar/messages")
                .respond(200, () => {
                    return {
                        chunk: [
                            // No messages to return
                        ],
                    };
                });

            return Promise.all([
                expect(client.getLatestTimeline(timelineSet)).rejects.toThrow(),
                httpBackend.flushAllExpected(),
            ]);
        });
    });

    describe("paginateEventTimeline", function() {
        it("should allow you to paginate backwards", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[0].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: EVENTS[0],
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/messages")
                .check(function(req) {
                    const params = req.queryParams;
                    expect(params.dir).toEqual("b");
                    expect(params.from).toEqual("start_token0");
                    expect(params.limit).toEqual("30");
                }).respond(200, function() {
                    return {
                        chunk: [EVENTS[1], EVENTS[2]],
                        end: "start_token1",
                    };
                });

            let tl;
            return Promise.all([
                client.getEventTimeline(timelineSet, EVENTS[0].event_id,
                ).then(function(tl0) {
                    tl = tl0;
                    return client.paginateEventTimeline(tl, { backwards: true });
                }).then(function(success) {
                    expect(success).toBeTruthy();
                    expect(tl.getEvents().length).toEqual(3);
                    expect(tl.getEvents()[0].event).toEqual(EVENTS[2]);
                    expect(tl.getEvents()[1].event).toEqual(EVENTS[1]);
                    expect(tl.getEvents()[2].event).toEqual(EVENTS[0]);
                    expect(tl.getPaginationToken(EventTimeline.BACKWARDS))
                        .toEqual("start_token1");
                    expect(tl.getPaginationToken(EventTimeline.FORWARDS))
                        .toEqual("end_token0");
                }),
                httpBackend.flushAllExpected(),
            ]);
        });

        it("should allow you to paginate forwards", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            httpBackend.when("GET", "/rooms/!foo%3Abar/context/" +
                             encodeURIComponent(EVENTS[0].event_id))
                .respond(200, function() {
                    return {
                        start: "start_token0",
                        events_before: [],
                        event: EVENTS[0],
                        events_after: [],
                        end: "end_token0",
                        state: [],
                    };
                });

            httpBackend.when("GET", "/rooms/!foo%3Abar/messages")
                .check(function(req) {
                    const params = req.queryParams;
                    expect(params.dir).toEqual("f");
                    expect(params.from).toEqual("end_token0");
                    expect(params.limit).toEqual("20");
                }).respond(200, function() {
                    return {
                        chunk: [EVENTS[1], EVENTS[2]],
                        end: "end_token1",
                    };
                });

            let tl;
            return Promise.all([
                client.getEventTimeline(timelineSet, EVENTS[0].event_id,
                ).then(function(tl0) {
                    tl = tl0;
                    return client.paginateEventTimeline(
                        tl, { backwards: false, limit: 20 });
                }).then(function(success) {
                    expect(success).toBeTruthy();
                    expect(tl.getEvents().length).toEqual(3);
                    expect(tl.getEvents()[0].event).toEqual(EVENTS[0]);
                    expect(tl.getEvents()[1].event).toEqual(EVENTS[1]);
                    expect(tl.getEvents()[2].event).toEqual(EVENTS[2]);
                    expect(tl.getPaginationToken(EventTimeline.BACKWARDS))
                        .toEqual("start_token0");
                    expect(tl.getPaginationToken(EventTimeline.FORWARDS))
                        .toEqual("end_token1");
                }),
                httpBackend.flushAllExpected(),
            ]);
        });
    });

    describe("event timeline for sent events", function() {
        const TXN_ID = "txn1";
        const event = utils.mkMessage({
            room: roomId, user: userId, msg: "a body",
        });
        event.unsigned = { transaction_id: TXN_ID };

        beforeEach(function() {
            // set up handlers for both the message send, and the
            // /sync
            httpBackend.when("PUT", "/send/m.room.message/" + TXN_ID)
                .respond(200, {
                    event_id: event.event_id,
                });
            httpBackend.when("GET", "/sync").respond(200, {
                next_batch: "s_5_4",
                rooms: {
                    join: {
                        "!foo:bar": {
                            timeline: {
                                events: [
                                    event,
                                ],
                                prev_batch: "f_1_1",
                            },
                        },
                    },
                },
            });
        });

        it("should work when /send returns before /sync", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            return Promise.all([
                client.sendTextMessage(roomId, "a body", TXN_ID).then(function(res) {
                    expect(res.event_id).toEqual(event.event_id);
                    return client.getEventTimeline(timelineSet, event.event_id);
                }).then(function(tl) {
                    // 2 because the initial sync contained an event
                    expect(tl.getEvents().length).toEqual(2);
                    expect(tl.getEvents()[1].getContent().body).toEqual("a body");

                    // now let the sync complete, and check it again
                    return Promise.all([
                        httpBackend.flush("/sync", 1),
                        utils.syncPromise(client),
                    ]);
                }).then(function() {
                    return client.getEventTimeline(timelineSet, event.event_id);
                }).then(function(tl) {
                    expect(tl.getEvents().length).toEqual(2);
                    expect(tl.getEvents()[1].event).toEqual(event);
                }),

                httpBackend.flush("/send/m.room.message/" + TXN_ID, 1),
            ]);
        });

        it("should work when /send returns after /sync", function() {
            const room = client.getRoom(roomId);
            const timelineSet = room.getTimelineSets()[0];

            return Promise.all([
                // initiate the send, and set up checks to be done when it completes
                // - but note that it won't complete until after the /sync does, below.
                client.sendTextMessage(roomId, "a body", TXN_ID).then(function(res) {
                    logger.log("sendTextMessage completed");
                    expect(res.event_id).toEqual(event.event_id);
                    return client.getEventTimeline(timelineSet, event.event_id);
                }).then(function(tl) {
                    logger.log("getEventTimeline completed (2)");
                    expect(tl.getEvents().length).toEqual(2);
                    expect(tl.getEvents()[1].getContent().body).toEqual("a body");
                }),

                Promise.all([
                    httpBackend.flush("/sync", 1),
                    utils.syncPromise(client),
                ]).then(function() {
                    return client.getEventTimeline(timelineSet, event.event_id);
                }).then(function(tl) {
                    logger.log("getEventTimeline completed (1)");
                    expect(tl.getEvents().length).toEqual(2);
                    expect(tl.getEvents()[1].event).toEqual(event);

                    // now let the send complete.
                    return httpBackend.flush("/send/m.room.message/" + TXN_ID, 1);
                }),
            ]);
        });
    });

    it("should handle gappy syncs after redactions", function() {
        // https://github.com/vector-im/vector-web/issues/1389

        // a state event, followed by a redaction thereof
        const event = utils.mkMembership({
            room: roomId, mship: "join", user: otherUserId,
        });
        const redaction = utils.mkEvent({
            type: "m.room.redaction",
            room_id: roomId,
            sender: otherUserId,
            content: {},
        });
        redaction.redacts = event.event_id;

        const syncData = {
            next_batch: "batch1",
            rooms: {
                join: {},
            },
        };
        syncData.rooms.join[roomId] = {
            timeline: {
                events: [
                    event,
                    redaction,
                ],
                limited: false,
            },
        };
        httpBackend.when("GET", "/sync").respond(200, syncData);

        return Promise.all([
            httpBackend.flushAllExpected(),
            utils.syncPromise(client),
        ]).then(function() {
            const room = client.getRoom(roomId);
            const tl = room.getLiveTimeline();
            expect(tl.getEvents().length).toEqual(3);
            expect(tl.getEvents()[1].isRedacted()).toBe(true);

            const sync2 = {
                next_batch: "batch2",
                rooms: {
                    join: {},
                },
            };
            sync2.rooms.join[roomId] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomId, user: otherUserId, msg: "world",
                        }),
                    ],
                    limited: true,
                    prev_batch: "newerTok",
                },
            };
            httpBackend.when("GET", "/sync").respond(200, sync2);

            return Promise.all([
                httpBackend.flushAllExpected(),
                utils.syncPromise(client),
            ]);
        }).then(function() {
            const room = client.getRoom(roomId);
            const tl = room.getLiveTimeline();
            expect(tl.getEvents().length).toEqual(1);
        });
    });
});
