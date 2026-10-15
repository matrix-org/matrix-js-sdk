/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { type MatrixClient, MatrixEvent, EventType, RoomStateEvent } from "../../../src";
import { Room } from "../../../src/models/room";
import { UNSIGNED_STABLE_ID_FIELD } from "../../../src/models/event";
import { KnownMembership } from "../../../src/@types/membership";

/**
 * Tests for stable IDs (MSC4428) as they are used by rooms with member keys (MSC4430):
 * room members are keyed by an opaque stable ID, and their user ID is an attribute
 * resolved through the room's `member_info` mapping.
 *
 * The wire shapes here were captured from a Synapse serving a member key room.
 */

const ROOM_ID = "!bVHaIKXXrLPGMXxGHVPyRbkJwqTTRzJMKhHQlLFtWAE";
const ALICE_KEY = "@euEdVN1DimRHWErEnH3KVVNXduH3SiqMW7yMfO7qVOg";
const BOB_KEY = "@oG9tWFba7ul1sREui6GTYvJDW8qkoTAxMNWsIexIu-g";
const CAROL_KEY = "@g--WRBBVRi3AVLhJEdCnK0XR8sbXDGbL2vOjMPlKZ1A";
const ALICE = "@alice:localhost";
const BOB = "@bob:localhost";
const CAROL = "@carol:localhost";

function createClient(): MatrixClient {
    return {
        getUserId: vi.fn().mockReturnValue(ALICE),
        getSafeUserId: vi.fn().mockReturnValue(ALICE),
        getEventMapper: vi.fn().mockReturnValue((e: any) => new MatrixEvent(e)),
        isInitialSyncComplete: vi.fn().mockReturnValue(true),
        supportsThreads: vi.fn().mockReturnValue(false),
        canSupport: { get: vi.fn() },
        store: { getSyncToken: vi.fn().mockReturnValue(null) },
    } as unknown as MatrixClient;
}

/** A client-format membership event as a member key room serves it. */
function memberEvent(
    stableId: string,
    membership: string,
    opts: { displayname?: string; localpart?: string; sender?: string } = {},
): MatrixEvent {
    const sender = opts.sender ?? stableId;
    return new MatrixEvent({
        type: EventType.RoomMember,
        sender,
        state_key: stableId,
        room_id: ROOM_ID,
        event_id: "$member-" + stableId + "-" + membership,
        origin_server_ts: 1792049255917,
        content: {
            membership,
            displayname: opts.displayname,
            localpart: opts.localpart,
            domain: "localhost",
        },
        unsigned: { [UNSIGNED_STABLE_ID_FIELD]: sender },
    });
}

function createEvent(stableId: string): MatrixEvent {
    return new MatrixEvent({
        type: EventType.RoomCreate,
        sender: stableId,
        state_key: "",
        room_id: ROOM_ID,
        event_id: "$create",
        content: { room_version: "org.matrix.msc4430.12" },
        unsigned: { [UNSIGNED_STABLE_ID_FIELD]: stableId },
    });
}

function message(stableId: string, body: string): MatrixEvent {
    return new MatrixEvent({
        type: EventType.RoomMessage,
        sender: stableId,
        room_id: ROOM_ID,
        event_id: "$msg-" + body,
        origin_server_ts: 1792049255917,
        content: { msgtype: "m.text", body },
        unsigned: { [UNSIGNED_STABLE_ID_FIELD]: stableId },
    });
}

/** A room with member keys, with alice (us) and bob joined. */
function memberKeyRoom(): Room {
    const room = new Room(ROOM_ID, createClient(), ALICE);
    room.applyMemberInfo({ [ALICE_KEY]: { user_id: ALICE }, [BOB_KEY]: { user_id: BOB } }, true);
    room.currentState.setStateEvents([
        createEvent(ALICE_KEY),
        memberEvent(ALICE_KEY, KnownMembership.Join, { displayname: "alice", localpart: "alice" }),
        memberEvent(BOB_KEY, KnownMembership.Join, { displayname: "bob", localpart: "bob" }),
    ]);
    return room;
}

/** The same room on an ordinary room version, where no mapping is served at all. */
function legacyRoom(): Room {
    const room = new Room(ROOM_ID, createClient(), ALICE);
    room.currentState.setStateEvents([
        memberEvent(ALICE, KnownMembership.Join, { displayname: "alice" }),
        memberEvent(BOB, KnownMembership.Join, { displayname: "bob" }),
    ]);
    return room;
}

describe("MatrixEvent.getStableId", () => {
    it("reads unsigned.stable_id", () => {
        expect(message(BOB_KEY, "hi").getStableId()).toEqual(BOB_KEY);
    });

    it("falls back to the sender when the server does not implement MSC4428", () => {
        const event = new MatrixEvent({ type: EventType.RoomMessage, sender: BOB, content: {} });
        expect(event.getStableId()).toEqual(BOB);
    });

    it("is undefined when there is neither", () => {
        expect(new MatrixEvent({ type: EventType.RoomMessage, content: {} }).getStableId()).toBeUndefined();
    });
});

describe("Room member info", () => {
    it("resolves stable IDs in both directions", () => {
        const room = memberKeyRoom();

        expect(room.getUserIdForStableId(BOB_KEY)).toEqual(BOB);
        expect(room.getStableIdForUserId(BOB)).toEqual(BOB_KEY);
    });

    it("reports no mapping for an unknown stable ID", () => {
        expect(memberKeyRoom().getUserIdForStableId(CAROL_KEY)).toBeUndefined();
    });

    it("merges an incremental delta into the mapping", () => {
        const room = memberKeyRoom();

        // An incremental sync carries only the entries which changed.
        room.applyMemberInfo({ [CAROL_KEY]: { user_id: CAROL } }, false);

        expect(room.getUserIdForStableId(CAROL_KEY)).toEqual(CAROL);
        expect(room.getUserIdForStableId(BOB_KEY)).toEqual(BOB);
    });

    it("ignores an incremental sync which carries no mapping at all", () => {
        const room = memberKeyRoom();

        room.applyMemberInfo(undefined, false);

        expect(room.getUserIdForStableId(BOB_KEY)).toEqual(BOB);
    });

    it("replaces the mapping on an initial sync", () => {
        const room = memberKeyRoom();

        room.applyMemberInfo({ [ALICE_KEY]: { user_id: ALICE } }, true);

        expect(room.getUserIdForStableId(BOB_KEY)).toBeUndefined();
    });

    describe("in a room without member keys", () => {
        it("has no mapping, so a stable ID is its own user ID", () => {
            const room = legacyRoom();

            expect(room.getUserIdForStableId(BOB)).toBeUndefined();
            expect(room.getStableIdForUserId(BOB)).toBeUndefined();
            expect(room.getMember(BOB)!.userId).toEqual(BOB);
            expect(room.getMember(BOB)!.stableId).toEqual(BOB);
        });

        it("reports our own stable ID as our user ID", () => {
            expect(legacyRoom().getMyStableId()).toEqual(ALICE);
        });
    });
});

describe("RoomState keyed by stable ID", () => {
    it("keys members by their stable ID", () => {
        const room = memberKeyRoom();

        expect(Object.keys(room.currentState.members).sort()).toEqual([ALICE_KEY, BOB_KEY].sort());
    });

    it("resolves a member's user ID through the mapping", () => {
        const bob = memberKeyRoom().getMember(BOB_KEY)!;

        expect(bob.stableId).toEqual(BOB_KEY);
        expect(bob.userId).toEqual(BOB);
        expect(bob.resolvedUserId).toEqual(BOB);
        expect(bob.isUnresolved).toBe(false);
    });

    it("finds a member by their user ID as well as their stable ID", () => {
        const room = memberKeyRoom();

        expect(room.getMember(BOB)).toBe(room.getMember(BOB_KEY));
    });

    it("returns null for a user who is not a member", () => {
        expect(memberKeyRoom().getMember(CAROL)).toBeNull();
    });

    it("attaches an event to the member who sent it", () => {
        const room = memberKeyRoom();
        const event = message(BOB_KEY, "hi");

        event.setMetadata(room.currentState, false);

        expect(event.sender!.stableId).toEqual(BOB_KEY);
        expect(event.sender!.userId).toEqual(BOB);
    });

    it("knows which member is us", () => {
        const room = memberKeyRoom();

        expect(room.getMyStableId()).toEqual(ALICE_KEY);
        expect(room.getMember(room.getMyStableId())!.userId).toEqual(ALICE);
    });

    it("falls back to our user ID before the mapping arrives", () => {
        const room = new Room(ROOM_ID, createClient(), ALICE);

        // Nothing has been synced yet, so we do not know our key in this room.
        expect(room.getMyStableId()).toEqual(ALICE);
    });

    it("finds our own membership through our user ID", () => {
        const room = memberKeyRoom();

        expect(room.getMember(ALICE)!.membership).toEqual(KnownMembership.Join);
    });
});

describe("RoomMember names", () => {
    it("does not use a member key as a display name", () => {
        const room = memberKeyRoom();

        expect(room.getMember(BOB_KEY)!.name).toEqual("bob");
    });

    it("falls back to the resolved user ID when a member has no display name", () => {
        const room = memberKeyRoom();

        room.currentState.setStateEvents([memberEvent(CAROL_KEY, KnownMembership.Join)]);
        room.applyMemberInfo({ [CAROL_KEY]: { user_id: CAROL } }, false);

        expect(room.getMember(CAROL_KEY)!.name).toEqual(CAROL);
    });

    it("recalculates the name when the mapping arrives after the member event", () => {
        const room = memberKeyRoom();

        // Carol's member event arrives with no display name and no mapping yet, so all
        // we can show is her key.
        room.currentState.setStateEvents([memberEvent(CAROL_KEY, KnownMembership.Join)]);
        expect(room.getMember(CAROL_KEY)!.name).toEqual(CAROL_KEY);

        const onMembers = vi.fn();
        room.currentState.on(RoomStateEvent.Members, onMembers);

        room.applyMemberInfo({ [CAROL_KEY]: { user_id: CAROL } }, false);

        expect(room.getMember(CAROL_KEY)!.name).toEqual(CAROL);
        expect(onMembers).toHaveBeenCalled();
    });

    it("disambiguates two members who share a display name", () => {
        const room = memberKeyRoom();

        room.currentState.setStateEvents([memberEvent(CAROL_KEY, KnownMembership.Join, { displayname: "bob" })]);
        room.applyMemberInfo({ [CAROL_KEY]: { user_id: CAROL } }, false);

        // Both are disambiguated, and by user ID rather than by member key.
        expect(room.getMember(BOB_KEY)!.name).toEqual(`bob (${BOB})`);
        expect(room.getMember(CAROL_KEY)!.name).toEqual(`bob (${CAROL})`);
    });
});

describe("power levels in a member key room", () => {
    it("reads users by stable ID", () => {
        const room = memberKeyRoom();

        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomPowerLevels,
                sender: ALICE_KEY,
                state_key: "",
                room_id: ROOM_ID,
                event_id: "$pl",
                content: { users: { [BOB_KEY]: 50 }, users_default: 0 },
                unsigned: { [UNSIGNED_STABLE_ID_FIELD]: ALICE_KEY },
            }),
        ]);

        expect(room.getMember(BOB_KEY)!.powerLevel).toEqual(50);
    });

    it("gives the creator infinite power, identified by their key", () => {
        const room = memberKeyRoom();

        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomPowerLevels,
                sender: ALICE_KEY,
                state_key: "",
                room_id: ROOM_ID,
                event_id: "$pl",
                content: { users: {}, users_default: 0 },
                unsigned: { [UNSIGNED_STABLE_ID_FIELD]: ALICE_KEY },
            }),
        ]);

        expect(room.getMember(ALICE_KEY)!.powerLevel).toEqual(Infinity);
    });
});

describe("lazy-loaded members", () => {
    it("learns the mapping from /members", async () => {
        const client = createClient();
        const room = new Room(ROOM_ID, client, ALICE, { lazyLoadMembers: true });
        (client as any).store.getOutOfBandMembers = vi.fn().mockResolvedValue(null);
        (client as any).members = vi.fn().mockResolvedValue({
            "chunk": [
                memberEvent(BOB_KEY, KnownMembership.Join, { displayname: "bob" }).event,
                memberEvent(CAROL_KEY, KnownMembership.Join, { displayname: "carol" }).event,
            ],
            "org.matrix.msc4428.member_info": {
                [BOB_KEY]: { user_id: BOB },
                [CAROL_KEY]: { user_id: CAROL },
            },
        });
        (client as any).store.setOutOfBandMembers = vi.fn().mockResolvedValue(undefined);

        await room.loadMembersIfNeeded();

        expect(room.getUserIdForStableId(CAROL_KEY)).toEqual(CAROL);
        expect(room.getMember(CAROL)!.stableId).toEqual(CAROL_KEY);
        expect(room.getMember(CAROL_KEY)!.name).toEqual("carol");
    });

    it("leaves the mapping alone when the server does not send one", async () => {
        const client = createClient();
        const room = new Room(ROOM_ID, client, ALICE, { lazyLoadMembers: true });
        (client as any).store.getOutOfBandMembers = vi.fn().mockResolvedValue(null);
        (client as any).members = vi.fn().mockResolvedValue({
            chunk: [memberEvent(BOB, KnownMembership.Join, { displayname: "bob" }).event],
        });
        (client as any).store.setOutOfBandMembers = vi.fn().mockResolvedValue(undefined);

        await room.loadMembersIfNeeded();

        expect(room.getMember(BOB)!.userId).toEqual(BOB);
        expect(room.getMember(BOB)!.stableId).toEqual(BOB);
    });
});

describe("Room.resolveMemberIdentity", () => {
    it("accepts a stable ID", () => {
        expect(memberKeyRoom().resolveMemberIdentity(BOB_KEY)).toEqual({ stableId: BOB_KEY, userId: BOB });
    });

    it("accepts a user ID", () => {
        expect(memberKeyRoom().resolveMemberIdentity(BOB)).toEqual({ stableId: BOB_KEY, userId: BOB });
    });

    it("passes through an unknown ID, as in a room without member keys", () => {
        expect(legacyRoom().resolveMemberIdentity(BOB)).toEqual({ stableId: BOB, userId: undefined });
    });
});
