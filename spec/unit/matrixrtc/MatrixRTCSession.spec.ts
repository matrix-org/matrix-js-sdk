/*
Copyright 2023-2026 The Matrix.org Foundation C.I.C.

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

import {
    encodeBase64,
    type EventTimeline,
    EventType,
    MatrixClient,
    type MatrixError,
    type MatrixEvent,
    type Room,
} from "../../../src";
import { KnownMembership } from "../../../src/@types/membership.ts";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "../../../src/matrixrtc/MatrixRTCSession.ts";
import { MembershipManagerEvent } from "../../../src/matrixrtc/IMembershipManager.ts";
import { Status, type EncryptionKeysEventContent } from "../../../src/matrixrtc/types.ts";
import {
    makeMockEvent,
    makeMockRoom,
    sessionMembershipTemplate,
    makeKey,
    type MembershipData,
    mockRoomState,
    mockRTCEvent,
    owmMemberIdentity,
    rtcMembershipTemplate,
} from "./mocks.ts";
import { RTCEncryptionManager } from "../../../src/matrixrtc/RTCEncryptionManager.ts";
import { RoomStickyEventsEvent, type StickyMatrixEvent } from "../../../src/models/room-sticky-events.ts";
import { StickyEventMembershipManager } from "../../../src/matrixrtc/MembershipManager.ts";
import { type CallMembershipIdentityParts } from "../../../src/matrixrtc/EncryptionManager.ts";
import { flushPromises } from "../../test-utils/flushPromises.ts";
import {
    computeRtcIdentityRaw,
    type RtcMembershipData,
    type SessionMembershipData,
} from "../../../src/matrixrtc/membership/index.ts";

const mockFocus = { type: "mock" };

const textEncoder = new TextEncoder();

const callSession = { id: "", application: "m.call" };

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
        vi.useRealTimers();
        vi.restoreAllMocks();
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
            createWithDefaults: false,
        },
        {
            listenForStickyEvents: true,
            listenForMemberStateEvents: false,
            testCreateSticky: true,
            createWithDefaults: false,
        },
    ])(
        "roomsessionForSlot listenForSticky=$listenForStickyEvents listenForMemberStateEvents=$listenForMemberStateEvents testCreateSticky=$testCreateSticky",
        (testConfig) => {
            function generateMembership(
                opts: { type: string; callId?: string; createdTs?: number; expires?: number; deviceId?: string } = {
                    type: "m.call",
                },
            ): MembershipData {
                if (testConfig.testCreateSticky) {
                    // Ignoring createdTs, expires which are legacy
                    return {
                        ...rtcMembershipTemplate,
                        member: {
                            ...rtcMembershipTemplate.member,
                            claimed_device_id: opts.deviceId ?? rtcMembershipTemplate.member.claimed_device_id,
                        },
                        slot_id: opts.callId ? `${opts.type}#${opts.callId}` : rtcMembershipTemplate.slot_id,
                        application: {
                            ...rtcMembershipTemplate.application,
                            type: opts.type,
                        },
                    } satisfies RtcMembershipData & { user_id: string };
                }

                return {
                    ...sessionMembershipTemplate,
                    application: opts.type,
                    device_id: opts.deviceId ?? sessionMembershipTemplate.device_id,
                    call_id: opts.callId ?? sessionMembershipTemplate.call_id,
                    created_ts: opts.createdTs,
                    expires: opts.expires,
                } satisfies SessionMembershipData & { user_id: string };
            }

            it(`will ${testConfig.listenForMemberStateEvents ? "" : "NOT"} throw if the room does not have any state stored`, async () => {
                const mockRoom = makeMockRoom([generateMembership()], testConfig.testCreateSticky);
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
                const mockRoom = makeMockRoom([generateMembership()], testConfig.testCreateSticky);

                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships.length).toEqual(1);
                expect(sess?.memberships[0].slotDescription.id).toEqual("");
                expect(sess?.memberships[0].scope).toEqual(testConfig.testCreateSticky ? undefined : "m.room");
                expect(sess?.memberships[0].applicationData).toEqual({ type: "m.call" });
                expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
                expect(sess?.memberships[0].isExpired()).toEqual(false);
                expect(sess?.slotDescription.id).toEqual("");
            });

            it("ignores memberships where application is not m.call", () => {
                const testMembership = Object.assign({}, sessionMembershipTemplate, {
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
                const testMembership = Object.assign({}, sessionMembershipTemplate, {
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

            it("ignores expired memberships events if legacy session", async () => {
                vi.useFakeTimers();
                const expiredMembership = generateMembership({ type: "m.call", expires: 1000, deviceId: "EXPIRED" });
                const mockRoom = makeMockRoom([generateMembership(), expiredMembership], testConfig.testCreateSticky);

                vi.advanceTimersByTime(2000);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                )!;
                const membershipChanged = new Promise((r) => sess!.once(MatrixRTCSessionEvent.MembershipsChanged, r));
                await membershipChanged;
                expect(sess?.memberships.length).toEqual(testConfig.testCreateSticky ? 2 : 1);
                expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            });

            it("ignores memberships events of members not in the room", () => {
                const mockRoom = makeMockRoom([generateMembership()], testConfig.testCreateSticky);
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
                const mockRoom = makeMockRoom(
                    [{ ...sessionMembershipTemplate, user_id: "" }],
                    testConfig.testCreateSticky,
                );
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
                const expiredMembership = generateMembership({ type: "m.call", createdTs: 500, expires: 1000 });
                const mockRoom = makeMockRoom([expiredMembership], testConfig.testCreateSticky);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships[0].getAbsoluteExpiry()).toEqual(
                    testConfig.testCreateSticky ? undefined : 1500,
                );
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
                const testMembership = Object.assign({}, sessionMembershipTemplate);
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
                const testMembership = Object.assign({}, sessionMembershipTemplate);
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
                const mockRoom = makeMockRoom([generateMembership()], testConfig.testCreateSticky);
                sess = MatrixRTCSession.sessionForSlot(
                    client,
                    mockRoom,
                    callSession,
                    testConfig.createWithDefaults ? undefined : testConfig,
                );
                await flushPromises();
                expect(sess?.memberships.length).toEqual(1);
                // Backend identity is expected to not be hashed with a legacy (session) membership
                expect(sess?.memberships[0].rtcBackendIdentity).toEqual(
                    testConfig.testCreateSticky
                        ? await computeRtcIdentityRaw(
                              rtcMembershipTemplate.member.claimed_user_id,
                              rtcMembershipTemplate.member.claimed_device_id,
                              rtcMembershipTemplate.member.id,
                          )
                        : "@mock:user.example:AAAAAAA",
                );
            });
        },
    );

    describe("roomsessionForSlot combined state", () => {
        it("perfers sticky events when both membership and sticky events appear for the same user", async () => {
            // Create a room with identical member state and sticky state for the same user.
            const mockRoom = makeMockRoom([rtcMembershipTemplate]);
            mockRoom._unstable_getStickyEvents.mockImplementation(() => {
                const ev = mockRTCEvent(
                    {
                        ...rtcMembershipTemplate,
                        msc4354_sticky_key: `_${rtcMembershipTemplate.user_id}_${rtcMembershipTemplate.member.claimed_device_id}`,
                    },
                    mockRoom.roomId,
                    5000,
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
            expect(sess?.memberships[0].scope).toEqual(undefined);
            expect(sess?.memberships[0].application).toEqual("m.call");
            expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            expect(sess?.memberships[0].isExpired()).toEqual(false);
            expect(sess?.slotDescription.id).toEqual("");
        });
        it("combines sticky and membership events when both exist", async () => {
            // Create a room with identical member state and sticky state for the same user.
            const mockRoom = makeMockRoom([sessionMembershipTemplate]);
            const stickyUserId = "@stickyev:user.example";
            mockRoom._unstable_getStickyEvents.mockImplementation(() => {
                const ev = mockRTCEvent(
                    {
                        ...rtcMembershipTemplate,
                        member: {
                            ...rtcMembershipTemplate.member,
                            claimed_user_id: stickyUserId,
                        },
                        user_id: stickyUserId,
                        msc4354_sticky_key: `_${stickyUserId}_${rtcMembershipTemplate.member.claimed_device_id}`,
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
            expect(memberships[0].scope).toEqual(undefined);
            expect(memberships[0].applicationData).toEqual({ type: "m.call" });
            expect(memberships[0].deviceId).toEqual("AAAAAAA");
            expect(memberships[0].isExpired()).toEqual(false);

            // Then state
            expect(memberships[1].sender).toEqual(sessionMembershipTemplate.user_id);

            expect(sess?.slotDescription.id).toEqual("");
        });
        it("handles an incoming sticky event to an existing session", async () => {
            const mockRoom = makeMockRoom([sessionMembershipTemplate], false);
            const stickyUserId = "@stickyev:user.example";

            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession, {
                listenForStickyEvents: true,
                listenForMemberStateEvents: true,
            });
            await flushPromises();
            expect(sess.memberships.length).toEqual(1);
            const stickyEv = mockRTCEvent(
                {
                    ...rtcMembershipTemplate,
                    member: {
                        ...rtcMembershipTemplate.member,
                        claimed_user_id: stickyUserId,
                    },
                    user_id: stickyUserId,
                    msc4354_sticky_key: `_${stickyUserId}_${rtcMembershipTemplate.member.claimed_device_id}`,
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
                Object.assign({}, sessionMembershipTemplate, { device_id: "foo", created_ts: 3000 }),
                Object.assign({}, sessionMembershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, sessionMembershipTemplate, { device_id: "bar", created_ts: 2000 }),
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
                Object.assign({}, sessionMembershipTemplate, { "m.call.intent": intentA }),
                Object.assign({}, sessionMembershipTemplate, { "m.call.intent": intentB }),
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
                Object.assign({}, sessionMembershipTemplate, {
                    device_id: "foo",
                    created_ts: 500,
                    foci_preferred: [firstPreferredFocus],
                }),
                Object.assign({}, sessionMembershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, sessionMembershipTemplate, { device_id: "bar", created_ts: 2000 }),
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
                Object.assign({}, sessionMembershipTemplate, {
                    device_id: "foo",
                    created_ts: 500,
                    foci_preferred: [firstPreferredFocus],
                }),
                Object.assign({}, sessionMembershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, sessionMembershipTemplate, { device_id: "bar", created_ts: 2000 }),
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
            sendEventMock
                .mockResolvedValueOnce({ event_id: "legacy-evt" })
                .mockResolvedValueOnce({ event_id: "new-evt" });
            const didSendEventFn = vi.fn();
            sess!.once(MatrixRTCSessionEvent.DidSendCallNotification, didSendEventFn);
            // Create an additional listener to create a promise that resolves after the emission.
            const didSendNotification = new Promise((resolve) => {
                sess!.once(MatrixRTCSessionEvent.DidSendCallNotification, resolve);
            });

            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            mockRoomState(mockRoom, [{ ...sessionMembershipTemplate, user_id: client.getUserId()! }]);
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
                    ...sessionMembershipTemplate,
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
            mockRoomState(mockRoom, [sessionMembershipTemplate]);
            await sess!._onRTCSessionMemberUpdate();

            // Simulate a join, including the update to the room state
            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { notificationType: "ring" });
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 5000))]);
            mockRoomState(mockRoom, [
                sessionMembershipTemplate,
                { ...sessionMembershipTemplate, user_id: client.getUserId()! },
            ]);
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
            mockRoomState(mockRoom, [sessionMembershipTemplate]);
            await sess!._onRTCSessionMemberUpdate();
            mockRoomState(mockRoom, [
                sessionMembershipTemplate,
                { ...sessionMembershipTemplate, user_id: client.getUserId()! },
            ]);
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
            const mockRoom = makeMockRoom([sessionMembershipTemplate]);
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
        // TODO make this test suit only test the encryption manager. And mock the transport directly not the session.
        describe("sending", () => {
            let mockRoom: Room;
            let sendStateEventMock: Mock;
            let sendDelayedStateMock: Mock;
            let sendEventMock: Mock;
            let sendToDeviceMock: Mock;

            beforeEach(() => {
                sendStateEventMock = vi.fn().mockResolvedValue({ event_id: "id" });
                sendDelayedStateMock = vi.fn().mockResolvedValue({ event_id: "id" });
                sendEventMock = vi.fn().mockResolvedValue({ event_id: "id" });
                sendToDeviceMock = vi.fn();
                client.sendStateEvent = sendStateEventMock;
                client._unstable_sendDelayedStateEvent = sendDelayedStateMock;
                client.sendEvent = sendEventMock;
                client.encryptAndSendToDevice = sendToDeviceMock;

                mockRoom = makeMockRoom([]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                // await new Promise((resolve) => sess!.once(MatrixRTCSessionEvent.MembershipsChanged, resolve));
            });

            afterEach(async () => {
                // stop the timers
                await sess!.leaveRoomSession();
                // vi.restoreAllMocks();
            });

            it("creates a key when joining", () => {
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess?.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(1);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    expect.any(Uint8Array),
                    0,
                    {
                        deviceId: "AAAAAAA",
                        memberId: "@alice:example.org:AAAAAAA",
                        userId: "@alice:example.org",
                    },
                    "@alice:example.org:AAAAAAA",
                );
            });

            it("sends keys when joining", async () => {
                vi.useFakeTimers();
                try {
                    const eventSentPromise = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });

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
                    vi.useRealTimers();
                }
            });

            it("does not send key if join called when already joined", async () => {
                const sentStateEvent = new Promise((resolve) => {
                    sendStateEventMock = vi.fn(resolve);
                });
                client.sendStateEvent = sendStateEventMock;
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                await sentStateEvent;
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                expect(client.sendEvent).toHaveBeenCalledTimes(1);
                expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                expect(client.sendEvent).toHaveBeenCalledTimes(1);
                expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
            });

            it("retries key sends", async () => {
                vi.useFakeTimers();
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

                    sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                    // wait for the encryption event to get sent
                    await vi.advanceTimersByTimeAsync(5000);
                    await eventSentPromise;

                    expect(sendEventMock).toHaveBeenCalledTimes(2);
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                } finally {
                    vi.useRealTimers();
                }
            });

            it("cancels key send event that fail", () => {
                const eventSentinel = {} as unknown as MatrixEvent;

                client.cancelPendingEvent = vi.fn();
                sendEventMock.mockImplementation(() => {
                    const e = new Error() as MatrixError;
                    e.data = {};
                    e.event = eventSentinel;
                    throw e;
                });

                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });

                expect(client.cancelPendingEvent).toHaveBeenCalledWith(eventSentinel);
            });

            it("re-sends key if a new member joins even if a key rotation is in progress", async () => {
                vi.useFakeTimers();
                try {
                    // session with two members
                    const member2 = Object.assign({}, sessionMembershipTemplate, {
                        device_id: "BBBBBBB",
                    });
                    const mockRoom = makeMockRoom([sessionMembershipTemplate, member2]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                    await flushPromises();
                    // joining will trigger an initial key send
                    const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, {
                        manageMediaKeys: true,
                        updateEncryptionKeyThrottle: 1000,
                        makeKeyDelay: 3000,
                    });
                    await keysSentPromise1;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    // member2 leaves triggering key rotation
                    mockRoomState(mockRoom, [sessionMembershipTemplate]);
                    await sess._onRTCSessionMemberUpdate();

                    // member2 re-joins which should trigger an immediate re-send
                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    mockRoomState(mockRoom, [sessionMembershipTemplate, member2]);
                    await sess._onRTCSessionMemberUpdate();
                    // but, that immediate resend is throttled so we need to wait a bit
                    vi.advanceTimersByTime(1000);
                    const { keys } = await keysSentPromise2;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                    // key index should still be the original: 0
                    expect(keys[0].index).toEqual(0);

                    // check that the key rotation actually happens
                    const keysSentPromise3 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    vi.advanceTimersByTime(2000);
                    const { keys: rotatedKeys } = await keysSentPromise3;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(3);
                    // key index should now be the rotated one: 1
                    expect(rotatedKeys[0].index).toEqual(1);
                } finally {
                    vi.useRealTimers();
                }
            });

            it("re-sends key if a new member joins", async () => {
                vi.useFakeTimers();
                try {
                    const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);

                    const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                    await keysSentPromise1;
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    sendEventMock.mockClear();
                    vi.advanceTimersByTime(10000);

                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    const onMembershipsChanged = vi.fn();
                    sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

                    const member2 = Object.assign({}, sessionMembershipTemplate, {
                        device_id: "BBBBBBB",
                    });

                    mockRoomState(mockRoom, [sessionMembershipTemplate, member2]);
                    await sess._onRTCSessionMemberUpdate();

                    await keysSentPromise2;

                    expect(sendEventMock).toHaveBeenCalled();
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(2);
                } finally {
                    vi.useRealTimers();
                }
            });

            it("does not re-send key if memberships stays same", async () => {
                vi.useFakeTimers();
                try {
                    const keysSentPromise1 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    const member1 = sessionMembershipTemplate;
                    const member2 = Object.assign({}, sessionMembershipTemplate, {
                        device_id: "BBBBBBB",
                    });

                    const mockRoom = makeMockRoom([member1, member2]);
                    mockRoomState(mockRoom, [member1, member2]);

                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                    sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });

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
                    await sess._onRTCSessionMemberUpdate();
                    expect(sendEventMock).toHaveBeenCalledTimes(0);
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
                } finally {
                    vi.useRealTimers();
                }
            });

            it("re-sends key if a member changes created_ts", async () => {
                vi.useFakeTimers();
                vi.setSystemTime(1000);
                try {
                    const keysSentPromise1 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    const member1 = { ...sessionMembershipTemplate, created_ts: 1000 };
                    const member2 = {
                        ...sessionMembershipTemplate,
                        created_ts: 1000,
                        device_id: "BBBBBBB",
                    };

                    const mockRoom = makeMockRoom([member1, member2]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                    await flushPromises();
                    sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });

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
                    await sess._onRTCSessionMemberUpdate();
                    expect(sendEventMock).toHaveBeenCalledTimes(0);

                    // advance time to avoid key throttling
                    vi.advanceTimersByTime(10000);

                    // update created_ts
                    member2.created_ts = 5000;
                    mockRoomState(mockRoom, [member1, member2]);

                    const keysSentPromise2 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    // this should re-send the key
                    await sess._onRTCSessionMemberUpdate();

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
                    vi.useRealTimers();
                }
            });

            it("rotates key if a member leaves", async () => {
                vi.useFakeTimers();
                try {
                    const KEY_DELAY = 3000;
                    const member2 = Object.assign({}, sessionMembershipTemplate, {
                        device_id: "BBBBBBB",
                    });
                    const mockRoom = makeMockRoom([sessionMembershipTemplate, member2]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                    await flushPromises();
                    const onMyEncryptionKeyChanged = vi.fn();
                    sess.on(
                        MatrixRTCSessionEvent.EncryptionKeyChanged,
                        (_key: Uint8Array, _idx: number, membership: CallMembershipIdentityParts) => {
                            if (
                                membership.userId === client.getUserId() &&
                                membership.deviceId === client.getDeviceId()
                            ) {
                                onMyEncryptionKeyChanged();
                            }
                        },
                    );

                    const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, {
                        manageMediaKeys: true,
                        makeKeyDelay: KEY_DELAY,
                    });
                    const sendKeySpy = vi.spyOn((sess as unknown as any).encryptionManager.transport, "sendKey");
                    const firstKeysPayload = await keysSentPromise1;
                    expect(firstKeysPayload.keys).toHaveLength(1);
                    expect(firstKeysPayload.keys[0].index).toEqual(0);
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    sendEventMock.mockClear();

                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });

                    mockRoomState(mockRoom, [sessionMembershipTemplate]);
                    await sess._onRTCSessionMemberUpdate();

                    vi.advanceTimersByTime(KEY_DELAY);
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
                    vi.advanceTimersByTime(7000);

                    const secondKeysPayload = await keysSentPromise2;

                    expect(secondKeysPayload.keys).toHaveLength(1);
                    expect(secondKeysPayload.keys[0].index).toEqual(1);
                    expect(onMyEncryptionKeyChanged).toHaveBeenCalledTimes(2);
                    // initial, on leave and the fake one we do with: `(sess as unknown as any).encryptionManager.sendEncryptionKeysEvent();`
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(3);
                } finally {
                    vi.useRealTimers();
                }
            });

            it("wraps key index around to 0 when it reaches the maximum", { timeout: 15000 }, async () => {
                // this should give us keys with index [0...255, 0, 1]
                const membersToTest = 258;
                const members: MembershipData[] = [];
                for (let i = 0; i < membersToTest; i++) {
                    members.push(Object.assign({}, sessionMembershipTemplate, { device_id: `DEVICE${i}` }));
                }
                vi.useFakeTimers();
                try {
                    // start with all members
                    const mockRoom = makeMockRoom(members);

                    for (let i = 0; i < membersToTest; i++) {
                        const keysSentPromise = new Promise<EncryptionKeysEventContent>((resolve) => {
                            sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                        });

                        if (i === 0) {
                            // if first time around then set up the session
                            sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                            await flushPromises();
                            sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, {
                                manageMediaKeys: true,
                            });
                        } else {
                            // otherwise update the state reducing the membership each time in order to trigger key rotation
                            mockRoomState(mockRoom, members.slice(0, membersToTest - i));
                        }

                        await sess!._onRTCSessionMemberUpdate();

                        // advance time to avoid key throttling
                        vi.advanceTimersByTime(10000);

                        const keysPayload = await keysSentPromise;
                        expect(keysPayload.keys).toHaveLength(1);
                        expect(keysPayload.keys[0].index).toEqual(i % 256);
                    }
                } finally {
                    vi.useRealTimers();
                }
            });

            it("doesn't re-send key immediately", async () => {
                const realSetTimeout = setTimeout;
                vi.useFakeTimers();
                try {
                    const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                    await flushPromises();

                    const keysSentPromise1 = new Promise((resolve) => {
                        sendEventMock.mockImplementation(resolve);
                    });

                    sess.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                    await keysSentPromise1;

                    sendEventMock.mockClear();
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);

                    const onMembershipsChanged = vi.fn();
                    sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

                    const member2 = Object.assign({}, sessionMembershipTemplate, {
                        device_id: "BBBBBBB",
                    });

                    mockRoomState(mockRoom, [sessionMembershipTemplate, member2]);
                    await sess._onRTCSessionMemberUpdate();

                    await new Promise((resolve) => {
                        realSetTimeout(resolve);
                    });

                    expect(sendEventMock).not.toHaveBeenCalled();
                    expect(sess!.statistics.counters.roomEventEncryptionKeysSent).toEqual(1);
                } finally {
                    vi.useRealTimers();
                }
            });

            it("send key as to device", async () => {
                vi.useFakeTimers();
                try {
                    const keySentPromise = new Promise((resolve) => {
                        sendToDeviceMock.mockImplementation(resolve);
                    });

                    const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                    await flushPromises();
                    sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, {
                        manageMediaKeys: true,
                        useExperimentalToDeviceTransport: true,
                    });
                    await sess._onRTCSessionMemberUpdate();

                    await keySentPromise;

                    expect(sendToDeviceMock).toHaveBeenCalled();

                    // Access private to test
                    expect(sess["encryptionManager"]).toBeInstanceOf(RTCEncryptionManager);
                } finally {
                    vi.useRealTimers();
                }
            });
        });

        describe("receiving", () => {
            beforeEach(() => {
                vi.useFakeTimers();
            });
            afterEach(() => {
                vi.useRealTimers();
            });

            it("collects keys from encryption events", async () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                await flushPromises();
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await vi.advanceTimersToNextTimerAsync();
                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();

                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    0,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
                    "@bob:example.org:bobsphone",
                );
                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(1);
            });

            it("collects keys at non-zero indices", async () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                await flushPromises();
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(4, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await vi.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    4,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(1);
            });

            it("collects keys by merging", async () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                        device_id: "bobsphone",
                        call_id: "",
                        keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );
                await vi.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    0,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
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
                await vi.advanceTimersToNextTimerAsync();

                encryptionKeyChangedListener.mockClear();
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(3);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    0,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
                    "@bob:example.org:bobsphone",
                );
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("this is the key"),
                    4,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(2);
            });

            it("ignores older keys at same index", async () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
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
                await vi.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("newer key"),
                    0,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
                    "@bob:example.org:bobsphone",
                );

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(3);
            });

            it("key timestamps are treated as monotonic", async () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
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
                await vi.advanceTimersToNextTimerAsync();

                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(2);
                expect(encryptionKeyChangedListener).toHaveBeenCalledWith(
                    textEncoder.encode("second key"),
                    0,
                    {
                        deviceId: "bobsphone",
                        memberId: "@bob:example.org:bobsphone",
                        userId: "@bob:example.org",
                    },
                    "@bob:example.org:bobsphone",
                );
            });

            it("ignores keys event for the local participant", () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);

                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                mockRoom.emitTimelineEvent(
                    makeMockEvent("io.element.call.encryption_keys", client.getUserId()!, "1234roomId", {
                        device_id: client.getDeviceId(),
                        call_id: "",
                        keys: [makeKey(4, "dGhpcyBpcyB0aGUga2V5")],
                    }),
                );

                const encryptionKeyChangedListener = vi.fn();
                sess!.on(MatrixRTCSessionEvent.EncryptionKeyChanged, encryptionKeyChangedListener);
                sess!.reemitEncryptionKeys();
                expect(encryptionKeyChangedListener).toHaveBeenCalledTimes(1);

                expect(sess!.statistics.counters.roomEventEncryptionKeysReceived).toEqual(0);
            });

            it("tracks total age statistics for collected keys", async () => {
                vi.useFakeTimers();
                try {
                    const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                    sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);

                    // defaults to getTs()
                    vi.setSystemTime(1000);
                    sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
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
                    await vi.advanceTimersToNextTimerAsync();

                    expect(sess!.statistics.totals.roomEventEncryptionKeysReceivedTotalAge).toEqual(1000);

                    vi.setSystemTime(2000);

                    mockRoom.emitTimelineEvent(
                        makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                            sent_ts: 0,
                        }),
                    );
                    await vi.advanceTimersToNextTimerAsync();

                    expect(sess!.statistics.totals.roomEventEncryptionKeysReceivedTotalAge).toEqual(3000);

                    vi.setSystemTime(3000);
                    mockRoom.emitTimelineEvent(
                        makeMockEvent("io.element.call.encryption_keys", "@bob:example.org", "1234roomId", {
                            device_id: "bobsphone",
                            call_id: "",
                            keys: [makeKey(0, "dGhpcyBpcyB0aGUga2V5")],
                            sent_ts: 1000,
                        }),
                    );
                    await vi.advanceTimersToNextTimerAsync();

                    expect(sess!.statistics.totals.roomEventEncryptionKeysReceivedTotalAge).toEqual(5000);
                } finally {
                    vi.useRealTimers();
                }
            });
        });
        describe("read status", () => {
            it("returns the correct probablyLeft status", () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                expect(sess!.probablyLeft).toBe(undefined);

                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                expect(sess!.probablyLeft).toBe(false);

                // Simulate the membership manager believing the user has left
                const accessPrivateFieldsSession = sess as unknown as {
                    membershipManager: { state: { probablyLeft: boolean } };
                };
                accessPrivateFieldsSession.membershipManager.state.probablyLeft = true;
                expect(sess!.probablyLeft).toBe(true);
            });

            it("returns membershipStatus once joinRTCSession got called", () => {
                const mockRoom = makeMockRoom([sessionMembershipTemplate]);
                sess = MatrixRTCSession.sessionForSlot(client, mockRoom, callSession);
                expect(sess!.membershipStatus).toBe(undefined);

                sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus, { manageMediaKeys: true });
                expect(sess!.membershipStatus).toBe(Status.Connecting);
            });
        });
        it("reemits membershipManager events", () => {
            sess = MatrixRTCSession.sessionForSlot(client, makeMockRoom([sessionMembershipTemplate]), callSession);
            const delayIdChanged = vi.fn();
            sess.on(MembershipManagerEvent.DelayIdChanged, delayIdChanged);
            const statusChanged = vi.fn();
            sess.on(MembershipManagerEvent.StatusChanged, statusChanged);
            const probablyLeftChanged = vi.fn();
            sess.on(MembershipManagerEvent.ProbablyLeft, probablyLeftChanged);

            sess!.joinRTCSession(owmMemberIdentity, [mockFocus], mockFocus);

            const membershipManager = sess["membershipManager"]!;
            membershipManager.emit(MembershipManagerEvent.DelayIdChanged, "newDelayId");
            membershipManager.emit(MembershipManagerEvent.StatusChanged, Status.Connected, Status.Disconnected);
            membershipManager.emit(MembershipManagerEvent.ProbablyLeft, false);
            expect(delayIdChanged).toHaveBeenCalledWith("newDelayId", membershipManager);
            expect(statusChanged).toHaveBeenCalledWith(Status.Connected, Status.Disconnected, membershipManager);
            expect(probablyLeftChanged).toHaveBeenCalledWith(false, membershipManager);
        });
    });
});
