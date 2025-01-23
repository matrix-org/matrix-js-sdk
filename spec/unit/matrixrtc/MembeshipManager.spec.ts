/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { MatrixClient, Room } from "../../../src";
import { MatrixRTCSession } from "../../../src/matrixrtc/MatrixRTCSession";
import { LegacyMembershipManager } from "../../../src/matrixrtc/MembershipManager";
import { makeMockRoom, membershipTemplate } from "./mocks";

describe("MatrixRTCSession", () => {
    describe("LegacyMembershipManager", () => {
        let client: MatrixClient;
        let sess: MatrixRTCSession | undefined;
        let room: Room;

        beforeEach(() => {
            client = new MatrixClient({ baseUrl: "base_url" });
            client.getUserId = jest.fn().mockReturnValue("@alice:example.org");
            client.getDeviceId = jest.fn().mockReturnValue("AAAAAAA");
            room = makeMockRoom(membershipTemplate);
        });

        afterEach(() => {
            client.stopClient();
            client.matrixRTC.stop();
            if (sess) sess.stop();
            sess = undefined;
        });

        describe("isJoined()", () => {
            it("defaults to false", () => {
                const manager = new LegacyMembershipManager({}, room, client, () => undefined);
                expect(manager.isJoined()).toEqual(false);
            });

            it("returns true after join()", () => {
                const manager = new LegacyMembershipManager({}, room, client, () => undefined);
                manager.join([]);
                expect(manager.isJoined()).toEqual(true);
            });
        });

        describe("join()", () => {
            describe("sends a membership event", () => {
                it("sends a membership event with session payload when joining a call", async () => {});

                it("does not prefix the state key with _ for rooms that support user-owned state events", async () => {});

                // const realSetTimeout = setTimeout;
                // jest.useFakeTimers();
                // sess!.joinRoomSession([mockFocus], mockFocus);
                // await Promise.race([sentStateEvent, new Promise((resolve) => realSetTimeout(resolve, 500))]);
                // expect(client.sendStateEvent).toHaveBeenCalledWith(
                //     mockRoom!.roomId,
                //     EventType.GroupCallMemberPrefix,
                //     {
                //         application: "m.call",
                //         scope: "m.room",
                //         call_id: "",
                //         device_id: "AAAAAAA",
                //         expires: DEFAULT_EXPIRE_DURATION,
                //         foci_preferred: [mockFocus],
                //         focus_active: {
                //             focus_selection: "oldest_membership",
                //             type: "livekit",
                //         },
                //     },
                //     "_@alice:example.org_AAAAAAA",
                // );
                // await Promise.race([sentDelayedState, new Promise((resolve) => realSetTimeout(resolve, 500))]);
                // // Because we actually want to send the state
                // expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                // // For checking if the delayed event is still there or got removed while sending the state.
                // expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(1);
                // // For scheduling the delayed event
                // expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
                // // This returns no error so we do not check if we reschedule the event again. this is done in another test.

                // jest.useRealTimers();
            });

            describe("schedules a delayed leave event if server supports it", () => {});

            it("uses membershipExpiryTimeout from config", async () => {
                // const realSetTimeout = setTimeout;
                // jest.useFakeTimers();
                // sess!.joinRoomSession([mockFocus], mockFocus, { membershipExpiryTimeout: 60000 });
                // await Promise.race([sentStateEvent, new Promise((resolve) => realSetTimeout(resolve, 500))]);
                // expect(client.sendStateEvent).toHaveBeenCalledWith(
                //     mockRoom!.roomId,
                //     EventType.GroupCallMemberPrefix,
                //     {
                //         application: "m.call",
                //         scope: "m.room",
                //         call_id: "",
                //         device_id: "AAAAAAA",
                //         expires: 60000,
                //         foci_preferred: [mockFocus],
                //         focus_active: {
                //             focus_selection: "oldest_membership",
                //             type: "livekit",
                //         },
                //     },
                //     "_@alice:example.org_AAAAAAA",
                // );
                // await Promise.race([sentDelayedState, new Promise((resolve) => realSetTimeout(resolve, 500))]);
                // expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
                // jest.useRealTimers();
            });

            it("does nothing if join called when already joined", async () => {
                // const realSetTimeout = setTimeout;
                // jest.useFakeTimers();
                // sess!.joinRoomSession([mockFocus], mockFocus);
                // await Promise.race([sentStateEvent, new Promise((resolve) => realSetTimeout(resolve, 500))]);
                // expect(client.sendStateEvent).toHaveBeenCalledWith(
                //     mockRoom!.roomId,
                //     EventType.GroupCallMemberPrefix,
                //     {
                //         application: "m.call",
                //         scope: "m.room",
                //         call_id: "",
                //         device_id: "AAAAAAA",
                //         expires: DEFAULT_EXPIRE_DURATION,
                //         foci_preferred: [mockFocus],
                //         focus_active: {
                //             focus_selection: "oldest_membership",
                //             type: "livekit",
                //         },
                //     },
                //     "_@alice:example.org_AAAAAAA",
                // );
                // await Promise.race([sentDelayedState, new Promise((resolve) => realSetTimeout(resolve, 500))]);
                // expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                // jest.useRealTimers();
            });
        });

        describe("leave()", () => {
            it("does nothing if not joined", () => {
                // const manager = new LegacyMembershipManager({}, room, client, () => undefined);
                // manager.leave();
            });
        });

        describe("getOldestMembership", () => {
            it("returns the oldest membership event", () => {
                jest.useFakeTimers();
                jest.setSystemTime(4000);
                const mockRoom = makeMockRoom([
                    Object.assign({}, membershipTemplate, { device_id: "foo", created_ts: 3000 }),
                    Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                    Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
                ]);

                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
                expect(sess.getOldestMembership()!.deviceId).toEqual("old");
                jest.useRealTimers();
            });
        });

        describe("getsActiveFocus", () => {
            const firstPreferredFocus = {
                type: "livekit",
                livekit_service_url: "https://active.url",
                livekit_alias: "!active:active.url",
            };
            it("gets the correct active focus with oldest_membership", () => {
                // jest.useFakeTimers();
                // jest.setSystemTime(3000);
                // const mockRoom = makeMockRoom([
                //     Object.assign({}, membershipTemplate, {
                //         device_id: "foo",
                //         created_ts: 500,
                //         foci_preferred: [firstPreferredFocus],
                //     }),
                //     Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                //     Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
                // ]);
                // sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
                // sess.joinRoomSession([{ type: "livekit", livekit_service_url: "htts://test.org" }], {
                //     type: "livekit",
                //     focus_selection: "oldest_membership",
                // });
                // expect(sess.getActiveFocus()).toBe(firstPreferredFocus);
                // jest.useRealTimers();
            });
            it("does not provide focus if the selection method is unknown", () => {
                // const mockRoom = makeMockRoom([
                //     Object.assign({}, membershipTemplate, {
                //         device_id: "foo",
                //         created_ts: 500,
                //         foci_preferred: [firstPreferredFocus],
                //     }),
                //     Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                //     Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
                // ]);
                // sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
                // sess.joinRoomSession([{ type: "livekit", livekit_service_url: "htts://test.org" }], {
                //     type: "livekit",
                //     focus_selection: "unknown",
                // });
                // expect(sess.getActiveFocus()).toBe(undefined);
            });
        });

        describe("onRTCSessionMemberUpdate()", () => {
            it("does nothing if not joined", () => {});
            it("does nothing if own membership still present", () => {});
            it("recreates membership if it is missing", () => {});
        });

        // TODO: not sure about this name
        describe("background timers", () => {
            it("sends keep-alive for delayed leave event where supported", () => {});

            it("extends `expires` when call still active", () => {});

            it("does not send more than once per `membershipKeepAlivePeriod`", () => {});
        });

        describe("server error handling", () => {
            describe("retries sending delayed leave event", () => {
                it("sends it if delayed leave event is still valid at time of retry", () => {});
                it("abandons it if delayed leave event is no longer valid at time of retry", () => {
                    // I think this will break on LegacyMembershipManager
                });
            });

            describe("retries sending membership event", () => {
                it("sends it if still joined at time of retry", () => {});
                it("abandons it if call no longer joined at time of retry", () => {});
            });
        });
    });
});
