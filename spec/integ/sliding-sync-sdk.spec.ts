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

import { SlidingSync, SlidingSyncEvent, MSC3575RoomData } from "../../src/sliding-sync";
import { TestClient } from "../TestClient";
import { IRoomEvent, IStateEvent } from "../../src/sync-accumulator";
import { MatrixClient, MatrixEvent, NotificationCountType, JoinRule } from "../../src";
import { SlidingSyncSdk } from "../../src/sliding-sync-sdk";

describe("SlidingSyncSdk", () => {
    let client: MatrixClient = null;
    let httpBackend: MockHttpBackend = null;
    let sdk: SlidingSyncSdk = null;
    let mockSlidingSync: SlidingSync = null;
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
    const mkOwnStateEvent = (evType: string, content: object, stateKey?: string): IStateEvent => {
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
    const setupClient = () => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        httpBackend.when("GET", "/_matrix/client/r0/pushrules").respond(200, {});
        client = testClient.client;
        mockSlidingSync = mockifySlidingSync(new SlidingSync("", [], {}, client, 0));
        sdk = new SlidingSyncSdk(mockSlidingSync, client, {});
    };

    // tear down client/httpBackend globals
    const teardownClient = () => {
        client.stopClient();
        return httpBackend.stop();
    };

    describe("sync/stop", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);
        it("can sync()", async () => {
            const hasSynced = sdk.sync();
            await httpBackend.flushAllExpected();
            await hasSynced;
            expect(mockSlidingSync.start).toBeCalled();
        });
        it("can stop()", async () => {
            sdk.stop();
            expect(mockSlidingSync.stop).toBeCalled();
        });
    });

    describe("rooms", () => {
        beforeAll(setupClient);
        afterAll(teardownClient);

        describe("initial", () => {
            beforeAll(async () => {
                const hasSynced = sdk.sync();
                await httpBackend.flushAllExpected();
                await hasSynced;
            });
            // inject some rooms with different fields set.
            // All rooms are new so they all have initial: true
            const roomA = "!a_state_and_timeline:localhost";
            const roomB = "!b_timeline_only:localhost";
            const roomC = "!c_with_highlight_count:localhost";
            const roomD = "!d_with_notif_count:localhost";
            const roomE = "!e_with_invite:localhost";
            const data: Record<string, MSC3575RoomData> = {
                [roomA]: {
                    name: "A",
                    required_state: [
                        mkOwnStateEvent("m.room.create", { creator: selfUserId }, ""),
                        mkOwnStateEvent("m.room.member", { membership: "join" }, selfUserId),
                        mkOwnStateEvent("m.room.power_levels", { users: { [selfUserId]: 100 } }, ""),
                    ],
                    timeline: [
                        mkOwnEvent("m.room.message", { body: "hello A" }),
                        mkOwnEvent("m.room.message", { body: "world A" }),
                    ],
                    initial: true,
                },
                [roomB]: {
                    name: "B",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent("m.room.create", { creator: selfUserId }, ""),
                        mkOwnStateEvent("m.room.member", { membership: "join" }, selfUserId),
                        mkOwnStateEvent("m.room.power_levels", { users: { [selfUserId]: 100 } }, ""),
                        mkOwnEvent("m.room.message", { body: "hello B" }),
                        mkOwnEvent("m.room.message", { body: "world B" }),

                    ],
                    initial: true,
                },
                [roomC]: {
                    name: "C",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent("m.room.create", { creator: selfUserId }, ""),
                        mkOwnStateEvent("m.room.member", { membership: "join" }, selfUserId),
                        mkOwnStateEvent("m.room.power_levels", { users: { [selfUserId]: 100 } }, ""),
                        mkOwnEvent("m.room.message", { body: "hello C" }),
                        mkOwnEvent("m.room.message", { body: "world C" }),
                    ],
                    highlight_count: 5,
                    initial: true,
                },
                [roomD]: {
                    name: "D",
                    required_state: [],
                    timeline: [
                        mkOwnStateEvent("m.room.create", { creator: selfUserId }, ""),
                        mkOwnStateEvent("m.room.member", { membership: "join" }, selfUserId),
                        mkOwnStateEvent("m.room.power_levels", { users: { [selfUserId]: 100 } }, ""),
                        mkOwnEvent("m.room.message", { body: "hello D" }),
                        mkOwnEvent("m.room.message", { body: "world D" }),
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
                            type: "m.room.member",
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
            };

            it("can be created with required_state and timeline", () => {
                mockSlidingSync.emit(SlidingSyncEvent.RoomData, roomA, data[roomA]);
                const gotRoom = client.getRoom(roomA);
                expect(gotRoom).toBeDefined();
                expect(gotRoom.name).toEqual(data[roomA].name);
                expect(gotRoom.getMyMembership()).toEqual("join");
                assertTimelineEvents(gotRoom.getLiveTimeline().getEvents().slice(-2), data[roomA].timeline);
            });

            it("can be created with timeline only", () => {
                mockSlidingSync.emit(SlidingSyncEvent.RoomData, roomB, data[roomB]);
                const gotRoom = client.getRoom(roomB);
                expect(gotRoom).toBeDefined();
                expect(gotRoom.name).toEqual(data[roomB].name);
                expect(gotRoom.getMyMembership()).toEqual("join");
                assertTimelineEvents(gotRoom.getLiveTimeline().getEvents().slice(-5), data[roomB].timeline);
            });

            it("can be created with a highlight_count", () => {
                mockSlidingSync.emit(SlidingSyncEvent.RoomData, roomC, data[roomC]);
                const gotRoom = client.getRoom(roomC);
                expect(gotRoom).toBeDefined();
                expect(
                    gotRoom.getUnreadNotificationCount(NotificationCountType.Highlight),
                ).toEqual(data[roomC].highlight_count);
            });

            it("can be created with a notification_count", () => {
                mockSlidingSync.emit(SlidingSyncEvent.RoomData, roomD, data[roomD]);
                const gotRoom = client.getRoom(roomD);
                expect(gotRoom).toBeDefined();
                expect(
                    gotRoom.getUnreadNotificationCount(NotificationCountType.Total),
                ).toEqual(data[roomD].notification_count);
            });

            it("can be created with invite_state", () => {
                mockSlidingSync.emit(SlidingSyncEvent.RoomData, roomE, data[roomE]);
                const gotRoom = client.getRoom(roomE);
                expect(gotRoom).toBeDefined();
                expect(gotRoom.getMyMembership()).toEqual("invite");
                expect(gotRoom.currentState.getJoinRule()).toEqual(JoinRule.Invite);
            });
        });

        it("can update existing rooms", async () => {

        });
    });

    describe("ExtensionE2EE", () => {
    });
    describe("ExtensionAccountData", () => {
    });
    describe("ExtensionToDevice", () => {
    });
});
