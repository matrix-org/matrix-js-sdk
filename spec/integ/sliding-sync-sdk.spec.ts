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

// eslint-disable-next-line no-restricted-imports
import MockHttpBackend from "matrix-mock-request";
import { fail } from "assert";

import { SlidingSync, SlidingSyncEvent, MSC3575RoomData, SlidingSyncState, Extension } from "../../src/sliding-sync";
import { TestClient } from "../TestClient";
import { IRoomEvent, IStateEvent } from "../../src/sync-accumulator";
import {
    MatrixClient, MatrixEvent, NotificationCountType, JoinRule, MatrixError,
    EventType, IPushRules, PushRuleKind, TweakName, ClientEvent, RoomMemberEvent,
} from "../../src";
import { SlidingSyncSdk } from "../../src/sliding-sync-sdk";
import { SyncState } from "../../src/sync";
import { IStoredClientOpts } from "../../src/client";
import { logger } from "../../src/logger";
import { emitPromise } from "../test-utils/test-utils";

describe("SlidingSyncSdk", () => {
    let client: MatrixClient | undefined;
    let httpBackend: MockHttpBackend | undefined;
    let sdk: SlidingSyncSdk | undefined;
    let mockSlidingSync: SlidingSync | undefined;
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";

    const mockifySlidingSync = (s: SlidingSync): SlidingSync => {
        s.getList = jest.fn();
        s.getListData = jest.fn();
        s.getRoomSubscriptions = jest.fn();
        s.listLength = jest.fn();
        s.modifyRoomSubscriptionInfo = jest.fn();
        s.modifyRoomSubscriptions = jest.fn();
        s.registerExtension = jest.fn();
        s.setList = jest.fn();
        s.setListRanges = jest.fn();
        s.start = jest.fn();
        s.stop = jest.fn();
        s.resend = jest.fn();
        return s;
    };

    // shorthand way to make events without filling in all the fields
    let eventIdCounter = 0;
    const mkOwnEvent = (evType: string, content: object): IRoomEvent => {
        eventIdCounter++;
        return {
            type: evType,
            content: content,
            sender: selfUserId,
            origin_server_ts: Date.now(),
            event_id: "$" + eventIdCounter,
        };
    };
    const mkOwnStateEvent = (evType: string, content: object, stateKey = ''): IStateEvent => {
        eventIdCounter++;
        return {
            type: evType,
            state_key: stateKey,
            content: content,
            sender: selfUserId,
            origin_server_ts: Date.now(),
            event_id: "$" + eventIdCounter,
        };
    };
    const assertTimelineEvents = (got: MatrixEvent[], want: IRoomEvent[]): void => {
        expect(got.length).toEqual(want.length);
        got.forEach((m, i) => {
            expect(m.getType()).toEqual(want[i].type);
            expect(m.getSender()).toEqual(want[i].sender);
            expect(m.getId()).toEqual(want[i].event_id);
            expect(m.getContent()).toEqual(want[i].content);
            expect(m.getTs()).toEqual(want[i].origin_server_ts);
            if (want[i].unsigned) {
                expect(m.getUnsigned()).toEqual(want[i].unsigned);
            }
            const maybeStateEvent = want[i] as IStateEvent;
            if (maybeStateEvent.state_key) {
                expect(m.getStateKey()).toEqual(maybeStateEvent.state_key);
            }
        });
    };

    // assign client/httpBackend globals
    const setupClient = async (testOpts?: Partial<IStoredClientOpts&{withCrypto: boolean}>) => {
        testOpts = testOpts || {};
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        client = testClient.client;
        mockSlidingSync = mockifySlidingSync(new SlidingSync("", [], {}, client, 0));
        if (testOpts.withCrypto) {
            httpBackend!.when("GET", "/room_keys/version").respond(404, {});
            await client!.initCrypto();
            testOpts.crypto = client!.crypto;
        }
        httpBackend!.when("GET", "/_matrix/client/r0/pushrules").respond(200, {});
        sdk = new SlidingSyncSdk(mockSlidingSync, client, testOpts);
    };

    // tear down client/httpBackend globals
    const teardownClient = () => {
        client!.stopClient();
        return httpBackend!.stop();
    };

    // find an extension on a SlidingSyncSdk instance
    const findExtension = (name: string): Extension => {
        expect(mockSlidingSync!.registerExtension).toHaveBeenCalled();
        const mockFn = mockSlidingSync!.registerExtension as jest.Mock;
        // find the extension
        for (let i = 0; i < mockFn.mock.calls.length; i++) {
            const calledExtension = mockFn.mock.calls[i][0] as Extension;
            if (calledExtension && calledExtension.name() === name) {
                return calledExtension;
            }
        }
        fail("cannot find extension " + name);
    };

    describe("sync/stop", () => {
        beforeAll(async () => {
            await setupClient();
        });
        afterAll(teardownClient);
        it("can sync()", async () => {
            const hasSynced = sdk!.sync();
            await httpBackend!.flushAllExpected();
            await hasSynced;
            expect(mockSlidingSync!.start).toBeCalled();
        });
        it("can stop()", async () => {
            sdk!.stop();
            expect(mockSlidingSync!.stop).toBeCalled();
        });
    });

    describe("rooms", () => {
        beforeAll(async () => {
            await setupClient();
        });
        afterAll(teardownClient);

        describe("initial", () => {
            beforeAll(async () => {
                const hasSynced = sdk!.sync();
                await httpBackend!.flushAllExpected();
                await hasSynced;
            });
            // inject some rooms with different fields set.
            // All rooms are new so they all have initial: true
            const roomA = "!a_state_and_timeline:localhost";
            const roomB = "!b_timeline_only:localhost";
            const roomC = "!c_with_highlight_count:localhost";
            const roomD = "!d_with_notif_count:localhost";
            const roomE = "!e_with_invite:localhost";
            const roomF = "!f_calc_room_name:localhost";
            const roomG = "!g_join_invite_counts:localhost";
            const data: Record<string, MSC3575RoomData> = {
                [roomA]: {
                    name: "A",
                    required_state: [
                        mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                        mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                        mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                        mkOwnStateEvent(EventType.RoomName, { name: "A" }, ""),
                    ],
                    timeline: [
                        mkOwnEvent(EventType.RoomMessage, { body: "hello A" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "world A" }),
                    ],
                    initial: true,
                },
                [roomB]: {
                    name: "B",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                        mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                        mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                        mkOwnEvent(EventType.RoomMessage, { body: "hello B" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "world B" }),

                    ],
                    initial: true,
                },
                [roomC]: {
                    name: "C",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                        mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                        mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                        mkOwnEvent(EventType.RoomMessage, { body: "hello C" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "world C" }),
                    ],
                    highlight_count: 5,
                    initial: true,
                },
                [roomD]: {
                    name: "D",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                        mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                        mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                        mkOwnEvent(EventType.RoomMessage, { body: "hello D" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "world D" }),
                    ],
                    notification_count: 5,
                    initial: true,
                },
                [roomE]: {
                    name: "E",
                    required_state: [],
                    timeline: [],
                    invite_state: [
                        {
                            type: EventType.RoomMember,
                            content: { membership: "invite" },
                            state_key: selfUserId,
                            sender: "@bob:localhost",
                            event_id: "$room_e_invite",
                            origin_server_ts: 123456,
                        },
                        {
                            type: "m.room.join_rules",
                            content: { join_rule: "invite" },
                            state_key: "",
                            sender: "@bob:localhost",
                            event_id: "$room_e_join_rule",
                            origin_server_ts: 123456,
                        },
                    ],
                    initial: true,
                },
                [roomF]: {
                    name: "#foo:localhost",
                    required_state: [
                        mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                        mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                        mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                        mkOwnStateEvent(EventType.RoomCanonicalAlias, { alias: "#foo:localhost" }, ""),
                        mkOwnStateEvent(EventType.RoomName, { name: "This should be ignored" }, ""),
                    ],
                    timeline: [
                        mkOwnEvent(EventType.RoomMessage, { body: "hello A" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "world A" }),
                    ],
                    initial: true,
                },
                [roomG]: {
                    name: "G",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                        mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                        mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                    ],
                    joined_count: 5,
                    invited_count: 2,
                    initial: true,
                },
            };

            it("can be created with required_state and timeline", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomA, data[roomA]);
                const gotRoom = client!.getRoom(roomA);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(gotRoom.name).toEqual(data[roomA].name);
                expect(gotRoom.getMyMembership()).toEqual("join");
                assertTimelineEvents(gotRoom.getLiveTimeline().getEvents().slice(-2), data[roomA].timeline);
            });

            it("can be created with timeline only", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomB, data[roomB]);
                const gotRoom = client!.getRoom(roomB);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(gotRoom.name).toEqual(data[roomB].name);
                expect(gotRoom.getMyMembership()).toEqual("join");
                assertTimelineEvents(gotRoom.getLiveTimeline().getEvents().slice(-5), data[roomB].timeline);
            });

            it("can be created with a highlight_count", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomC, data[roomC]);
                const gotRoom = client!.getRoom(roomC);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(
                    gotRoom.getUnreadNotificationCount(NotificationCountType.Highlight),
                ).toEqual(data[roomC].highlight_count);
            });

            it("can be created with a notification_count", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomD, data[roomD]);
                const gotRoom = client!.getRoom(roomD);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(
                    gotRoom.getUnreadNotificationCount(NotificationCountType.Total),
                ).toEqual(data[roomD].notification_count);
            });

            it("can be created with an invited/joined_count", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomG, data[roomG]);
                const gotRoom = client!.getRoom(roomG);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(gotRoom.getInvitedMemberCount()).toEqual(data[roomG].invited_count);
                expect(gotRoom.getJoinedMemberCount()).toEqual(data[roomG].joined_count);
            });

            it("can be created with invite_state", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomE, data[roomE]);
                const gotRoom = client!.getRoom(roomE);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(gotRoom.getMyMembership()).toEqual("invite");
                expect(gotRoom.currentState.getJoinRule()).toEqual(JoinRule.Invite);
            });

            it("uses the 'name' field to caluclate the room name", () => {
                mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomF, data[roomF]);
                const gotRoom = client!.getRoom(roomF);
                expect(gotRoom).toBeDefined();
                if (gotRoom == null) { return; }
                expect(
                    gotRoom.name,
                ).toEqual(data[roomF].name);
            });

            describe("updating", () => {
                it("can update with a new timeline event", async () => {
                    const newEvent = mkOwnEvent(EventType.RoomMessage, { body: "new event A" });
                    mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomA, {
                        timeline: [newEvent],
                        required_state: [],
                        name: data[roomA].name,
                    });
                    const gotRoom = client!.getRoom(roomA);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }
                    const newTimeline = data[roomA].timeline;
                    newTimeline.push(newEvent);
                    assertTimelineEvents(gotRoom.getLiveTimeline().getEvents().slice(-3), newTimeline);
                });

                it("can update with a new required_state event", async () => {
                    let gotRoom = client!.getRoom(roomB);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }
                    expect(gotRoom.getJoinRule()).toEqual(JoinRule.Invite); // default
                    mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomB, {
                        required_state: [
                            mkOwnStateEvent("m.room.join_rules", { join_rule: "restricted" }, ""),
                        ],
                        timeline: [],
                        name: data[roomB].name,
                    });
                    gotRoom = client!.getRoom(roomB);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }
                    expect(gotRoom.getJoinRule()).toEqual(JoinRule.Restricted);
                });

                it("can update with a new highlight_count", async () => {
                    mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomC, {
                        name: data[roomC].name,
                        required_state: [],
                        timeline: [],
                        highlight_count: 1,
                    });
                    const gotRoom = client!.getRoom(roomC);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }
                    expect(
                        gotRoom.getUnreadNotificationCount(NotificationCountType.Highlight),
                    ).toEqual(1);
                });

                it("can update with a new notification_count", async () => {
                    mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomD, {
                        name: data[roomD].name,
                        required_state: [],
                        timeline: [],
                        notification_count: 1,
                    });
                    const gotRoom = client!.getRoom(roomD);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }
                    expect(
                        gotRoom.getUnreadNotificationCount(NotificationCountType.Total),
                    ).toEqual(1);
                });

                it("can update with a new joined_count", () => {
                    mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomG, {
                        name: data[roomD].name,
                        required_state: [],
                        timeline: [],
                        joined_count: 1,
                    });
                    const gotRoom = client!.getRoom(roomG);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }
                    expect(gotRoom.getJoinedMemberCount()).toEqual(1);
                });

                // Regression test for a bug which caused the timeline entries to be out-of-order
                // when the same room appears twice with different timeline limits. E.g appears in
                // the list with timeline_limit:1 then appears again as a room subscription with
                // timeline_limit:50
                it("can return history with a larger timeline_limit", async () => {
                    const timeline = data[roomA].timeline;
                    const oldTimeline = [
                        mkOwnEvent(EventType.RoomMessage, { body: "old event A" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "old event B" }),
                        mkOwnEvent(EventType.RoomMessage, { body: "old event C" }),
                        ...timeline,
                    ];
                    mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomA, {
                        timeline: oldTimeline,
                        required_state: [],
                        name: data[roomA].name,
                        initial: true, // e.g requested via room subscription
                    });
                    const gotRoom = client!.getRoom(roomA);
                    expect(gotRoom).toBeDefined();
                    if (gotRoom == null) { return; }

                    logger.log("want:", oldTimeline.map((e) => (e.type + " : " + (e.content || {}).body)));
                    logger.log("got:", gotRoom.getLiveTimeline().getEvents().map(
                        (e) => (e.getType() + " : " + e.getContent().body)),
                    );

                    // we expect the timeline now to be oldTimeline (so the old events are in fact old)
                    assertTimelineEvents(gotRoom.getLiveTimeline().getEvents(), oldTimeline);
                });
            });
        });
    });

    describe("lifecycle", () => {
        beforeAll(async () => {
            await setupClient();
            const hasSynced = sdk!.sync();
            await httpBackend!.flushAllExpected();
            await hasSynced;
        });
        const FAILED_SYNC_ERROR_THRESHOLD = 3; // would be nice to export the const in the actual class...

        it("emits SyncState.Reconnecting when < FAILED_SYNC_ERROR_THRESHOLD & SyncState.Error when over", async () => {
            mockSlidingSync!.emit(
                SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete,
                { pos: "h", lists: [], rooms: {}, extensions: {} },
            );
            expect(sdk!.getSyncState()).toEqual(SyncState.Syncing);

            mockSlidingSync!.emit(
                SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new Error("generic"),
            );
            expect(sdk!.getSyncState()).toEqual(SyncState.Reconnecting);

            for (let i = 0; i < FAILED_SYNC_ERROR_THRESHOLD; i++) {
                mockSlidingSync!.emit(
                    SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new Error("generic"),
                );
            }
            expect(sdk!.getSyncState()).toEqual(SyncState.Error);
        });

        it("emits SyncState.Syncing after a previous SyncState.Error", async () => {
            mockSlidingSync!.emit(
                SlidingSyncEvent.Lifecycle,
                SlidingSyncState.Complete,
                { pos: "i", lists: [], rooms: {}, extensions: {} },
            );
            expect(sdk!.getSyncState()).toEqual(SyncState.Syncing);
        });

        it("emits SyncState.Error immediately when receiving M_UNKNOWN_TOKEN and stops syncing", async () => {
            expect(mockSlidingSync!.stop).not.toBeCalled();
            mockSlidingSync!.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new MatrixError({
                errcode: "M_UNKNOWN_TOKEN",
                message: "Oh no your access token is no longer valid",
            }));
            expect(sdk!.getSyncState()).toEqual(SyncState.Error);
            expect(mockSlidingSync!.stop).toBeCalled();
        });
    });

    describe("opts", () => {
        afterEach(teardownClient);
        it("can resolveProfilesToInvites", async () => {
            await setupClient({
                resolveInvitesToProfiles: true,
            });
            const roomId = "!resolveProfilesToInvites:localhost";
            const invitee = "@invitee:localhost";
            const inviteeProfile = {
                avatar_url: "mxc://foobar",
                displayname: "The Invitee",
            };
            httpBackend!.when("GET", "/profile").respond(200, inviteeProfile);
            mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomId, {
                initial: true,
                name: "Room with Invite",
                required_state: [],
                timeline: [
                    mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                    mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                    mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                    mkOwnStateEvent(EventType.RoomMember, { membership: "invite" }, invitee),
                ],
            });
            await httpBackend!.flush("/profile", 1, 1000);
            await emitPromise(client!, RoomMemberEvent.Name);
            const room = client!.getRoom(roomId)!;
            expect(room).toBeDefined();
            const inviteeMember = room.getMember(invitee)!;
            expect(inviteeMember).toBeDefined();
            expect(inviteeMember.getMxcAvatarUrl()).toEqual(inviteeProfile.avatar_url);
            expect(inviteeMember.name).toEqual(inviteeProfile.displayname);
        });
    });

    describe("ExtensionE2EE", () => {
        let ext: Extension;
        beforeAll(async () => {
            await setupClient({
                withCrypto: true,
            });
            const hasSynced = sdk!.sync();
            await httpBackend!.flushAllExpected();
            await hasSynced;
            ext = findExtension("e2ee");
        });
        afterAll(async () => {
            // needed else we do some async operations in the background which can cause Jest to whine:
            // "Cannot log after tests are done. Did you forget to wait for something async in your test?"
            // Attempted to log "Saving device tracking data null"."
            client!.crypto!.stop();
        });
        it("gets enabled on the initial request only", () => {
            expect(ext.onRequest(true)).toEqual({
                enabled: true,
            });
            expect(ext.onRequest(false)).toEqual(undefined);
        });
        it("can update device lists", () => {
            ext.onResponse({
                device_lists: {
                    changed: ["@alice:localhost"],
                    left: ["@bob:localhost"],
                },
            });
            // TODO: more assertions?
        });
        it("can update OTK counts", () => {
            client!.crypto!.updateOneTimeKeyCount = jest.fn();
            ext.onResponse({
                device_one_time_keys_count: {
                    signed_curve25519: 42,
                },
            });
            expect(client!.crypto!.updateOneTimeKeyCount).toHaveBeenCalledWith(42);
            ext.onResponse({
                device_one_time_keys_count: {
                    not_signed_curve25519: 42,
                    // missing field -> default to 0
                },
            });
            expect(client!.crypto!.updateOneTimeKeyCount).toHaveBeenCalledWith(0);
        });
        it("can update fallback keys", () => {
            ext.onResponse({
                device_unused_fallback_key_types: ["signed_curve25519"],
            });
            expect(client!.crypto!.getNeedsNewFallback()).toEqual(false);
            ext.onResponse({
                device_unused_fallback_key_types: ["not_signed_curve25519"],
            });
            expect(client!.crypto!.getNeedsNewFallback()).toEqual(true);
        });
    });
    describe("ExtensionAccountData", () => {
        let ext: Extension;
        beforeAll(async () => {
            await setupClient();
            const hasSynced = sdk!.sync();
            await httpBackend!.flushAllExpected();
            await hasSynced;
            ext = findExtension("account_data");
        });
        it("gets enabled on the initial request only", () => {
            expect(ext.onRequest(true)).toEqual({
                enabled: true,
            });
            expect(ext.onRequest(false)).toEqual(undefined);
        });
        it("processes global account data", async () => {
            const globalType = "global_test";
            const globalContent = {
                info: "here",
            };
            let globalData = client!.getAccountData(globalType);
            expect(globalData).toBeUndefined();
            ext.onResponse({
                global: [
                    {
                        type: globalType,
                        content: globalContent,
                    },
                ],
            });
            globalData = client!.getAccountData(globalType)!;
            expect(globalData).toBeDefined();
            expect(globalData.getContent()).toEqual(globalContent);
        });
        it("processes rooms account data", async () => {
            const roomId = "!room:id";
            mockSlidingSync!.emit(SlidingSyncEvent.RoomData, roomId, {
                name: "Room with account data",
                required_state: [],
                timeline: [
                    mkOwnStateEvent(EventType.RoomCreate, { creator: selfUserId }, ""),
                    mkOwnStateEvent(EventType.RoomMember, { membership: "join" }, selfUserId),
                    mkOwnStateEvent(EventType.RoomPowerLevels, { users: { [selfUserId]: 100 } }, ""),
                    mkOwnEvent(EventType.RoomMessage, { body: "hello" }),

                ],
                initial: true,
            });
            const roomContent = {
                foo: "bar",
            };
            const roomType = "test";
            ext.onResponse({
                rooms: {
                    [roomId]: [
                        {
                            type: roomType,
                            content: roomContent,
                        },
                    ],
                },
            });
            const room = client!.getRoom(roomId)!;
            expect(room).toBeDefined();
            const event = room.getAccountData(roomType)!;
            expect(event).toBeDefined();
            expect(event.getContent()).toEqual(roomContent);
        });
        it("doesn't crash for unknown room account data", async () => {
            const unknownRoomId = "!unknown:id";
            const roomType = "tester";
            ext.onResponse({
                rooms: {
                    [unknownRoomId]: [
                        {
                            type: roomType,
                            content: {
                                foo: "Bar",
                            },
                        },
                    ],
                },
            });
            const room = client!.getRoom(unknownRoomId);
            expect(room).toBeNull();
            expect(client!.getAccountData(roomType)).toBeUndefined();
        });
        it("can update push rules via account data", async () => {
            const roomId = "!foo:bar";
            const pushRulesContent: IPushRules = {
                global: {
                    [PushRuleKind.RoomSpecific]: [{
                        enabled: true,
                        default: true,
                        pattern: "monkey",
                        actions: [
                            {
                                set_tweak: TweakName.Sound,
                                value: "default",
                            },
                        ],
                        rule_id: roomId,
                    }],
                },
            };
            let pushRule = client!.getRoomPushRule("global", roomId);
            expect(pushRule).toBeUndefined();
            ext.onResponse({
                global: [
                    {
                        type: EventType.PushRules,
                        content: pushRulesContent,
                    },
                ],
            });
            pushRule = client!.getRoomPushRule("global", roomId)!;
            expect(pushRule).toEqual(pushRulesContent.global[PushRuleKind.RoomSpecific]![0]);
        });
    });
    describe("ExtensionToDevice", () => {
        let ext: Extension;
        beforeAll(async () => {
            await setupClient();
            const hasSynced = sdk!.sync();
            await httpBackend!.flushAllExpected();
            await hasSynced;
            ext = findExtension("to_device");
        });
        it("gets enabled with a limit on the initial request only", () => {
            const reqJson: any = ext.onRequest(true);
            expect(reqJson.enabled).toEqual(true);
            expect(reqJson.limit).toBeGreaterThan(0);
            expect(reqJson.since).toBeUndefined();
        });
        it("updates the since value", async () => {
            ext.onResponse({
                next_batch: "12345",
                events: [],
            });
            expect(ext.onRequest(false)).toEqual({
                since: "12345",
            });
        });
        it("can handle missing fields", async () => {
            ext.onResponse({
                next_batch: "23456",
                // no events array
            });
        });
        it("emits to-device events on the client", async () => {
            const toDeviceType = "custom_test";
            const toDeviceContent = {
                foo: "bar",
            };
            let called = false;
            client!.once(ClientEvent.ToDeviceEvent, (ev) => {
                expect(ev.getContent()).toEqual(toDeviceContent);
                expect(ev.getType()).toEqual(toDeviceType);
                called = true;
            });
            ext.onResponse({
                next_batch: "34567",
                events: [
                    {
                        type: toDeviceType,
                        content: toDeviceContent,
                    },
                ],
            });
            expect(called).toBe(true);
        });
        it("can cancel key verification requests", async () => {
            const seen: Record<string, boolean> = {};
            client!.on(ClientEvent.ToDeviceEvent, (ev) => {
                const evType = ev.getType();
                expect(seen[evType]).toBeFalsy();
                seen[evType] = true;
                if (evType === "m.key.verification.start" || evType === "m.key.verification.request") {
                    expect(ev.isCancelled()).toEqual(true);
                } else {
                    expect(ev.isCancelled()).toEqual(false);
                }
            });
            ext.onResponse({
                next_batch: "45678",
                events: [
                    // someone tries to verify keys
                    {
                        type: "m.key.verification.start",
                        content: {
                            transaction_id: "a",
                        },
                    },
                    {
                        type: "m.key.verification.request",
                        content: {
                            transaction_id: "a",
                        },
                    },
                    // then gives up
                    {
                        type: "m.key.verification.cancel",
                        content: {
                            transaction_id: "a",
                        },
                    },
                ],
            });
        });
    });
});
