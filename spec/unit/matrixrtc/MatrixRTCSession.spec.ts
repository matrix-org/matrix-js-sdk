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

import { encodeBase64, EventType, MatrixClient, type MatrixError, type MatrixEvent, type Room } from "../../../src";
import { KnownMembership } from "../../../src/@types/membership";
import { DEFAULT_EXPIRE_DURATION, type SessionMembershipData } from "../../../src/matrixrtc/CallMembership";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "../../../src/matrixrtc/MatrixRTCSession";
import { type EncryptionKeysEventContent } from "../../../src/matrixrtc/types";
import { secureRandomString } from "../../../src/randomstring";
import { makeMockEvent, makeMockRoom, makeMockRoomState, membershipTemplate, makeKey } from "./mocks";

const mockFocus = { type: "mock" };

const textEncoder = new TextEncoder();

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

    describe("roomSessionForRoom", () => {
        it("creates a room-scoped session from room state", () => {
            const mockRoom = makeMockRoom(membershipTemplate);

            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess?.memberships.length).toEqual(1);
            expect(sess?.memberships[0].callId).toEqual("");
            expect(sess?.memberships[0].scope).toEqual("m.room");
            expect(sess?.memberships[0].application).toEqual("m.call");
            expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            expect(sess?.memberships[0].isExpired()).toEqual(false);
            expect(sess?.callId).toEqual("");
        });

        it("ignores expired memberships events", () => {
            jest.useFakeTimers();
            const expiredMembership = Object.assign({}, membershipTemplate);
            expiredMembership.expires = 1000;
            expiredMembership.device_id = "EXPIRED";
            const mockRoom = makeMockRoom([membershipTemplate, expiredMembership]);

            jest.advanceTimersByTime(2000);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess?.memberships.length).toEqual(1);
            expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
            jest.useRealTimers();
        });

        it("ignores memberships events of members not in the room", () => {
            const mockRoom = makeMockRoom(membershipTemplate);
            mockRoom.hasMembershipState = (state) => state === KnownMembership.Join;
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess?.memberships.length).toEqual(0);
        });

        it("honours created_ts", () => {
            jest.useFakeTimers();
            jest.setSystemTime(500);
            const expiredMembership = Object.assign({}, membershipTemplate);
            expiredMembership.created_ts = 500;
            expiredMembership.expires = 1000;
            const mockRoom = makeMockRoom([expiredMembership]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess?.memberships[0].getAbsoluteExpiry()).toEqual(1500);
            jest.useRealTimers();
        });

        it("returns empty session if no membership events are present", () => {
            const mockRoom = makeMockRoom([]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess?.memberships).toHaveLength(0);
        });

        it("safely ignores events with no memberships section", () => {
            const roomId = secureRandomString(8);
            const event = {
                getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                getContent: jest.fn().mockReturnValue({}),
                getSender: jest.fn().mockReturnValue("@mock:user.example"),
                getTs: jest.fn().mockReturnValue(1000),
                getLocalAge: jest.fn().mockReturnValue(0),
            };
            const mockRoom = {
                ...makeMockRoom([]),
                roomId,
                getLiveTimeline: jest.fn().mockReturnValue({
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
                }),
            };
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom as unknown as Room);
            expect(sess.memberships).toHaveLength(0);
        });

        it("safely ignores events with junk memberships section", () => {
            const roomId = secureRandomString(8);
            const event = {
                getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                getContent: jest.fn().mockReturnValue({ memberships: ["i am a fish"] }),
                getSender: jest.fn().mockReturnValue("@mock:user.example"),
                getTs: jest.fn().mockReturnValue(1000),
                getLocalAge: jest.fn().mockReturnValue(0),
            };
            const mockRoom = {
                ...makeMockRoom([]),
                roomId,
                getLiveTimeline: jest.fn().mockReturnValue({
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
                }),
            };
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom as unknown as Room);
            expect(sess.memberships).toHaveLength(0);
        });

        it("ignores memberships with no device_id", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            (testMembership.device_id as string | undefined) = undefined;
            const mockRoom = makeMockRoom([testMembership]);
            const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess.memberships).toHaveLength(0);
        });

        it("ignores memberships with no call_id", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            (testMembership.call_id as string | undefined) = undefined;
            const mockRoom = makeMockRoom([testMembership]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess.memberships).toHaveLength(0);
        });

        it("ignores memberships with no scope", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            (testMembership.scope as string | undefined) = undefined;
            const mockRoom = makeMockRoom([testMembership]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess.memberships).toHaveLength(0);
        });

        it("ignores anything that's not a room-scoped call (for now)", () => {
            const testMembership = Object.assign({}, membershipTemplate);
            testMembership.scope = "m.user";
            const mockRoom = makeMockRoom([testMembership]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess.memberships).toHaveLength(0);
        });
    });

    describe("updateCallMembershipEvent", () => {
        const mockFocus = { type: "livekit", livekit_service_url: "https://test.org" };
        const joinSessionConfig = {};

        const sessionMembershipData: SessionMembershipData = {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: "AAAAAAA_session",
            focus_active: mockFocus,
            foci_preferred: [mockFocus],
        };

        let sendStateEventMock: jest.Mock;
        let sendDelayedStateMock: jest.Mock;

        let sentStateEvent: Promise<void>;
        let sentDelayedState: Promise<void>;

        beforeEach(() => {
            sentStateEvent = new Promise((resolve) => {
                sendStateEventMock = jest.fn(resolve);
            });
            sentDelayedState = new Promise((resolve) => {
                sendDelayedStateMock = jest.fn(() => {
                    resolve();
                    return {
                        delay_id: "id",
                    };
                });
            });
            client.sendStateEvent = sendStateEventMock;
            client._unstable_sendDelayedStateEvent = sendDelayedStateMock;
        });

        async function testSession(membershipData: SessionMembershipData): Promise<void> {
            sess = MatrixRTCSession.roomSessionForRoom(client, makeMockRoom(membershipData));

            sess.joinRoomSession([mockFocus], mockFocus, joinSessionConfig);
            await Promise.race([sentStateEvent, new Promise((resolve) => setTimeout(resolve, 500))]);

            expect(sendStateEventMock).toHaveBeenCalledTimes(1);

            await Promise.race([sentDelayedState, new Promise((resolve) => setTimeout(resolve, 500))]);
            expect(sendDelayedStateMock).toHaveBeenCalledTimes(1);
        }

        it("sends events", async () => {
            await testSession(sessionMembershipData);
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

            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

            sess.joinRoomSession([{ type: "livekit", livekit_service_url: "htts://test.org" }], {
                type: "livekit",
                focus_selection: "oldest_membership",
            });
            expect(sess.getActiveFocus()).toBe(firstPreferredFocus);
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

            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

            sess.joinRoomSession([{ type: "livekit", livekit_service_url: "htts://test.org" }], {
                type: "livekit",
                focus_selection: "unknown",
            });
            expect(sess.getActiveFocus()).toBe(undefined);
        });
    });

    describe("joining", () => {
        let mockRoom: Room;
        let sendStateEventMock: jest.Mock;
        let sendDelayedStateMock: jest.Mock;
        let sendEventMock: jest.Mock;

        let sentStateEvent: Promise<void>;
        let sentDelayedState: Promise<void>;

        beforeEach(() => {
            sentStateEvent = new Promise((resolve) => {
                sendStateEventMock = jest.fn(resolve);
            });
            sentDelayedState = new Promise((resolve) => {
                sendDelayedStateMock = jest.fn(() => {
                    resolve();
                    return {
                        delay_id: "id",
                    };
                });
            });
            sendEventMock = jest.fn();
            client.sendStateEvent = sendStateEventMock;
            client._unstable_sendDelayedStateEvent = sendDelayedStateMock;
            client.sendEvent = sendEventMock;

            client._unstable_updateDelayedEvent = jest.fn();

            mockRoom = makeMockRoom([]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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

        it("sends a membership event when joining a call", async () => {
            const realSetTimeout = setTimeout;
            jest.useFakeTimers();
            sess!.joinRoomSession([mockFocus], mockFocus);
            await Promise.race([sentStateEvent, new Promise((resolve) => realSetTimeout(resolve, 500))]);
            expect(client.sendStateEvent).toHaveBeenCalledWith(
                mockRoom!.roomId,
                EventType.GroupCallMemberPrefix,
                {
                    application: "m.call",
                    scope: "m.room",
                    call_id: "",
                    device_id: "AAAAAAA",
                    expires: DEFAULT_EXPIRE_DURATION,
                    foci_preferred: [mockFocus],
                    focus_active: {
                        focus_selection: "oldest_membership",
                        type: "livekit",
                    },
                },
                "_@alice:example.org_AAAAAAA",
            );
            await Promise.race([sentDelayedState, new Promise((resolve) => realSetTimeout(resolve, 500))]);
            // Because we actually want to send the state
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            // For checking if the delayed event is still there or got removed while sending the state.
            expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(1);
            // For scheduling the delayed event
            expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            // This returns no error so we do not check if we reschedule the event again. this is done in another test.

            jest.useRealTimers();
        });

        it("uses membershipExpiryTimeout from join config", async () => {
            const realSetTimeout = setTimeout;
            jest.useFakeTimers();
            sess!.joinRoomSession([mockFocus], mockFocus, { membershipExpiryTimeout: 60000 });
            await Promise.race([sentStateEvent, new Promise((resolve) => realSetTimeout(resolve, 500))]);
            expect(client.sendStateEvent).toHaveBeenCalledWith(
                mockRoom!.roomId,
                EventType.GroupCallMemberPrefix,
                {
                    application: "m.call",
                    scope: "m.room",
                    call_id: "",
                    device_id: "AAAAAAA",
                    expires: 60000,
                    foci_preferred: [mockFocus],
                    focus_active: {
                        focus_selection: "oldest_membership",
                        type: "livekit",
                    },
                },
                "_@alice:example.org_AAAAAAA",
            );
            await Promise.race([sentDelayedState, new Promise((resolve) => realSetTimeout(resolve, 500))]);
            expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            jest.useRealTimers();
        });
    });

    describe("onMembershipsChanged", () => {
        it("does not emit if no membership changes", () => {
            const mockRoom = makeMockRoom(membershipTemplate);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
            sess.onRTCSessionMemberUpdate();

            expect(onMembershipsChanged).not.toHaveBeenCalled();
        });

        it("emits on membership changes", () => {
            const mockRoom = makeMockRoom(membershipTemplate);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

            mockRoom.getLiveTimeline().getState = jest.fn().mockReturnValue(makeMockRoomState([], mockRoom.roomId));
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
                sendStateEventMock = jest.fn();
                sendDelayedStateMock = jest.fn();
                sendEventMock = jest.fn();
                sendToDeviceMock = jest.fn();
                client.sendStateEvent = sendStateEventMock;
                client._unstable_sendDelayedStateEvent = sendDelayedStateMock;
                client.sendEvent = sendEventMock;
                client.encryptAndSendToDevice = sendToDeviceMock;

                mockRoom = makeMockRoom([]);
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                    const eventSentPromise = new Promise<void>((resolve) => {
                        sendEventMock.mockImplementation(() => {
                            if (!firstEventSent) {
                                jest.advanceTimersByTime(10000);

                                firstEventSent = true;
                                const e = new Error() as MatrixError;
                                e.data = {};
                                throw e;
                            } else {
                                resolve();
                            }
                        });
                    });

                    sess!.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                    await jest.runAllTimersAsync();

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
                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

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
                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([membershipTemplate], mockRoom.roomId));
                    sess.onRTCSessionMemberUpdate();

                    // member2 re-joins which should trigger an immediate re-send
                    const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                        sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                    });
                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([membershipTemplate, member2], mockRoom.roomId));
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
                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

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

                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([membershipTemplate, member2], mockRoom.roomId));
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
                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([member1, member2], mockRoom.roomId));

                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([member1, member2], mockRoom.roomId));

                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

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

                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([membershipTemplate], mockRoom.roomId));
                    sess.onRTCSessionMemberUpdate();

                    jest.advanceTimersByTime(KEY_DELAY);
                    expect(sendKeySpy).toHaveBeenCalledTimes(1);
                    // check that we send the key with index 1 even though the send gets delayed when leaving.
                    // this makes sure we do not use an index that is one too old.
                    expect(sendKeySpy).toHaveBeenLastCalledWith(expect.any(String), 1, sess.memberships);
                    // fake a condition in which we send another encryption key event.
                    // this could happen do to someone joining the call.
                    (sess as unknown as any).encryptionManager.sendEncryptionKeysEvent();
                    expect(sendKeySpy).toHaveBeenLastCalledWith(expect.any(String), 1, sess.memberships);
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
                const members: SessionMembershipData[] = [];
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
                            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
                            sess.joinRoomSession([mockFocus], mockFocus, { manageMediaKeys: true });
                        } else {
                            // otherwise update the state reducing the membership each time in order to trigger key rotation
                            mockRoom.getLiveTimeline().getState = jest
                                .fn()
                                .mockReturnValue(
                                    makeMockRoomState(members.slice(0, membersToTest - i), mockRoom.roomId),
                                );
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
                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

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

                    mockRoom.getLiveTimeline().getState = jest
                        .fn()
                        .mockReturnValue(makeMockRoomState([membershipTemplate, member2], mockRoom.roomId));
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
                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

                    sess!.joinRoomSession([mockFocus], mockFocus, {
                        manageMediaKeys: true,
                        useNewMembershipManager: true,
                        useExperimentalToDeviceTransport: true,
                    });

                    await keySentPromise;

                    expect(sendToDeviceMock).toHaveBeenCalled();
                } finally {
                    jest.useRealTimers();
                }
            });
        });

        describe("receiving", () => {
            it("collects keys from encryption events", async () => {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
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
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

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
                    sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

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
    });
});
