/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { type EventTimeline, EventType, MatrixClient, type Room } from "../../../src";
import { KnownMembership } from "../../../src/@types/membership";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "../../../src/matrixrtc/MatrixRTCSession";
import { makeMockRoom, membershipTemplate, mockRoomState, mockRTCEvent, owmMemberIdentity } from "./mocks";
import { RoomStickyEventsEvent, type StickyMatrixEvent } from "../../../src/models/room-sticky-events.ts";
import { StickyEventMembershipManager } from "../../../src/matrixrtc/MembershipManager.ts";
import { flushPromises } from "../../test-utils/flushPromises.ts";

const mockFocus = { type: "mock" };

const callSession = { id: "", application: "m.call" };

describe("MatrixRTCSession", () => {
    let client: MatrixClient;
    let sess: MatrixRTCSession | undefined;

    beforeEach(() => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.getUserId = jest.fn().mockReturnValue("@alice:example.org");
        client.getDeviceId = jest.fn().mockReturnValue("AAAAAAA");
        client.sendEvent = jest.fn().mockResolvedValue({ event_id: "success" });
        client.decryptEventIfNeeded = jest.fn();
    });

    afterEach(async () => {
        client.stopClient();
        client.matrixRTC.stop();
        if (sess) await sess.stop();
        sess = undefined;
    });

    describe.each([
        {
            listenForStickyEvents: true,
            listenForMemberStateEvents: true,
            testCreateSticky: false,
            createWithDefaults: true, // Create MatrixRTCSession with defaults
        },
        {
            listenForStickyEvents: true,
            listenForMemberStateEvents: true,
            testCreateSticky: false,
        },
        {
            listenForStickyEvents: false,
            listenForMemberStateEvents: true,
            testCreateSticky: false,
        },
        {
            listenForStickyEvents: true,
            listenForMemberStateEvents: true,
            testCreateSticky: true,
        },
        {
            listenForStickyEvents: true,
            listenForMemberStateEvents: false,
            testCreateSticky: true,
        },
    ])(
        "roomsessionForSlot listenForSticky=$listenForStickyEvents listenForMemberStateEvents=$listenForMemberStateEvents testCreateSticky=$testCreateSticky",
        (testConfig) => {
            it(`will ${testConfig.listenForMemberStateEvents ? "" : "NOT"} throw if the room does not have any state stored`, async () => {
                const mockRoom = makeMockRoom([membershipTemplate], testConfig.testCreateSticky);
                mockRoom.getLiveTimeline.mockReturnValue({
                    getState: jest.fn().mockReturnValue(undefined),
                } as unknown as EventTimeline);

                const warnLogSpy = jest.spyOn(console, "warn");
                warnLogSpy.mockClear();
                const stateWarningWasLogged = () =>
                    warnLogSpy.mock.calls.find((call) => (call[1] as string).includes("Couldn't get state for room"));

                MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, testConfig);
                await flushPromises();

                if (testConfig.listenForMemberStateEvents) {
                    // eslint-disable-next-line jest/no-conditional-expect
                    expect(stateWarningWasLogged()).toBeTruthy();
                } else {
                    // eslint-disable-next-line jest/no-conditional-expect
                    expect(stateWarningWasLogged()).toBeFalsy();
                }
            });

            it("creates a room-scoped session from room state", async () => {
                const mockRoom = makeMockRoom([membershipTemplate], testConfig.testCreateSticky);

                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships.length).toEqual(1);
                expect(sess?.memberships[0].slotDescription.id).toEqual("");
                expect(sess?.memberships[0].scope).toEqual("m.room");
                expect(sess?.memberships[0].application).toEqual("m.call");
                expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
                expect(sess?.memberships[0].isExpired()).toEqual(false);
                expect(sess?.slotDescription.id).toEqual("");
            });

            it("ignores memberships where application is not m.call", () => {
                const testMembership = Object.assign({}, membershipTemplate, {
                    application: "not-m.call",
                });
                const mockRoom = makeMockRoom([testMembership], testConfig.testCreateSticky);
                const sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess?.memberships).toHaveLength(0);
            });

            it("ignores memberships where callId is not empty", () => {
                const testMembership = Object.assign({}, membershipTemplate, {
                    call_id: "not-empty",
                    scope: "m.room",
                });
                const mockRoom = makeMockRoom([testMembership], testConfig.testCreateSticky);
                const sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess?.memberships).toHaveLength(0);
            });

            it("ignores expired memberships events", async () => {
                jest.useFakeTimers();
                const expiredMembership = Object.assign({}, membershipTemplate);
                expiredMembership.expires = 1000;
                expiredMembership.device_id = "EXPIRED";
                const mockRoom = makeMockRoom([membershipTemplate, expiredMembership], testConfig.testCreateSticky);

                jest.advanceTimersByTime(2000);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships.length).toEqual(1);
                expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
                jest.useRealTimers();
            });

            it("ignores memberships events of members not in the room", () => {
                const mockRoom = makeMockRoom([membershipTemplate], testConfig.testCreateSticky);
                mockRoom.hasMembershipState.mockImplementation((state) => state === KnownMembership.Join);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess?.memberships.length).toEqual(0);
            });

            it("ignores memberships events with no sender", () => {
                // Force the sender to be undefined.
                const mockRoom = makeMockRoom([{ ...membershipTemplate, user_id: "" }], testConfig.testCreateSticky);
                mockRoom.hasMembershipState.mockImplementation((state) => state === KnownMembership.Join);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess?.memberships.length).toEqual(0);
            });

            it("honours created_ts", async () => {
                jest.useFakeTimers();
                jest.setSystemTime(500);
                const expiredMembership = Object.assign({}, membershipTemplate);
                expiredMembership.created_ts = 500;
                expiredMembership.expires = 1000;
                const mockRoom = makeMockRoom([expiredMembership], testConfig.testCreateSticky);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships[0].getAbsoluteExpiry()).toEqual(1500);
                jest.useRealTimers();
            });

            it("returns empty session if no membership events are present", () => {
                const mockRoom = makeMockRoom([], testConfig.testCreateSticky);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess?.memberships).toHaveLength(0);
            });

            it("safely ignores events with no memberships section", () => {
                const event = {
                    getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                    getContent: jest.fn().mockReturnValue({}),
                    getSender: jest.fn().mockReturnValue("@mock:user.example"),
                    getTs: jest.fn().mockReturnValue(1000),
                    getLocalAge: jest.fn().mockReturnValue(0),
                };
                const mockRoom = makeMockRoom([]);
                mockRoom.getLiveTimeline.mockReturnValue({
                    getState: jest.fn().mockReturnValue({
                        on: jest.fn(),
                        off: jest.fn(),
                        getStateEvents: (_type: string, _stateKey: string) => [event],
                        events: new Map([
                            [
                                EventType.GroupCallMemberPrefix,
                                {
                                    size: () => true,
                                    has: (_stateKey: string) => true,
                                    get: (_stateKey: string) => event,
                                    values: () => [event],
                                },
                            ],
                        ]),
                    }),
                } as unknown as EventTimeline);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess.memberships).toHaveLength(0);
            });

            it("safely ignores events with junk memberships section", () => {
                const event = {
                    getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                    getContent: jest.fn().mockReturnValue({ memberships: ["i am a fish"] }),
                    getSender: jest.fn().mockReturnValue("@mock:user.example"),
                    getTs: jest.fn().mockReturnValue(1000),
                    getLocalAge: jest.fn().mockReturnValue(0),
                };
                const mockRoom = makeMockRoom([]);
                mockRoom.getLiveTimeline.mockReturnValue({
                    getState: jest.fn().mockReturnValue({
                        on: jest.fn(),
                        off: jest.fn(),
                        getStateEvents: (_type: string, _stateKey: string) => [event],
                        events: new Map([
                            [
                                EventType.GroupCallMemberPrefix,
                                {
                                    size: () => true,
                                    has: (_stateKey: string) => true,
                                    get: (_stateKey: string) => event,
                                    values: () => [event],
                                },
                            ],
                        ]),
                    }),
                } as unknown as EventTimeline);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess.memberships).toHaveLength(0);
            });

            it("ignores memberships with no device_id", () => {
                const testMembership = Object.assign({}, membershipTemplate);
                (testMembership.device_id as string | undefined) = undefined;
                const mockRoom = makeMockRoom([testMembership]);
                const sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess.memberships).toHaveLength(0);
            });

            it("ignores memberships with no call_id", () => {
                const testMembership = Object.assign({}, membershipTemplate);
                (testMembership.call_id as string | undefined) = undefined;
                const mockRoom = makeMockRoom([testMembership]);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                expect(sess.memberships).toHaveLength(0);
            });
        },
    );

    describe("roomsessionForSlot combined state", () => {
        it("perfers sticky events when both membership and sticky events appear for the same user", async () => {
            // Create a room with identical member state and sticky state for the same user.
            const mockRoom = makeMockRoom([membershipTemplate]);
            mockRoom._unstable_getStickyEvents.mockImplementation(() => {
                const ev = mockRTCEvent(
                    {
                        ...membershipTemplate,
                        msc4354_sticky_key: `_${membershipTemplate.user_id}_${membershipTemplate.device_id}`,
                    },
                    mockRoom.roomId,
                );
                return [ev as StickyMatrixEvent];
            });

            // Expect for there to be one membership as the state has been merged down.
            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, {
                listenForStickyEvents: true,
                listenForMemberStateEvents: true,
            });
            await flushPromises();
            expect(sess?.memberships.length).toEqual(1);
            expect(sess?.memberships[0].slotDescription.id).toEqual("");
            expect(sess?.memberships[0].scope).toEqual("m.room");
            expect(sess?.memberships[0].application).toEqual("m.call");
            expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            expect(sess?.memberships[0].isExpired()).toEqual(false);
            expect(sess?.slotDescription.id).toEqual("");
        });
        it("combines sticky and membership events when both exist", async () => {
            // Create a room with identical member state and sticky state for the same user.
            const mockRoom = makeMockRoom([membershipTemplate]);
            const stickyUserId = "@stickyev:user.example";
            mockRoom._unstable_getStickyEvents.mockImplementation(() => {
                const ev = mockRTCEvent(
                    {
                        ...membershipTemplate,
                        user_id: stickyUserId,
                        msc4354_sticky_key: `_${stickyUserId}_${membershipTemplate.device_id}`,
                    },
                    mockRoom.roomId,
                    15000,
                    Date.now() - 1000, // Sticky event comes first.
                );
                return [ev as StickyMatrixEvent];
            });

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, {
                listenForStickyEvents: true,
                listenForMemberStateEvents: true,
            });
            await flushPromises();

            const memberships = sess.memberships;
            expect(memberships.length).toEqual(2);
            expect(memberships[0].sender).toEqual(stickyUserId);
            expect(memberships[0].slotDescription.id).toEqual("");
            expect(memberships[0].scope).toEqual("m.room");
            expect(memberships[0].application).toEqual("m.call");
            expect(memberships[0].deviceId).toEqual("AAAAAAA");
            expect(memberships[0].isExpired()).toEqual(false);

            // Then state
            expect(memberships[1].sender).toEqual(membershipTemplate.user_id);

            expect(sess?.slotDescription.id).toEqual("");
        });
        it("handles an incoming sticky event to an existing session", async () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            const stickyUserId = "@stickyev:user.example";

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, {
                listenForStickyEvents: true,
                listenForMemberStateEvents: true,
            });
            await flushPromises();
            expect(sess.memberships.length).toEqual(1);
            const stickyEv = mockRTCEvent(
                {
                    ...membershipTemplate,
                    user_id: stickyUserId,
                    msc4354_sticky_key: `_${stickyUserId}_${membershipTemplate.device_id}`,
                },
                mockRoom.roomId,
                15000,
                Date.now() - 1000, // Sticky event comes first.
            ) as StickyMatrixEvent;
            mockRoom._unstable_getStickyEvents.mockImplementation(() => {
                return [stickyEv];
            });
            mockRoom.emit(RoomStickyEventsEvent.Update, [stickyEv], [], []);
            await flushPromises();
            expect(sess.memberships.length).toEqual(2);
        });
    });

    describe("getOldestMembership", () => {
        it("returns the oldest membership event", async () => {
            jest.useFakeTimers();
            jest.setSystemTime(4000);
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, { device_id: "foo", created_ts: 3000 }),
                Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
            ]);

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
            expect(sess.getOldestMembership()!.deviceId).toEqual("old");
            jest.useRealTimers();
        });
    });

    describe("getConsensusCallIntent", () => {
        it.each([
            [undefined, undefined, undefined],
            ["audio", undefined, "audio"],
            [undefined, "audio", "audio"],
            ["audio", "audio", "audio"],
            ["audio", "video", undefined],
        ])("gets correct consensus for %s + %s = %s", async (intentA, intentB, result) => {
            jest.useFakeTimers();
            jest.setSystemTime(4000);
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, { "m.call.intent": intentA }),
                Object.assign({}, membershipTemplate, { "m.call.intent": intentB }),
            ]);

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
            expect(sess.getConsensusCallIntent()).toEqual(result);
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
            jest.useFakeTimers();
            jest.setSystemTime(3000);
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, {
                    device_id: "foo",
                    created_ts: 500,
                    foci_preferred: [firstPreferredFocus],
                }),
                Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
            ]);

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);

            sess.joinRTCSession(owmMemberIdentity, [{ type: "livekit", livekit_service_url: "htts://test.org" }], {
                type: "livekit",
                focus_selection: "oldest_membership",
            });
            jest.useRealTimers();
        });
        it("does not provide focus if the selection method is unknown", () => {
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, {
                    device_id: "foo",
                    created_ts: 500,
                    foci_preferred: [firstPreferredFocus],
                }),
                Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
            ]);

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);

            sess.joinRTCSession(owmMemberIdentity, [{ type: "livekit", livekit_service_url: "htts://test.org" }], {
                type: "livekit",
                focus_selection: "unknown",
            });
            expect(sess.memberships.length).toBe(0);
        });
    });

    describe("joining", () => {
        let mockRoom: Room;
        let sendEventMock: jest.Mock;
        let sendStateEventMock: jest.Mock;

        let sentStateEvent: Promise<void>;
        beforeEach(async () => {
            sentStateEvent = new Promise((resolve) => {
                sendStateEventMock = jest.fn(resolve);
            });
            sendEventMock = jest.fn().mockResolvedValue(undefined);
            client.sendStateEvent = sendStateEventMock;
            client.sendEvent = sendEventMock;

            client._unstable_updateDelayedEvent = jest.fn();
            client._unstable_cancelScheduledDelayedEvent = jest.fn();
            client._unstable_restartScheduledDelayedEvent = jest.fn();
            client._unstable_sendScheduledDelayedEvent = jest.fn();

            mockRoom = makeMockRoom([]);
            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
        });

        afterEach(async () => {
            const wasJoined = sess!.isJoined();
            // stop the timers
            const left = await sess!.leaveRoomSession();
            if (left !== wasJoined) {
                throw new Error(`Unexpected leave result: wanted ${wasJoined}, got ${left}`);
            }
        });

        it("starts un-joined", () => {
            expect(sess!.isJoined()).toEqual(false);
        });

        it("shows joined once join is called", () => {
            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus);
            expect(sess!.isJoined()).toEqual(true);
        });

        it("uses the sticky events membership manager implementation", () => {
            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { unstableSendStickyEvents: true });
            expect(sess!.isJoined()).toEqual(true);
            expect(sess!["membershipManager"] instanceof StickyEventMembershipManager).toEqual(true);
        });

        it("sends a notification when starting a call and emit DidSendCallNotification", async () => {
            // Simulate a join, including the update to the room state
            // Ensure sendEvent returns event IDs so the DidSendCallNotification payload includes them
            sendEventMock
                .mockResolvedValueOnce({ event_id: "legacy-evt" })
                .mockResolvedValueOnce({ event_id: "new-evt" });
            const didSendEventFn = jest.fn();
            sess!.once(MatrixRTCSessionEvent.DidSendCallNotification, didSendEventFn);
            // Create an additional listener to create a promise that resolves after the emission.
            const didSendNotification = new Promise((resolve) => {
                sess!.once(MatrixRTCSessionEvent.DidSendCallNotification, resolve);
            });

            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            mockRoomState(mockRoom, [{ ...membershipTemplate, user_id: client.getUserId()! }]);
            await sess!._onRTCSessionMemberUpdate();
            const ownMembershipId = sess?.memberships[0].eventId;

            expect(client.sendEvent).toHaveBeenCalledWith(mockRoom!.roomId, EventType.RTCNotification, {
                "m.mentions": { user_ids: [], room: true },
                "notification_type": "ring",
                "m.relates_to": {
                    event_id: ownMembershipId,
                    rel_type: "m.reference",
                },
                "lifetime": 30000,
                "sender_ts": expect.any(Number),
            });

            // Check if deprecated notify event is also sent.
            expect(client.sendEvent).toHaveBeenCalledWith(mockRoom!.roomId, EventType.CallNotify, {
                "application": "m.call",
                "m.mentions": { user_ids: [], room: true },
                "notify_type": "ring",
                "call_id": "",
            });
            await didSendNotification;
            // And ensure we emitted the DidSendCallNotification event with both payloads
            expect(didSendEventFn).toHaveBeenCalledWith(
                {
                    "event_id": "new-evt",
                    "lifetime": 30000,
                    "m.mentions": { room: true, user_ids: [] },
                    "m.relates_to": {
                        event_id: expect.any(String),
                        rel_type: "m.reference",
                    },
                    "notification_type": "ring",
                    "sender_ts": expect.any(Number),
                },
                {
                    "application": "m.call",
                    "call_id": "",
                    "event_id": "legacy-evt",
                    "m.mentions": { room: true, user_ids: [] },
                    "notify_type": "ring",
                },
            );
        });

        it("sends a notification with a intent when starting a call and emits DidSendCallNotification", async () => {
            // Simulate a join, including the update to the room state
            // Ensure sendEvent returns event IDs so the DidSendCallNotification payload includes them
            sendEventMock
                .mockResolvedValueOnce({ event_id: "legacy-evt" })
                .mockResolvedValueOnce({ event_id: "new-evt" });
            const didSendEventFn = jest.fn();
            sess!.once(MatrixRTCSessionEvent.DidSendCallNotification, didSendEventFn);
            // Create an additional listener to create a promise that resolves after the emission.
            const didSendNotification = new Promise((resolve) => {
                sess!.once(MatrixRTCSessionEvent.DidSendCallNotification, resolve);
            });

            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, {
                notificationType: "ring",
                callIntent: "audio",
            });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);

            mockRoomState(mockRoom, [
                {
                    ...membershipTemplate,
                    "user_id": client.getUserId()!,
                    // This is what triggers the intent type on the notification event.
                    "m.call.intent": "audio",
                },
            ]);

            await sess!._onRTCSessionMemberUpdate();
            const ownMembershipId = sess?.memberships[0].eventId;
            expect(sess!.getConsensusCallIntent()).toEqual("audio");

            expect(client.sendEvent).toHaveBeenCalledWith(mockRoom!.roomId, EventType.RTCNotification, {
                "m.mentions": { user_ids: [], room: true },
                "notification_type": "ring",
                "m.call.intent": "audio",
                "m.relates_to": {
                    event_id: ownMembershipId,
                    rel_type: "m.reference",
                },
                "lifetime": 30000,
                "sender_ts": expect.any(Number),
            });

            // Check if deprecated notify event is also sent.
            expect(client.sendEvent).toHaveBeenCalledWith(mockRoom!.roomId, EventType.CallNotify, {
                "application": "m.call",
                "m.mentions": { user_ids: [], room: true },
                "notify_type": "ring",
                "call_id": "",
            });
            await didSendNotification;
            // And ensure we emitted the DidSendCallNotification event with both payloads
            expect(didSendEventFn).toHaveBeenCalledWith(
                {
                    "event_id": "new-evt",
                    "lifetime": 30000,
                    "m.mentions": { room: true, user_ids: [] },
                    "m.relates_to": {
                        event_id: expect.any(String),
                        rel_type: "m.reference",
                    },
                    "notification_type": "ring",
                    "m.call.intent": "audio",
                    "sender_ts": expect.any(Number),
                },
                {
                    "application": "m.call",
                    "call_id": "",
                    "event_id": "legacy-evt",
                    "m.mentions": { room: true, user_ids: [] },
                    "notify_type": "ring",
                },
            );
        });

        it("doesn't send a notification when joining an existing call", async () => {
            // Add another member to the call so that it is considered an existing call
            mockRoomState(mockRoom, [membershipTemplate]);
            await sess!._onRTCSessionMemberUpdate();

            // Simulate a join, including the update to the room state
            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            mockRoomState(mockRoom, [membershipTemplate, { ...membershipTemplate, user_id: client.getUserId()! }]);
            await sess!._onRTCSessionMemberUpdate();

            expect(client.sendEvent).not.toHaveBeenCalled();
        });

        it("doesn't send a notification when someone else starts the call faster than us", async () => {
            // Simulate a join, including the update to the room state
            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            // But this time we want to simulate a race condition in which we receive a state event
            // from someone else, starting the call before our own state event has been sent
            mockRoomState(mockRoom, [membershipTemplate]);
            await sess!._onRTCSessionMemberUpdate();
            mockRoomState(mockRoom, [membershipTemplate, { ...membershipTemplate, user_id: client.getUserId()! }]);
            await sess!._onRTCSessionMemberUpdate();

            // We assume that the responsibility to send a notification, if any, lies with the other
            // participant that won the race
            expect(client.sendEvent).not.toHaveBeenCalled();
        });
    });

    describe("onMembershipsChanged", () => {
        it("does not emit if no membership changes", async () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
            await sess._onRTCSessionMemberUpdate();

            expect(onMembershipsChanged).not.toHaveBeenCalled();
        });

        it("emits on membership changes", async () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);

            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

            mockRoomState(mockRoom, []);
            await sess._onRTCSessionMemberUpdate();

            expect(onMembershipsChanged).toHaveBeenCalled();
        });

        // TODO: re-enable this test when expiry is implemented
        // eslint-disable-next-line jest/no-commented-out-tests
        // it("emits an event at the time a membership event expires", () => {
        //     jest.useFakeTimers();
        //     try {
        //         const membership = Object.assign({}, membershipTemplate);
        //         const mockRoom = makeMockRoom([membership]);

        //         sess = MatrixRTCSession.roomsessionForSlot(client, mockRoom);
        //         const membershipObject = sess.memberships[0];

        //         const onMembershipsChanged = jest.fn();
        //         sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

        //         jest.advanceTimersByTime(61 * 1000 * 1000);

        //         expect(onMembershipsChanged).toHaveBeenCalledWith([membershipObject], []);
        //         expect(sess?.memberships.length).toEqual(0);
        //     } finally {
        //         jest.useRealTimers();
        //     }
        // });
    });

    describe("key management", () => {
        // Then encryption manager is tested separately, here we just test the integration
        it("provides encryption keys for memberships", async () => {
            client.encryptAndSendToDevice = jest.fn().mockResolvedValue(undefined);
            const mockRoom = makeMockRoom([
                {
                    ...membershipTemplate,
                    user_id: "@bob:user.example",
                    device_id: "BBBBBB",
                },
                {
                    ...membershipTemplate,
                    user_id: client.getUserId()!,
                    device_id: client.getDeviceId()!,
                },
            ]);
            const sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            sess.joinRTCSession(owmMemberIdentity, [{ type: "livekit", livekit_service_url: "https://test.org" }], {
                type: "livekit",
                focus_selection: "oldest_membership",
            });
            await flushPromises();

            expect(client.encryptAndSendToDevice).toHaveBeenCalledTimes(1);
            expect(client.encryptAndSendToDevice).toHaveBeenCalledWith(
                "io.element.call.encryption_keys",
                [{ userId: "@bob:user.example", deviceId: "BBBBBB" }],
                expect.anything(),
            );
            expect(sess.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

            await sess.leaveRoomSession();
        });
    });
});
