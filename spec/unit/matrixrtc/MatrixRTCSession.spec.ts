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

import { type Mock } from "vitest";

import { type EventTimeline, EventType, MatrixClient, type Room } from "../../../src";
import { KnownMembership } from "../../../src/@types/membership";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "../../../src/matrixrtc/MatrixRTCSession";
import { makeMockRoom, membershipTemplate, mockRoomState, mockRTCEvent, owmMemberIdentity } from "./mocks";
import { RoomStickyEventsEvent, type StickyMatrixEvent } from "../../../src/models/room-sticky-events.ts";
import { StickyEventMembershipManager } from "../../../src/matrixrtc/MembershipManager.ts";
import { flushPromises } from "../../test-utils/flushPromises.ts";

const mockFocus = { type: "mock" };

const callSession = { id: "ROOM", application: "m.call" };

describe("MatrixRTCSession", () => {
    let client: MatrixClient;
    let sess: MatrixRTCSession | undefined;

    beforeEach(() => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.getUserId = vi.fn().mockReturnValue("@alice:example.org");
        client.getDeviceId = vi.fn().mockReturnValue("AAAAAAA");
        client.sendEvent = vi.fn().mockResolvedValue({ event_id: "success" });
        client.decryptEventIfNeeded = vi.fn();
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
                    getState: vi.fn().mockReturnValue(undefined),
                } as unknown as EventTimeline);

                const warnLogSpy = vi.spyOn(console, "warn");
                warnLogSpy.mockClear();
                const stateWarningWasLogged = () =>
                    warnLogSpy.mock.calls.find((call) => (call[1] as string).includes("Couldn't get state for room"));

                MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, testConfig);
                await flushPromises();

                if (testConfig.listenForMemberStateEvents) {
                    // eslint-disable-next-line @vitest/no-conditional-expect
                    expect(stateWarningWasLogged()).toBeTruthy();
                } else {
                    // eslint-disable-next-line @vitest/no-conditional-expect
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
                expect(sess?.memberships[0].slotDescription.id).toEqual("ROOM");
                expect(sess?.memberships[0].scope).toEqual("m.room");
                expect(sess?.memberships[0].application).toEqual("m.call");
                expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
                expect(sess?.memberships[0].isExpired()).toEqual(false);
                expect(sess?.slotDescription.id).toEqual("ROOM");
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
                vi.useFakeTimers();
                const expiredMembership = Object.assign({}, membershipTemplate);
                expiredMembership.expires = 1000;
                expiredMembership.device_id = "EXPIRED";
                const mockRoom = makeMockRoom([membershipTemplate, expiredMembership], testConfig.testCreateSticky);

                vi.advanceTimersByTime(2000);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships.length).toEqual(1);
                expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
                vi.useRealTimers();
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
                vi.useFakeTimers();
                vi.setSystemTime(500);
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
                vi.useRealTimers();
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
                    getType: vi.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                    getContent: vi.fn().mockReturnValue({}),
                    getSender: vi.fn().mockReturnValue("@mock:user.example"),
                    getTs: vi.fn().mockReturnValue(1000),
                    getLocalAge: vi.fn().mockReturnValue(0),
                };
                const mockRoom = makeMockRoom([]);
                mockRoom.getLiveTimeline.mockReturnValue({
                    getState: vi.fn().mockReturnValue({
                        on: vi.fn(),
                        off: vi.fn(),
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
                    getType: vi.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                    getContent: vi.fn().mockReturnValue({ memberships: ["i am a fish"] }),
                    getSender: vi.fn().mockReturnValue("@mock:user.example"),
                    getTs: vi.fn().mockReturnValue(1000),
                    getLocalAge: vi.fn().mockReturnValue(0),
                };
                const mockRoom = makeMockRoom([]);
                mockRoom.getLiveTimeline.mockReturnValue({
                    getState: vi.fn().mockReturnValue({
                        on: vi.fn(),
                        off: vi.fn(),
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

            it("assigns RTC backend identities to memberships", async () => {
                const mockRoom = makeMockRoom([membershipTemplate], testConfig.testCreateSticky);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships.length).toEqual(1);
                // Backend identity is expected to not be hashed with a legacy (session) membership
                expect(sess?.memberships[0].rtcBackendIdentity).toEqual("@mock:user.example:AAAAAAA");
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
            expect(sess?.memberships[0].slotDescription.id).toEqual("ROOM");
            expect(sess?.memberships[0].scope).toEqual("m.room");
            expect(sess?.memberships[0].application).toEqual("m.call");
            expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            expect(sess?.memberships[0].isExpired()).toEqual(false);
            expect(sess?.slotDescription.id).toEqual("ROOM");
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
            expect(memberships[0].slotDescription.id).toEqual("ROOM");
            expect(memberships[0].scope).toEqual("m.room");
            expect(memberships[0].application).toEqual("m.call");
            expect(memberships[0].deviceId).toEqual("AAAAAAA");
            expect(memberships[0].isExpired()).toEqual(false);

            // Then state
            expect(memberships[1].sender).toEqual(membershipTemplate.user_id);

            expect(sess?.slotDescription.id).toEqual("ROOM");
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
            vi.useFakeTimers();
            vi.setSystemTime(4000);
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, { device_id: "foo", created_ts: 3000 }),
                Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
            ]);

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
            expect(sess.getOldestMembership()!.deviceId).toEqual("old");
            vi.useRealTimers();
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
            vi.useFakeTimers();
            vi.setSystemTime(4000);
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, { "m.call.intent": intentA }),
                Object.assign({}, membershipTemplate, { "m.call.intent": intentB }),
            ]);

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
            expect(sess.getConsensusCallIntent()).toEqual(result);
            vi.useRealTimers();
        });
    });

    describe("getsActiveFocus", () => {
        const firstPreferredFocus = {
            type: "livekit",
            livekit_service_url: "https://active.url",
            livekit_alias: "!active:active.url",
        };
        it("gets the correct active focus with oldest_membership", async () => {
            client.sendStateEvent = vi.fn();
            vi.useFakeTimers();
            vi.setSystemTime(3000);
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

            sess.joinRTCSession(
                owmMemberIdentity,
                [{ type: "livekit", livekit_service_url: "htts://test.org" }],
                undefined,
            );
            await flushPromises();
            expect(client.sendStateEvent).toHaveBeenCalledWith(
                expect.any(String),
                "org.matrix.msc3401.call.member",
                {
                    "application": "m.call",
                    "call_id": "",
                    "device_id": "AAAAAAA",
                    "expires": 14400000,
                    "foci_preferred": [
                        {
                            livekit_service_url: "htts://test.org",
                            type: "livekit",
                        },
                    ],
                    "focus_active": {
                        focus_selection: "oldest_membership",
                        type: "livekit",
                    },
                    "m.call.intent": undefined,
                    "membershipID": "@alice:example.org:AAAAAAA",
                    "scope": "m.room",
                },
                "_@alice:example.org_AAAAAAA_m.call",
            );
            vi.useRealTimers();
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
        let sendEventMock: Mock;
        let sendStateEventMock: Mock;

        let sentStateEvent: Promise<void>;
        beforeEach(async () => {
            sentStateEvent = new Promise((resolve) => {
                sendStateEventMock = vi.fn(resolve);
            });
            sendEventMock = vi.fn().mockResolvedValue(undefined);
            client.sendStateEvent = sendStateEventMock;
            client.sendEvent = sendEventMock;

            client._unstable_updateDelayedEvent = vi.fn();
            client._unstable_cancelScheduledDelayedEvent = vi.fn();
            client._unstable_restartScheduledDelayedEvent = vi.fn();
            client._unstable_sendScheduledDelayedEvent = vi.fn();

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
            sendEventMock.mockResolvedValueOnce({ event_id: "new-evt" });
            const didSendEventFn = vi.fn();
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

            await didSendNotification;
            // And ensure we emitted the DidSendCallNotification event with both payloads
            expect(didSendEventFn).toHaveBeenCalledWith({
                "event_id": "new-evt",
                "lifetime": 30000,
                "m.mentions": { room: true, user_ids: [] },
                "m.relates_to": {
                    event_id: expect.any(String),
                    rel_type: "m.reference",
                },
                "notification_type": "ring",
                "sender_ts": expect.any(Number),
            });
        });

        it("sends a notification with a intent when starting a call and emits DidSendCallNotification", async () => {
            // Simulate a join, including the update to the room state
            // Ensure sendEvent returns event IDs so the DidSendCallNotification payload includes them
            sendEventMock.mockResolvedValueOnce({ event_id: "new-evt" });
            const didSendEventFn = vi.fn();
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
            const ownMembershipEventId = sess?.memberships[0].eventId;
            expect(sess!.getConsensusCallIntent()).toEqual("audio");

            expect(client.sendEvent).toHaveBeenCalledWith(mockRoom!.roomId, EventType.RTCNotification, {
                "m.mentions": { user_ids: [], room: true },
                "notification_type": "ring",
                "m.call.intent": "audio",
                "m.relates_to": {
                    event_id: ownMembershipEventId,
                    rel_type: "m.reference",
                },
                "lifetime": 30000,
                "sender_ts": expect.any(Number),
            });

            await didSendNotification;
            // And ensure we emitted the DidSendCallNotification event with both payloads
            expect(didSendEventFn).toHaveBeenCalledWith({
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
            });
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

            // check we send out join event
            expect(client.sendStateEvent).toHaveBeenCalled();
            // but no notification event
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

            // check we send out join event
            expect(client.sendStateEvent).toHaveBeenCalled();
            // but no notification event
            //
            //  We assume that the responsibility to send a notification, if any, lies with the other
            // participant that won the race
            expect(client.sendEvent).not.toHaveBeenCalled();
        });
    });

    describe("onMembershipsChanged", () => {
        it("only emit if membership changes", async () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
            await flushPromises();
            const onMembershipsChanged = vi.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

            // no change -> no emission
            await sess._onRTCSessionMemberUpdate();
            expect(onMembershipsChanged).not.toHaveBeenCalled();

            // no change -> emission
            mockRoomState(mockRoom, []);
            await sess._onRTCSessionMemberUpdate();
            expect(onMembershipsChanged).toHaveBeenCalled();
        });

        // TODO: re-enable this test when expiry is implemented
        // eslint-disable-next-line @vitest/no-commented-out-tests
        // it("emits an event at the time a membership event expires", () => {
        //     vi.useFakeTimers();
        //     try {
        //         const membership = Object.assign({}, membershipTemplate);
        //         const mockRoom = makeMockRoom([membership]);

        //         sess = MatrixRTCSession.roomsessionForSlot(client, mockRoom);
        //         const membershipObject = sess.memberships[0];

        //         const onMembershipsChanged = vi.fn();
        //         sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

        //         vi.advanceTimersByTime(61 * 1000 * 1000);

        //         expect(onMembershipsChanged).toHaveBeenCalledWith([membershipObject], []);
        //         expect(sess?.memberships.length).toEqual(0);
        //     } finally {
        //         vi.useRealTimers();
        //     }
        // });
    });

    describe("key management", () => {
        // Then encryption manager is tested separately, here we just test the integration
        it("provides encryption keys for memberships", async () => {
            client.encryptAndSendToDevice = vi.fn().mockResolvedValue(undefined);
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
