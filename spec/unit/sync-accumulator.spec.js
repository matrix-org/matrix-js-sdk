"use strict";
import 'source-map-support/register';
const sdk = require("../..");
const SyncAccumulator = sdk.SyncAccumulator;
const utils = require("../test-utils");

import expect from 'expect';

describe("SyncAccumulator", function() {
    let sa;

    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
        sa = new SyncAccumulator({
            maxTimelineEntries: 10,
        });
    });

    it("should return the same /sync response if accumulated exactly once", () => {
        // technically cheating since we also cheekily pre-populate keys we
        // know that the sync accumulator will pre-populate.
        // It isn't 100% transitive.
        const res = {
            next_batch: "abc",
            rooms: {
                invite: {},
                leave: {},
                join: {
                    "!foo:bar": {
                        account_data: { events: [] },
                        ephemeral: { events: [] },
                        unread_notifications: {},
                        state: {
                            events: [
                                member("alice", "join"),
                                member("bob", "join"),
                            ],
                        },
                        timeline: {
                            events: [msg("alice", "hi")],
                            prev_batch: "something",
                        },
                    },
                },
            },
        };
        sa.accumulateRooms(res);
        const output = sa.getJSON();
        expect(output.nextBatch).toEqual(res.next_batch);
        expect(output.roomsData).toEqual(res.rooms);
    });

    it("should prune the timeline to the oldest prev_batch within the limit", () => {
        // maxTimelineEntries is 10 so we should get back all
        // 10 timeline messages with a prev_batch of "pinned_to_1"
        sa.accumulateRooms(syncSkeleton({
            state: { events: [member("alice", "join")] },
            timeline: {
                events: [
                    msg("alice", "1"),
                    msg("alice", "2"),
                    msg("alice", "3"),
                    msg("alice", "4"),
                    msg("alice", "5"),
                    msg("alice", "6"),
                    msg("alice", "7"),
                ],
                prev_batch: "pinned_to_1",
            },
        }));
        sa.accumulateRooms(syncSkeleton({
            state: { events: [] },
            timeline: {
                events: [
                    msg("alice", "8"),
                ],
                prev_batch: "pinned_to_8",
            },
        }));
        sa.accumulateRooms(syncSkeleton({
            state: { events: [] },
            timeline: {
                events: [
                    msg("alice", "9"),
                    msg("alice", "10"),
                ],
                prev_batch: "pinned_to_10",
            },
        }));

        let output = sa.getJSON().roomsData.join["!foo:bar"];

        expect(output.timeline.events.length).toEqual(10);
        output.timeline.events.forEach((e, i) => {
            expect(e.content.body).toEqual(""+(i+1));
        });
        expect(output.timeline.prev_batch).toEqual("pinned_to_1");

        // accumulate more messages. Now it can't have a prev_batch of "pinned to 1"
        // AND give us <= 10 messages without losing messages in-between.
        // It should try to find the oldest prev_batch which still fits into 10
        // messages, which is "pinned to 8".
        sa.accumulateRooms(syncSkeleton({
            state: { events: [] },
            timeline: {
                events: [
                    msg("alice", "11"),
                    msg("alice", "12"),
                    msg("alice", "13"),
                    msg("alice", "14"),
                    msg("alice", "15"),
                    msg("alice", "16"),
                    msg("alice", "17"),
                ],
                prev_batch: "pinned_to_11",
            },
        }));

        output = sa.getJSON().roomsData.join["!foo:bar"];

        expect(output.timeline.events.length).toEqual(10);
        output.timeline.events.forEach((e, i) => {
            expect(e.content.body).toEqual(""+(i+8));
        });
        expect(output.timeline.prev_batch).toEqual("pinned_to_8");
    });

    it("should drop typing notifications", () => {
        const res = syncSkeleton({
            ephemeral: {
                events: [{
                    type: "m.typing",
                    content: {
                        user_ids: ["@alice:localhost"],
                    },
                    room_id: "!foo:bar",
                }],
            },
        });
        sa.accumulateRooms(res);
        expect(
            sa.getJSON().roomsData.join["!foo:bar"].ephemeral.events.length,
        ).toEqual(0);
    });

    it("should clobber account data based on event type", () => {
        const acc1 = {
            type: "favourite.food",
            content: {
                food: "banana",
            },
        };
        const acc2 = {
            type: "favourite.food",
            content: {
                food: "apple",
            },
        };
        sa.accumulateRooms(syncSkeleton({
            account_data: {
                events: [acc1],
            },
        }));
        sa.accumulateRooms(syncSkeleton({
            account_data: {
                events: [acc2],
            },
        }));
        expect(
            sa.getJSON().roomsData.join["!foo:bar"].account_data.events.length,
        ).toEqual(1);
        expect(
            sa.getJSON().roomsData.join["!foo:bar"].account_data.events[0],
        ).toEqual(acc2);
    });

    it("should accumulate read receipts", () => {
        const receipt1 = {
            type: "m.receipt",
            room_id: "!foo:bar",
            content: {
                "$event1:localhost": {
                    "m.read": {
                        "@alice:localhost": { ts: 1 },
                        "@bob:localhost": { ts: 2 },
                    },
                    "some.other.receipt.type": {
                        "@should_be_ignored:localhost": { key: "val" },
                    },
                },
            },
        };
        const receipt2 = {
            type: "m.receipt",
            room_id: "!foo:bar",
            content: {
                "$event2:localhost": {
                    "m.read": {
                        "@bob:localhost": { ts: 2 }, // clobbers event1 receipt
                        "@charlie:localhost": { ts: 3 },
                    },
                },
            },
        };
        sa.accumulateRooms(syncSkeleton({
            ephemeral: {
                events: [receipt1],
            },
        }));
        sa.accumulateRooms(syncSkeleton({
            ephemeral: {
                events: [receipt2],
            },
        }));

        expect(
            sa.getJSON().roomsData.join["!foo:bar"].ephemeral.events.length,
        ).toEqual(1);
        expect(
            sa.getJSON().roomsData.join["!foo:bar"].ephemeral.events[0],
        ).toEqual({
            type: "m.receipt",
            room_id: "!foo:bar",
            content: {
                "$event1:localhost": {
                    "m.read": {
                        "@alice:localhost": { ts: 1 },
                    },
                },
                "$event2:localhost": {
                    "m.read": {
                        "@bob:localhost": { ts: 2 },
                        "@charlie:localhost": { ts: 3 },
                    },
                },
            },
        });
    });
});

function syncSkeleton(joinObj) {
    joinObj = joinObj || {};
    return {
        next_batch: "abc",
        rooms: {
            join: {
                "!foo:bar": joinObj,
            },
        },
    };
}

function msg(localpart, text) {
    return {
        content: {
            body: text,
        },
        origin_server_ts: 123456789,
        sender: "@" + localpart + ":localhost",
        type: "m.room.message",
    };
}

function member(localpart, membership) {
    return {
        content: {
            membership: membership,
        },
        origin_server_ts: 123456789,
        state_key: "@" + localpart + ":localhost",
        sender: "@" + localpart + ":localhost",
        type: "m.room.member",
    };
}
