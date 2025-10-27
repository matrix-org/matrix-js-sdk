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

import {
    encodeBase64,
    type EventTimeline,
    EventType,
    MatrixClient,
    type MatrixError,
    type MatrixEvent,
    type Room,
} from "../../../src";
import { KnownMembership } from "../../../src/@types/membership";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "../../../src/matrixrtc/MatrixRTCSession";
import { Status, type EncryptionKeysEventContent } from "../../../src/matrixrtc/types";
import {
    makeMockEvent,
    makeMockRoom,
    membershipTemplate,
    makeKey,
    type MembershipData,
    mockRoomState,
    mockRTCEvent,
} from "./mocks";
import { RTCEncryptionManager } from "../../../src/matrixrtc/RTCEncryptionManager.ts";
import { RoomStickyEventsEvent, type StickyMatrixEvent } from "../../../src/models/room-sticky-events.ts";
import { StickyEventMembershipManager } from "../../../src/matrixrtc/MembershipManager.ts";

const mockFocus = { type: "mock" };

const textEncoder = new TextEncoder();

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
        "roomSessionForRoom listenForSticky=$listenForStickyEvents listenForMemberStateEvents=$listenForMemberStateEvents testCreateSticky=$testCreateSticky",
        (testConfig) => {
            it(`will ${testConfig.listenForMemberStateEvents ? "" : "NOT"} throw if the room does not have any state stored`, () => {
                const mockRoom = makeMockRoom([membershipTemplate], testConfig.testCreateSticky);
                mockRoom.getLiveTimeline.mockReturnValue({
                    getState: jest.fn().mockReturnValue(undefined),
                } as unknown as EventTimeline);
                if (testConfig.listenForMemberStateEvents) {
                    // eslint-disable-next-line jest/no-conditional-expect
                    expect(() => {
                        MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, testConfig);
                    }).toThrow();
                } else {
                    // eslint-disable-next-line jest/no-conditional-expect
                    expect(() => {
                        MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, testConfig);
                    }).not.toThrow();
                }
            });

            it("creates a room-scoped session from room state", () => {
                const mockRoom = makeMockRoom([membershipTemplate], testConfig.testCreateSticky);

                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
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

            it("ignores expired memberships events", () => {
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

            it("honours created_ts", () => {
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

    describe("roomSessionForRoom combined state", () => {
        it("perfers sticky events when both membership and sticky events appear for the same user", () => {
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
            expect(sess?.memberships.length).toEqual(1);
            expect(sess?.memberships[0].slotDescription.id).toEqual("");
            expect(sess?.memberships[0].scope).toEqual("m.room");
            expect(sess?.memberships[0].application).toEqual("m.call");
            expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            expect(sess?.memberships[0].isExpired()).toEqual(false);
            expect(sess?.slotDescription.id).toEqual("");
        });
        it("combines sticky and membership events when both exist", () => {
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
        it("handles an incoming sticky event to an existing session", () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            const stickyUserId = "@stickyev:user.example";

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, {
                listenForStickyEvents: true,
                listenForMemberStateEvents: true,
            });
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
            expect(sess.memberships.length).toEqual(2);
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

            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
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
        ])("gets correct consensus for %s + %s = %s", (intentA, intentB, result) => {
            jest.useFakeTimers();
            jest.setSystemTime(4000);
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, { "m.call.intent": intentA }),
                Object.assign({}, membershipTemplate, { "m.call.intent": intentB }),
            ]);

            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
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

            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

            sess.joinRoomSession([{ type: "livekit", livekit_service_url: "htts://test.org" }], {
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

            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

            sess.joinRoomSession([{ type: "livekit", livekit_service_url: "htts://test.org" }], {
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
        beforeEach(() => {
            sentStateEvent = new Promise((resolve) => {
                sendStateEventMock = jest.fn(resolve);
            });
            sendEventMock = jest.fn().mockResolvedValue(undefined);
            client.sendStateEvent = sendStateEventMock;
            client.sendEvent = sendEventMock;

            client._unstable_updateDelayedEvent = jest.fn();

            mockRoom = makeMockRoom([]);
            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
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
            sess!.joinRoomSession([mockFocus], mockFocus);
            expect(sess!.isJoined()).toEqual(true);
        });

        it("uses the sticky events membership manager implementation", () => {
            sess!.joinRoomSession([mockFocus], mockFocus, { unstableSendStickyEvents: true });
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

            sess!.joinRoomSession([mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            mockRoomState(mockRoom, [{ ...membershipTemplate, user_id: client.getUserId()! }]);
            sess!.onRTCSessionMemberUpdate();
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

            sess!.joinRoomSession([mockFocus], mockFocus, { notificationType: "ring", callIntent: "audio" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);

            mockRoomState(mockRoom, [
                {
                    ...membershipTemplate,
                    "user_id": client.getUserId()!,
                    // This is what triggers the intent type on the notification event.
                    "m.call.intent": "audio",
                },
            ]);

            sess!.onRTCSessionMemberUpdate();
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
            sess!.onRTCSessionMemberUpdate();

            // Simulate a join, including the update to the room state
            sess!.joinRoomSession([mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            mockRoomState(mockRoom, [membershipTemplate, { ...membershipTemplate, user_id: client.getUserId()! }]);
            sess!.onRTCSessionMemberUpdate();

            expect(client.sendEvent).not.toHaveBeenCalled();
        });

        it("doesn't send a notification when someone else starts the call faster than us", async () => {
            // Simulate a join, including the update to the room state
            sess!.joinRoomSession([mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            // But this time we want to simulate a race condition in which we receive a state event
            // from someone else, starting the call before our own state event has been sent
            mockRoomState(mockRoom, [membershipTemplate]);
            sess!.onRTCSessionMemberUpdate();
            mockRoomState(mockRoom, [membershipTemplate, { ...membershipTemplate, user_id: client.getUserId()! }]);
            sess!.onRTCSessionMemberUpdate();

            // We assume that the responsibility to send a notification, if any, lies with the other
            // participant that won the race
            expect(client.sendEvent).not.toHaveBeenCalled();
        });
    });

    describe("onMembershipsChanged", () => {
        it("does not emit if no membership changes", () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
            sess.onRTCSessionMemberUpdate();

            expect(onMembershipsChanged).not.toHaveBeenCalled();
        });

        it("emits on membership changes", () => {
            const mockRoom = makeMockRoom([membershipTemplate]);
            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

            mockRoomState(mockRoom, []);
            sess.onRTCSessionMemberUpdate();

            expect(onMembershipsChanged).toHaveBeenCalled();
        });

        // TODO: re-enable this test when expiry is implemented
        // eslint-disable-next-line jest/no-commented-out-tests
        // it("emits an event at the time a membership event expires", () => {
        //     jest.useFakeTimers();
        //     try {
        //         const membership = Object.assign({}, membershipTemplate);
        //         const mockRoom = makeMockRoom([membership]);

        //         sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
        // TODO make this test suit only test the encryption manager. And mock the transport directly not the session.
        describe("sending", () => {
            let mockRoom: Room;
            let sendStateEventMock: jest.Mock;
            let sendDelayedStateMock: jest.Mock;
            let sendEventMock: jest.Mock;
            let sendToDeviceMock: jest.Mock;

            beforeEach(() => {
                sendStateEventMock = jest.fn().mockResolvedValue({ event_id: "id" });
                sendDelayedStateMock = jest.fn().mockResolvedValue({ event_id: "id" });
                sendEventMock = jest.fn().mockResolvedValue({ event_id: "id" });
                sendToDeviceMock = jest.fn();
                client.sendStateEvent = sendStateEventMock;
                client._unstable_sendDelayedStateEvent = sendDelayedStateMock;
                client.sendEvent = sendEventMock;
                client.encryptAndSendToDevice = sendToDeviceMock;

                mockRoom = makeMockRoom([]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
            });

            afterEach(async () => {
                // stop the timers
                await sess!.leaveRoomSession();
            });

            it("creates a key when joining", () => {
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess?.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(1);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    expect.any(Uint8Array),
                    0,
                    "@alice:example.org:AAAAAAA",
                );
            });

            it("sends keys when joining", async () => {
                jest.useFakeTimers();
                try {
                    const eventSentPromise = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });

                    await eventSentPromise;

                    expect(sendEventMock).toHaveBeenCalledWith(
                        expect.stringMatching(".*"),
                        "io.element.call.encryption_keys",
                        {
                            call_id: "",
                            device_id: "AAAAAAA",
                            keys: [makeKey(0, expect.stringMatching(".*"))],
                            sent_ts: Date.now(),
                        },
                    );
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("does not send key if join called when already joined", async () => {
                const sentStateEvent = new Promise((resolve) => {
                    sendStateEventMock = jest.fn(resolve);
                });
                client.sendStateEvent = sendStateEventMock;
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                await sentStateEvent;
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                expect(client.sendEvent).toHaveBeenCalledTimes(1);
                expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                expect(client.sendEvent).toHaveBeenCalledTimes(1);
                expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
            });

            it("retries key sends", async () => {
                jest.useFakeTimers();
                let firstEventSent = false;

                try {
                    const eventSentPromise = new Promise<{ event_id: string }>((resolve) => {
                        sendEventMock.mockImplementation(() => {
                            if (!firstEventSent) {
                                firstEventSent = true;
                                const e = new Error() as MatrixError;
                                e.data = {};
                                throw e;
                            } else {
                                resolve({ event_id: "id" });
                            }
                        });
                    });

                    sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                    // wait for the encryption event to get sent
                    await jest.advanceTimersByTimeAsync(5000);
                    await eventSentPromise;

                    expect(sendEventMock).toHaveBeenCalledTimes(2);
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("cancels key send event that fail", () => {
                const eventSentinel = {} as unknown as MatrixEvent;

                client.cancelPendingEvent = jest.fn();
                sendEventMock.mockImplementation(() => {
                    const e = new Error() as MatrixError;
                    e.data = {};
                    e.event = eventSentinel;
                    throw e;
                });

                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });

                expect(client.cancelPendingEvent).toHaveBeenCalledWith(eventSentinel);
            });

            it("re-sends key if a new member joins even if a key rotation is in progress", async () => {
                jest.useFakeTimers();
                try {
                    // session with two members
                    const member2 = Object.assign({}, membershipTemplate, {
                        device_id: "BBBBBBB",
                    });
                    const mockRoom = makeMockRoom([membershipTemplate, member2]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                    // joining will trigger an initial key send
                    const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    sess.joinRoomSession([mockFocus], mockFocus, {
                        manageMediaKeys: true,
                        updateEncryptionKeyThrottle: 1000,
                        makeKeyDelay: 3000,
                    });
                    await keysSentPromise1;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    // member2 leaves triggering key rotation
                    mockRoomState(mockRoom, [membershipTemplate]);
                    sess.onRTCSessionMemberUpdate();

                    // member2 re-joins which should trigger an immediate re-send
                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    mockRoomState(mockRoom, [membershipTemplate, member2]);
                    sess.onRTCSessionMemberUpdate();
                    // but, that immediate resend is throttled so we need to wait a bit
                    jest.advanceTimersByTime(1000);
                    const { keys } = await keysSentPromise2;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                    // key index should still be the original: 0
                    expect(keys[0].index).toEqual(0);

                    // check that the key rotation actually happens
                    const keysSentPromise3 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    jest.advanceTimersByTime(2000);
                    const { keys: rotatedKeys } = await keysSentPromise3;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(3);
                    // key index should now be the rotated one: 1
                    expect(rotatedKeys[0].index).toEqual(1);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("re-sends key if a new member joins", async () => {
                jest.useFakeTimers();
                try {
                    const mockRoom = makeMockRoom([membershipTemplate]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                    const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                    await keysSentPromise1;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    sendEventMock.mockClear();
                    jest.advanceTimersByTime(10000);

                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    const onMembershipsChanged = jest.fn();
                    sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

                    const member2 = Object.assign({}, membershipTemplate, {
                        device_id: "BBBBBBB",
                    });

                    mockRoomState(mockRoom, [membershipTemplate, member2]);
                    sess.onRTCSessionMemberUpdate();

                    await keysSentPromise2;

                    expect(sendEventMock).toHaveBeenCalled();
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("does not re-send key if memberships stays same", async () => {
                jest.useFakeTimers();
                try {
                    const keysSentPromise1 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    const member1 = membershipTemplate;
                    const member2 = Object.assign({}, membershipTemplate, {
                        device_id: "BBBBBBB",
                    });

                    const mockRoom = makeMockRoom([member1, member2]);
                    mockRoomState(mockRoom, [member1, member2]);

                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                    sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });

                    await keysSentPromise1;

                    // make sure an encryption key was sent
                    expect(sendEventMock).toHaveBeenCalledWith(
                        expect.stringMatching(".*"),
                        "io.element.call.encryption_keys",
                        {
                            call_id: "",
                            device_id: "AAAAAAA",
                            keys: [makeKey(0, expect.stringMatching(".*"))],
                            sent_ts: Date.now(),
                        },
                    );
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    sendEventMock.mockClear();

                    // these should be a no-op:
                    sess.onRTCSessionMemberUpdate();
                    expect(sendEventMock).toHaveBeenCalledTimes(0);
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("re-sends key if a member changes created_ts", async () => {
                jest.useFakeTimers();
                jest.setSystemTime(1000);
                try {
                    const keysSentPromise1 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    const member1 = { ...membershipTemplate, created_ts: 1000 };
                    const member2 = {
                        ...membershipTemplate,
                        created_ts: 1000,
                        device_id: "BBBBBBB",
                    };

                    const mockRoom = makeMockRoom([member1, member2]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                    sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });

                    await keysSentPromise1;

                    // make sure an encryption key was sent
                    expect(sendEventMock).toHaveBeenCalledWith(
                        expect.stringMatching(".*"),
                        "io.element.call.encryption_keys",
                        {
                            call_id: "",
                            device_id: "AAAAAAA",
                            keys: [makeKey(0, expect.stringMatching(".*"))],
                            sent_ts: Date.now(),
                        },
                    );
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    sendEventMock.mockClear();

                    // this should be a no-op:
                    sess.onRTCSessionMemberUpdate();
                    expect(sendEventMock).toHaveBeenCalledTimes(0);

                    // advance time to avoid key throttling
                    jest.advanceTimersByTime(10000);

                    // update created_ts
                    member2.created_ts = 5000;
                    mockRoomState(mockRoom, [member1, member2]);

                    const keysSentPromise2 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    // this should re-send the key
                    sess.onRTCSessionMemberUpdate();

                    await keysSentPromise2;

                    expect(sendEventMock).toHaveBeenCalledWith(
                        expect.stringMatching(".*"),
                        "io.element.call.encryption_keys",
                        {
                            call_id: "",
                            device_id: "AAAAAAA",
                            keys: [makeKey(0, expect.stringMatching(".*"))],
                            sent_ts: Date.now(),
                        },
                    );
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("rotates key if a member leaves", async () => {
                jest.useFakeTimers();
                try {
                    const KEY_DELAY = 3000;
                    const member2 = Object.assign({}, membershipTemplate, {
                        device_id: "BBBBBBB",
                    });
                    const mockRoom = makeMockRoom([membershipTemplate, member2]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                    const onMyEncryptionKeyChanged = jest.fn();
                    sess.on(
                        MatrixRTCSessionEvent.EncryptionKeyChanged,
                        (_key: Uint8Array, _idx: number, participantId: string) => {
                            if (participantId === `${client.getUserId()}:${client.getDeviceId()}`) {
                                onMyEncryptionKeyChanged();
                            }
                        },
                    );

                    const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true, makeKeyDelay: KEY_DELAY });
                    const sendKeySpy = jest.spyOn((sess as unknown as any).encryptionManager.transport, "sendKey");
                    const firstKeysPayload = await keysSentPromise1;
                    expect(firstKeysPayload.keys).toHaveLength(1);
                    expect(firstKeysPayload.keys[0].index).toEqual(0);
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    sendEventMock.mockClear();

                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    mockRoomState(mockRoom, [membershipTemplate]);
                    sess.onRTCSessionMemberUpdate();

                    jest.advanceTimersByTime(KEY_DELAY);
                    expect(sendKeySpy).toHaveBeenCalledTimes(1);
                    // check that we send the key with index 1 even though the send gets delayed when leaving.
                    // this makes sure we do not use an index that is one too old.
                    expect(sendKeySpy).toHaveBeenLastCalledWith(
                        expect.any(String),
                        1,
                        sess.memberships.map((m) => ({
                            userId: m.sender,
                            deviceId: m.deviceId,
                            membershipTs: m.createdTs(),
                        })),
                    );
                    // fake a condition in which we send another encryption key event.
                    // this could happen do to someone joining the call.
                    (sess as unknown as any).encryptionManager.sendEncryptionKeysEvent();
                    expect(sendKeySpy).toHaveBeenLastCalledWith(
                        expect.any(String),
                        1,
                        sess.memberships.map((m) => ({
                            userId: m.sender,
                            deviceId: m.deviceId,
                            membershipTs: m.createdTs(),
                        })),
                    );
                    jest.advanceTimersByTime(7000);

                    const secondKeysPayload = await keysSentPromise2;

                    expect(secondKeysPayload.keys).toHaveLength(1);
                    expect(secondKeysPayload.keys[0].index).toEqual(1);
                    expect(onMyEncryptionKeyChanged).toHaveBeenCalledTimes(2);
                    // initial, on leave and the fake one we do with: `(sess as unknown as any).encryptionManager.sendEncryptionKeysEvent();`
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(3);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("wraps key index around to 0 when it reaches the maximum", async () => {
                // this should give us keys with index [0...255, 0, 1]
                const membersToTest = 258;
                const members: MembershipData[] = [];
                for (let i = 0; i < membersToTest; i++) {
                    members.push(Object.assign({}, membershipTemplate, { device_id: `DEVICE${i}` }));
                }
                jest.useFakeTimers();
                try {
                    // start with all members
                    const mockRoom = makeMockRoom(members);

                    for (let i = 0; i < membersToTest; i++) {
                        const keysSentPromise = new Promise<EncryptionKeysEventContent>((resolve) => {
                            sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                        });

                        if (i === 0) {
                            // if first time around then set up the session
                            sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                            sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                        } else {
                            // otherwise update the state reducing the membership each time in order to trigger key rotation
                            mockRoomState(mockRoom, members.slice(0, membersToTest - i));
                        }

                        sess!.onRTCSessionMemberUpdate();

                        // advance time to avoid key throttling
                        jest.advanceTimersByTime(10000);

                        const keysPayload = await keysSentPromise;
                        expect(keysPayload.keys).toHaveLength(1);
                        expect(keysPayload.keys[0].index).toEqual(i % 256);
                    }
                } finally {
                    jest.useRealTimers();
                }
            });

            it("doesn't re-send key immediately", async () => {
                const realSetTimeout = setTimeout;
                jest.useFakeTimers();
                try {
                    const mockRoom = makeMockRoom([membershipTemplate]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                    const keysSentPromise1 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                    await keysSentPromise1;

                    sendEventMock.mockClear();
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    const onMembershipsChanged = jest.fn();
                    sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

                    const member2 = Object.assign({}, membershipTemplate, {
                        device_id: "BBBBBBB",
                    });

                    mockRoomState(mockRoom, [membershipTemplate, member2]);
                    sess.onRTCSessionMemberUpdate();

                    await new Promise((resolve) => {
                        realSetTimeout(resolve);
                    });

                    expect(sendEventMock).not.toHaveBeenCalled();
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
                } finally {
                    jest.useRealTimers();
                }
            });

            it("send key as to device", async () => {
                jest.useFakeTimers();
                try {
                    const keySentPromise = new Promise((resolve) => {
                        sendToDeviceMock.mockImplementation(resolve);
                    });

                    const mockRoom = makeMockRoom([membershipTemplate]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                    sess!.joinRoomSession([mockFocus], mockFocus, {
                        manageMediaKeys: true,
                        useExperimentalToDeviceTransport: true,
                    });
                    sess.onRTCSessionMemberUpdate();

                    await keySentPromise;

                    expect(sendToDeviceMock).toHaveBeenCalled();

                    // Access private to test
                    expect(sess["encryptionManager"]).toBeInstanceOf(RTCEncryptionManager);
                } finally {
                    jest.useRealTimers();
                }
            });
        });

        describe("receiving", () => {
            it("collects keys from encryption events", async () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await jest.advanceTimersToNextTimerAsync();
                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();

                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    0,
                    "@bob:example.org:bobsphone",
                );
                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(1);
            });

            it("collects keys at non-zero indices", async () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(4, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await jest.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    4,
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(1);
            });

            it("collects keys by merging", async () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await jest.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    0,
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(1);

                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(4, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await jest.advanceTimersToNextTimerAsync();

                encryptionKeyChangedListener.mockClear();
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(3);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    0,
                    "@bob:example.org:bobsphone",
                );
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    4,
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(2);
            });

            it("ignores older keys at same index", async () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent(
                        "io.element.call.encryption_keys",
                        "@bob:example.org",
                        "1234roomId",
                        {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, encodeBase64(Buffer.from("newer key", "utf-8")))],
                        },
                        2000,
                    ),
                );

                mockRoom.emitTimelineEvent(
                    makeMockEvent(
                        "io.element.call.encryption_keys",
                        "@bob:example.org",
                        "1234roomId",
                        {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, encodeBase64(Buffer.from("newer key", "utf-8")))],
                        },
                        2000,
                    ),
                );
                mockRoom.emitTimelineEvent(
                    makeMockEvent(
                        "io.element.call.encryption_keys",
                        "@bob:example.org",
                        "1234roomId",
                        {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, encodeBase64(Buffer.from("older key", "utf-8")))],
                        },
                        1000,
                    ),
                );
                await jest.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("newer key"),
                    0,
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(3);
            });

            it("key timestamps are treated as monotonic", async () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent(
                        "io.element.call.encryption_keys",
                        "@bob:example.org",
                        "1234roomId",
                        {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, encodeBase64(Buffer.from("older key", "utf-8")))],
                        },
                        1000,
                    ),
                );

                mockRoom.emitTimelineEvent(
                    makeMockEvent(
                        "io.element.call.encryption_keys",
                        "@bob:example.org",
                        "1234roomId",
                        {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, encodeBase64(Buffer.from("second key", "utf-8")))],
                        },
                        1000,
                    ),
                );
                await jest.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("second key"),
                    0,
                    "@bob:example.org:bobsphone",
                );
            });

            it("ignores keys event for the local participant", () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", client.getUserId()!, "1234roomId", {
                        device_id: client.getDeviceId(),
                        call_id: "",
                        keys: [makeKey(4, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );

                const encryptionKeyChangedListener = jest.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(1);

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(0);
            });

            it("tracks total age statistics for collected keys", async () => {
                jest.useFakeTimers();
                try {
                    const mockRoom = makeMockRoom([membershipTemplate]);
                    sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);

                    // defaults to getTs()
                    jest.setSystemTime(1000);
                    sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                    mockRoom.emitTimelineEvent(
                        makeMockEvent(
                            "io.element.call.encryption_keys",
                            "@bob:example.org",
                            "1234roomId",
                            {
                                device_id: "bobsphone",
                                call_id: "",
                                keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                            },
                            0,
                        ),
                    );
                    await jest.advanceTimersToNextTimerAsync();

                    expect(sess!.statistics.totals.roomEventEncryptionKeysReceivedTotalAge).toEqual(1000);

                    jest.setSystemTime(2000);

                    mockRoom.emitTimelineEvent(
                        makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                            sent_ts: 0,
                        }),
                    );
                    await jest.advanceTimersToNextTimerAsync();

                    expect(sess!.statistics.totals.roomEventEncryptionKeysReceivedTotalAge).toEqual(3000);

                    jest.setSystemTime(3000);
                    mockRoom.emitTimelineEvent(
                        makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                            sent_ts: 1000,
                        }),
                    );
                    await jest.advanceTimersToNextTimerAsync();

                    expect(sess!.statistics.totals.roomEventEncryptionKeysReceivedTotalAge).toEqual(5000);
                } finally {
                    jest.useRealTimers();
                }
            });
        });
        describe("read status", () => {
            it("returns the correct probablyLeft status", () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                expect(sess!.probablyLeft).toBe(undefined);

                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                expect(sess!.probablyLeft).toBe(false);

                // Simulate the membership manager believing the user has left
                const accessPrivateFieldsSession = sess as unknown as {
                    membershipManager: { state: { probablyLeft: boolean } };
                };
                accessPrivateFieldsSession.membershipManager.state.probablyLeft = true;
                expect(sess!.probablyLeft).toBe(true);
            });

            it("returns membershipStatus once joinRoomSession got called", () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.sessionForRoom(client, mockRoom, callSession);
                expect(sess!.membershipStatus).toBe(undefined);

                sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                expect(sess!.membershipStatus).toBe(Status.Connecting);
            });
        });
    });
});
