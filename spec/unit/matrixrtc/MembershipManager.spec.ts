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

import { type MockedFunction, type Mock } from "jest-mock";

import {
    type EmptyObject,
    EventType,
    HTTPError,
    MatrixError,
    UnsupportedDelayedEventsEndpointError,
    type Room,
    MAX_STICKY_DURATION_MS,
} from "../../../src";
import {
    MembershipManagerEvent,
    Status,
    type Transport,
    type SessionMembershipData,
    type LivekitFocusSelection,
} from "../../../src/matrixrtc";
import { makeMockClient, makeMockRoom, membershipTemplate, mockCallMembership, type MockClient } from "./mocks";
import { MembershipManager, StickyEventMembershipManager } from "../../../src/matrixrtc/MembershipManager.ts";

/**
 * Create a promise that will resolve once a mocked method is called.
 * @param method The method to wait for.
 * @param returnVal Provide an optional value that the mocked method should return. (use Promise.resolve(val) or Promise.reject(err))
 * @returns The promise that resolves once the method is called.
 */
function waitForMockCall(method: MockedFunction<any>, returnVal?: Promise<any>): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    method.mockImplementation(() => {
        resolve();
        return returnVal ?? Promise.resolve();
    });
    return promise;
}

/** See waitForMockCall */
function waitForMockCallOnce(method: MockedFunction<any>, returnVal?: Promise<any>) {
    const { promise, resolve } = Promise.withResolvers<void>();
    method.mockImplementationOnce(() => {
        resolve();
        return returnVal ?? Promise.resolve();
    });
    return promise;
}

/**
 * A handle to control when in the test flow the provided method resolves (or gets rejected).
 * @param method The method to control the resolve timing.
 * @returns
 */
function createAsyncHandle<T>(method: MockedFunction<any>) {
    const { reject, resolve, promise } = Promise.withResolvers<T>();
    method.mockImplementation(() => promise);
    return { reject, resolve };
}

const callSession = { id: "", application: "m.call" };

describe("MembershipManager", () => {
    let client: MockClient;
    let room: Room;
    const focusActive: LivekitFocusSelection = {
        focus_selection: "oldest_membership",
        type: "livekit",
    };
    const focus: Transport = {
        type: "livekit",
        livekit_service_url: "https://active.url",
        livekit_alias: "!active:active.url",
    };

    beforeEach(() => {
        // Default to fake timers.
        jest.useFakeTimers();
        client = makeMockClient("@alice:example.org", "AAAAAAA");
        room = makeMockRoom([membershipTemplate]);
        // Provide a default mock that is like the default "non error" server behaviour.
        (client._unstable_sendDelayedStateEvent as Mock<any>).mockResolvedValue({ delay_id: "id" });
        (client._unstable_updateDelayedEvent as Mock<any>).mockResolvedValue(undefined);
        (client._unstable_sendStickyEvent as Mock<any>).mockResolvedValue({ event_id: "id" });
        (client._unstable_sendStickyDelayedEvent as Mock<any>).mockResolvedValue({ delay_id: "id" });
        (client.sendStateEvent as Mock<any>).mockResolvedValue({ event_id: "id" });
    });

    afterEach(() => {
        jest.useRealTimers();
        // There is no need to clean up mocks since we will recreate the client.
    });

    describe("isActivated()", () => {
        it("defaults to false", () => {
            const manager = new MembershipManager({}, room, client, callSession);
            expect(manager.isActivated()).toEqual(false);
        });

        it("returns true after join()", () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([]);
            expect(manager.isActivated()).toEqual(true);
        });
    });

    describe("join()", () => {
        describe("sends a membership event", () => {
            it("sends a membership event and schedules delayed leave when joining a call", async () => {
                // Spys/Mocks

                const updateDelayedEventHandle = createAsyncHandle<void>(client._unstable_updateDelayedEvent as Mock);

                // Test
                const memberManager = new MembershipManager(undefined, room, client, callSession);
                memberManager.join([focus], undefined);
                // expects
                await waitForMockCall(client.sendStateEvent, Promise.resolve({ event_id: "id" }));
                expect(client.sendStateEvent).toHaveBeenCalledWith(
                    room.roomId,
                    "org.matrix.msc3401.call.member",
                    {
                        application: "m.call",
                        call_id: "",
                        device_id: "AAAAAAA",
                        expires: 14400000,
                        foci_preferred: [focus],
                        focus_active: focusActive,
                        scope: "m.room",
                    },
                    "_@alice:example.org_AAAAAAA_m.call",
                );
                updateDelayedEventHandle.resolve?.();
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledWith(
                    room.roomId,
                    { delay: 8000 },
                    "org.matrix.msc3401.call.member",
                    {},
                    "_@alice:example.org_AAAAAAA_m.call",
                );
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            });

            it("reschedules delayed leave event if sending state cancels it", async () => {
                const memberManager = new MembershipManager(undefined, room, client, callSession);
                const waitForSendState = waitForMockCall(client.sendStateEvent);
                const waitForUpdateDelaye = waitForMockCallOnce(
                    client._unstable_updateDelayedEvent,
                    Promise.reject(new MatrixError({ errcode: "M_NOT_FOUND" })),
                );
                memberManager.join([focus], focusActive);
                await waitForSendState;
                await waitForUpdateDelaye;
                await jest.advanceTimersByTimeAsync(1);
                // Once for the initial event and once because of the errcode: "M_NOT_FOUND"
                // Different to "sends a membership event and schedules delayed leave when joining a call" where its only called once (1)
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(2);
            });

            describe("does not prefix the state key with _ for rooms that support user-owned state events", () => {
                async function testJoin(useOwnedStateEvents: boolean): Promise<void> {
                    // TODO: this test does quiet a bit. Its more a like a test story summarizing to:
                    // - send delay with too long timeout and get server error (test delayedEventTimeout gets overwritten)
                    // - run into rate limit for sending delayed event
                    // - run into rate limit when setting membership state.
                    if (useOwnedStateEvents) {
                        room.getVersion = jest.fn().mockReturnValue("org.matrix.msc3757.default");
                    }
                    const updatedDelayedEvent = waitForMockCall(client._unstable_updateDelayedEvent);
                    const sentDelayedState = waitForMockCall(
                        client._unstable_sendDelayedStateEvent,
                        Promise.resolve({
                            delay_id: "id",
                        }),
                    );

                    // preparing the delayed disconnect should handle the delay being too long
                    const sendDelayedStateExceedAttempt = new Promise<void>((resolve) => {
                        const error = new MatrixError({
                            "errcode": "M_UNKNOWN",
                            "org.matrix.msc4140.errcode": "M_MAX_DELAY_EXCEEDED",
                            "org.matrix.msc4140.max_delay": 7500,
                        });
                        (client._unstable_sendDelayedStateEvent as Mock).mockImplementationOnce(() => {
                            resolve();
                            return Promise.reject(error);
                        });
                    });

                    const userStateKey = `${!useOwnedStateEvents ? "_" : ""}@alice:example.org_AAAAAAA_m.call`;
                    // preparing the delayed disconnect should handle ratelimiting
                    const sendDelayedStateAttempt = new Promise<void>((resolve) => {
                        const error = new MatrixError({ errcode: "M_LIMIT_EXCEEDED" });
                        (client._unstable_sendDelayedStateEvent as Mock).mockImplementationOnce(() => {
                            resolve();
                            return Promise.reject(error);
                        });
                    });

                    // setting the membership state should handle ratelimiting (also with a retry-after value)
                    const sendStateEventAttempt = new Promise<void>((resolve) => {
                        const error = new MatrixError(
                            { errcode: "M_LIMIT_EXCEEDED" },
                            429,
                            undefined,
                            undefined,
                            new Headers({ "Retry-After": "1" }),
                        );
                        (client.sendStateEvent as Mock).mockImplementationOnce(() => {
                            resolve();
                            return Promise.reject(error);
                        });
                    });
                    const manager = new MembershipManager(
                        {
                            delayedLeaveEventDelayMs: 9000,
                        },
                        room,
                        client,
                        callSession,
                    );
                    manager.join([focus]);

                    await sendDelayedStateExceedAttempt.then(); // needed to resolve after the send attempt catches
                    await sendDelayedStateAttempt;
                    const callProps = (d: number) => {
                        return [room!.roomId, { delay: d }, "org.matrix.msc3401.call.member", {}, userStateKey];
                    };
                    expect(client._unstable_sendDelayedStateEvent).toHaveBeenNthCalledWith(1, ...callProps(9000));
                    expect(client._unstable_sendDelayedStateEvent).toHaveBeenNthCalledWith(2, ...callProps(7500));

                    await jest.advanceTimersByTimeAsync(5000);

                    await sendStateEventAttempt.then(); // needed to resolve after resendIfRateLimited catches

                    await jest.advanceTimersByTimeAsync(1000);

                    expect(client.sendStateEvent).toHaveBeenCalledWith(
                        room!.roomId,
                        EventType.GroupCallMemberPrefix,
                        {
                            application: "m.call",
                            scope: "m.room",
                            call_id: "",
                            expires: 14400000,
                            device_id: "AAAAAAA",
                            foci_preferred: [focus],
                            focus_active: focusActive,
                        } satisfies SessionMembershipData,
                        userStateKey,
                    );
                    await sentDelayedState;

                    // should have prepared the heartbeat to keep delaying the leave event while still connected
                    await updatedDelayedEvent;
                    expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(1);

                    // ensures that we reach the code that schedules the timeout for the next delay update before we advance the timers.
                    await jest.advanceTimersByTimeAsync(5000);
                    // should update delayed disconnect
                    expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(2);
                }

                it("sends a membership event after rate limits during delayed event setup when joining a call", async () => {
                    await testJoin(false);
                });

                it("does not prefix the state key with _ for rooms that support user-owned state events", async () => {
                    await testJoin(true);
                });
            });
        });

        describe("delayed leave event", () => {
            it("does not try again to schedule a delayed leave event if not supported", () => {
                const delayedHandle = createAsyncHandle(client._unstable_sendDelayedStateEvent as Mock);
                const manager = new MembershipManager({}, room, client, callSession);
                manager.join([focus]);
                delayedHandle.reject?.(
                    new UnsupportedDelayedEventsEndpointError(
                        "Server does not support the delayed events API",
                        "sendDelayedStateEvent",
                    ),
                );
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            });
            it("does try to schedule a delayed leave event again if rate limited", async () => {
                const delayedHandle = createAsyncHandle(client._unstable_sendDelayedStateEvent as Mock);
                const manager = new MembershipManager({}, room, client, callSession);
                manager.join([focus]);
                delayedHandle.reject?.(new HTTPError("rate limited", 429, undefined));
                await jest.advanceTimersByTimeAsync(5000);
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(2);
            });
            it("uses delayedLeaveEventDelayMs from config", () => {
                const manager = new MembershipManager({ delayedLeaveEventDelayMs: 123456 }, room, client, callSession);
                manager.join([focus]);
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledWith(
                    room.roomId,
                    { delay: 123456 },
                    "org.matrix.msc3401.call.member",
                    {},
                    "_@alice:example.org_AAAAAAA_m.call",
                );
            });
        });

        it("rejoins if delayed event is not found (404)", async () => {
            const RESTART_DELAY = 15000;
            const manager = new MembershipManager(
                { delayedLeaveEventRestartMs: RESTART_DELAY },
                room,
                client,

                callSession,
            );
            // Join with the membership manager
            manager.join([focus]);
            expect(manager.status).toBe(Status.Connecting);
            // Let the scheduler run one iteration so that we can send the join state event
            await jest.runOnlyPendingTimersAsync();
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            expect(manager.status).toBe(Status.Connected);
            // Now that we are connected, we set up the mocks.
            // We enforce the following scenario where we simulate that the delayed event activated and caused the user to leave:
            // - We wait until the delayed event gets sent and then mock its response to be "not found."
            // - We enforce a race condition between the sync that informs us that our call membership state event was set to "left"
            //   and the "not found" response from the delayed event: we receive the sync while we are waiting for the delayed event to be sent.
            // - While the delayed leave event is being sent, we inform the manager that our membership state event was set to "left."
            //   (onRTCSessionMemberUpdate)
            // - Only then do we resolve the sending of the delayed event.
            // - We test that the manager acknowledges the leave and sends a new membership state event.
            (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValueOnce(
                new MatrixError({ errcode: "M_NOT_FOUND" }),
            );

            const { resolve } = createAsyncHandle(client._unstable_sendDelayedStateEvent);
            await jest.advanceTimersByTimeAsync(RESTART_DELAY);
            // first simulate the sync, then resolve sending the delayed event.
            await manager.onRTCSessionMemberUpdate([mockCallMembership(membershipTemplate, room.roomId)]);
            resolve({ delay_id: "id" });
            // Let the scheduler run one iteration so that the new join gets sent
            await jest.runOnlyPendingTimersAsync();
            expect(client.sendStateEvent).toHaveBeenCalledTimes(2);
        });

        it("uses membershipEventExpiryMs from config", async () => {
            const manager = new MembershipManager(
                { membershipEventExpiryMs: 1234567 },
                room,
                client,

                callSession,
            );

            manager.join([focus]);
            await waitForMockCall(client.sendStateEvent);
            expect(client.sendStateEvent).toHaveBeenCalledWith(
                room.roomId,
                EventType.GroupCallMemberPrefix,
                {
                    application: "m.call",
                    scope: "m.room",
                    call_id: "",
                    device_id: "AAAAAAA",
                    expires: 1234567,
                    foci_preferred: [focus],
                    focus_active: {
                        focus_selection: "oldest_membership",
                        type: "livekit",
                    },
                },
                "_@alice:example.org_AAAAAAA_m.call",
            );
        });

        it("does nothing if join called when already joined", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus]);
            await waitForMockCall(client.sendStateEvent);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            manager.join([focus]);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
        });
    });

    describe("leave()", () => {
        // TODO add rate limit cases.
        it("resolves delayed leave event when leave is called", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus]);
            await jest.advanceTimersByTimeAsync(1);
            await manager.leave();
            expect(client._unstable_updateDelayedEvent).toHaveBeenLastCalledWith("id", "send");
            expect(client.sendStateEvent).toHaveBeenCalled();
        });
        it("send leave event when leave is called and resolving delayed leave fails", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus]);
            await jest.advanceTimersByTimeAsync(1);
            (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValue("unknown");
            await manager.leave();

            // We send a normal leave event since we failed using updateDelayedEvent with the "send" action.
            expect(client.sendStateEvent).toHaveBeenLastCalledWith(
                room.roomId,
                "org.matrix.msc3401.call.member",
                {},
                "_@alice:example.org_AAAAAAA_m.call",
            );
        });
        it("does nothing if not joined", () => {
            const manager = new MembershipManager({}, room, client, callSession);
            expect(async () => await manager.leave()).not.toThrow();
            expect(client._unstable_sendDelayedStateEvent).not.toHaveBeenCalled();
            expect(client.sendStateEvent).not.toHaveBeenCalled();
        });
    });

    describe("onRTCSessionMemberUpdate()", () => {
        it("does nothing if not joined", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            await manager.onRTCSessionMemberUpdate([mockCallMembership(membershipTemplate, room.roomId)]);
            await jest.advanceTimersToNextTimerAsync();
            expect(client.sendStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_sendDelayedStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_updateDelayedEvent).not.toHaveBeenCalled();
        });
        it("does nothing if own membership still present", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            const myMembership = (client.sendStateEvent as Mock).mock.calls[0][2];
            // reset all mocks before checking what happens when calling: `onRTCSessionMemberUpdate`
            (client.sendStateEvent as Mock).mockClear();
            (client._unstable_updateDelayedEvent as Mock).mockClear();
            (client._unstable_sendDelayedStateEvent as Mock).mockClear();

            await manager.onRTCSessionMemberUpdate([
                mockCallMembership(membershipTemplate, room.roomId),
                mockCallMembership(
                    { ...(myMembership as SessionMembershipData), user_id: client.getUserId()! },
                    room.roomId,
                ),
            ]);

            await jest.advanceTimersByTimeAsync(1);

            expect(client.sendStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_sendDelayedStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_updateDelayedEvent).not.toHaveBeenCalled();
        });
        it("recreates membership if it is missing", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            // clearing all mocks before checking what happens when calling: `onRTCSessionMemberUpdate`
            (client.sendStateEvent as Mock).mockClear();
            (client._unstable_updateDelayedEvent as Mock).mockClear();
            (client._unstable_sendDelayedStateEvent as Mock).mockClear();

            // Our own membership is removed:
            await manager.onRTCSessionMemberUpdate([mockCallMembership(membershipTemplate, room.roomId)]);
            await jest.advanceTimersByTimeAsync(1);
            expect(client.sendStateEvent).toHaveBeenCalled();
            expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalled();

            expect(client._unstable_updateDelayedEvent).toHaveBeenCalled();
        });

        it("updates the UpdateExpiry entry in the action scheduler", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            // clearing all mocks before checking what happens when calling: `onRTCSessionMemberUpdate`
            (client.sendStateEvent as Mock).mockClear();
            (client._unstable_updateDelayedEvent as Mock).mockClear();
            (client._unstable_sendDelayedStateEvent as Mock).mockClear();

            (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValueOnce(
                new MatrixError({ errcode: "M_NOT_FOUND" }),
            );

            const { resolve } = createAsyncHandle(client._unstable_sendDelayedStateEvent);
            await jest.advanceTimersByTimeAsync(10_000);
            await manager.onRTCSessionMemberUpdate([mockCallMembership(membershipTemplate, room.roomId)]);
            resolve({ delay_id: "id" });
            await jest.advanceTimersByTimeAsync(10_000);

            expect(client.sendStateEvent).toHaveBeenCalled();
            expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalled();

            expect(client._unstable_updateDelayedEvent).toHaveBeenCalled();
            expect(manager.status).toBe(Status.Connected);
        });
    });

    // TODO: Not sure about this name
    describe("background timers", () => {
        it("sends only one keep-alive for delayed leave event per `delayedLeaveEventRestartMs`", async () => {
            const manager = new MembershipManager(
                { delayedLeaveEventRestartMs: 10_000, delayedLeaveEventDelayMs: 30_000 },
                room,
                client,
                { id: "", application: "m.call" },
            );
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);

            // The first call is from checking id the server deleted the delayed event
            // so it does not need a `advanceTimersByTime`
            expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(1);
            // TODO: Check that update delayed event is called with the correct HTTP request timeout
            // expect(client._unstable_updateDelayedEvent).toHaveBeenLastCalledWith("id", 10_000, { localTimeoutMs: 20_000 });

            for (let i = 2; i <= 12; i++) {
                // flush promises before advancing the timers to make sure schedulers are setup
                await jest.advanceTimersByTimeAsync(10_000);

                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(i);
                // TODO: Check that update delayed event is called with the correct HTTP request timeout
                // expect(client._unstable_updateDelayedEvent).toHaveBeenLastCalledWith("id", 10_000, { localTimeoutMs: 20_000 });
            }
        });

        // because the expires logic was removed for the legacy call manager.
        // Delayed events should replace it entirely but before they have wide adoption
        // the expiration logic still makes sense.
        // TODO: Add git commit when we removed it.
        async function testExpires(expire: number, headroom?: number) {
            const manager = new MembershipManager(
                { membershipEventExpiryMs: expire, membershipEventExpiryHeadroomMs: headroom },
                room,
                client,

                { id: "", application: "m.call" },
            );
            manager.join([focus], focusActive);
            await waitForMockCall(client.sendStateEvent);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            const sentMembership = (client.sendStateEvent as Mock).mock.calls[0][2] as SessionMembershipData;
            expect(sentMembership.expires).toBe(expire);
            for (let i = 2; i <= 12; i++) {
                await jest.advanceTimersByTimeAsync(expire);
                expect(client.sendStateEvent).toHaveBeenCalledTimes(i);
                const sentMembership = (client.sendStateEvent as Mock).mock.lastCall![2] as SessionMembershipData;
                expect(sentMembership.expires).toBe(expire * i);
            }
        }
        it("extends `expires` when call still active", async () => {
            await testExpires(10_000);
        });
        it("extends `expires` using headroom configuration", async () => {
            await testExpires(10_000, 1_000);
        });
    });

    describe("status updates", () => {
        it("starts 'Disconnected'", () => {
            const manager = new MembershipManager({}, room, client, callSession);
            expect(manager.status).toBe(Status.Disconnected);
        });
        it("emits 'Connection' and 'Connected' after join", async () => {
            const handleDelayedEvent = createAsyncHandle<void>(client._unstable_sendDelayedStateEvent);
            const handleStateEvent = createAsyncHandle<void>(client.sendStateEvent);

            const manager = new MembershipManager({}, room, client, callSession);
            expect(manager.status).toBe(Status.Disconnected);
            const connectEmit = jest.fn();
            manager.on(MembershipManagerEvent.StatusChanged, connectEmit);
            manager.join([focus], focusActive);
            expect(manager.status).toBe(Status.Connecting);
            handleDelayedEvent.resolve();
            await jest.advanceTimersByTimeAsync(1);
            expect(connectEmit).toHaveBeenCalledWith(Status.Disconnected, Status.Connecting);
            handleStateEvent.resolve();
            await jest.advanceTimersByTimeAsync(1);
            expect(connectEmit).toHaveBeenCalledWith(Status.Connecting, Status.Connected);
        });
        it("emits 'Disconnecting' and 'Disconnected' after leave", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            const connectEmit = jest.fn();
            manager.on(MembershipManagerEvent.StatusChanged, connectEmit);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            await manager.leave();
            expect(connectEmit).toHaveBeenCalledWith(Status.Connected, Status.Disconnecting);
            expect(connectEmit).toHaveBeenCalledWith(Status.Disconnecting, Status.Disconnected);
        });
    });
    describe("server error handling", () => {
        // Types of server error: 429 rate limit with no retry-after header, 429 with retry-after, 50x server error (maybe retry every second), connection/socket timeout
        describe("retries sending delayed leave event", () => {
            it("sends retry if call membership event is still valid at time of retry", async () => {
                const handle = createAsyncHandle(client._unstable_sendDelayedStateEvent);

                const manager = new MembershipManager({}, room, client, callSession);
                manager.join([focus], focusActive);
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);

                handle.reject?.(
                    new MatrixError(
                        { errcode: "M_LIMIT_EXCEEDED" },
                        429,
                        undefined,
                        undefined,
                        new Headers({ "Retry-After": "1" }),
                    ),
                );
                await jest.advanceTimersByTimeAsync(1000);

                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(2);
            });
            it("abandons retry loop and sends new own membership if not present anymore", async () => {
                (client._unstable_sendDelayedStateEvent as Mock<any>).mockRejectedValue(
                    new MatrixError(
                        { errcode: "M_LIMIT_EXCEEDED" },
                        429,
                        undefined,
                        undefined,
                        new Headers({ "Retry-After": "1" }),
                    ),
                );
                const manager = new MembershipManager({}, room, client, callSession);
                // Should call _unstable_sendDelayedStateEvent but not sendStateEvent because of the
                // RateLimit error.
                manager.join([focus], focusActive);
                await jest.advanceTimersByTimeAsync(1);

                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
                (client._unstable_sendDelayedStateEvent as Mock<any>).mockResolvedValue({ delay_id: "id" });
                // Remove our own membership so that there is no reason the send the delayed leave anymore.
                // the membership is no longer present on the homeserver
                await manager.onRTCSessionMemberUpdate([]);
                // Wait for all timers to be setup
                await jest.advanceTimersByTimeAsync(1000);
                // We should send the first own membership and a new delayed event after the rate limit timeout.
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(2);
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            });
            it("abandons retry loop if leave() was called before sending state event", async () => {
                const handle = createAsyncHandle(client._unstable_sendDelayedStateEvent);

                const manager = new MembershipManager({}, room, client, callSession);
                manager.join([focus], focusActive);
                handle.reject?.(
                    new MatrixError(
                        { errcode: "M_LIMIT_EXCEEDED" },
                        429,
                        undefined,
                        undefined,
                        new Headers({ "Retry-After": "1" }),
                    ),
                );

                await jest.advanceTimersByTimeAsync(1);
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
                // the user terminated the call locally
                await manager.leave();

                // Wait for all timers to be setup
                await jest.advanceTimersByTimeAsync(1000);

                // No new events should have been sent:
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            });
        });
        describe("retries sending update delayed leave event restart", () => {
            it("resends the initial check delayed update event", async () => {
                (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValue(
                    new MatrixError(
                        { errcode: "M_LIMIT_EXCEEDED" },
                        429,
                        undefined,
                        undefined,
                        new Headers({ "Retry-After": "1" }),
                    ),
                );
                const manager = new MembershipManager({}, room, client, callSession);
                manager.join([focus], focusActive);

                // Hit rate limit
                await jest.advanceTimersByTimeAsync(1);
                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(1);

                // Hit second rate limit.
                await jest.advanceTimersByTimeAsync(1000);
                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(2);

                // Setup resolve
                (client._unstable_updateDelayedEvent as Mock<any>).mockResolvedValue(undefined);
                await jest.advanceTimersByTimeAsync(1000);

                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(3);
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            });
        });
    });
    describe("unrecoverable errors", () => {
        // because legacy does not have a retry limit and no mechanism to communicate unrecoverable errors.
        it("throws, when reaching maximum number of retries for initial delayed event creation", async () => {
            const delayEventSendError = jest.fn();
            (client._unstable_sendDelayedStateEvent as Mock<any>).mockRejectedValue(
                new MatrixError(
                    { errcode: "M_LIMIT_EXCEEDED" },
                    429,
                    undefined,
                    undefined,
                    new Headers({ "Retry-After": "2" }),
                ),
            );
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive, delayEventSendError);

            for (let i = 0; i < 10; i++) {
                await jest.advanceTimersByTimeAsync(2000);
            }
            expect(delayEventSendError).toHaveBeenCalled();
        });
        // because legacy does not have a retry limit and no mechanism to communicate unrecoverable errors.
        it("throws, when reaching maximum number of retries", async () => {
            const delayEventRestartError = jest.fn();
            (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValue(
                new MatrixError(
                    { errcode: "M_LIMIT_EXCEEDED" },
                    429,
                    undefined,
                    undefined,
                    new Headers({ "Retry-After": "1" }),
                ),
            );
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive, delayEventRestartError);

            for (let i = 0; i < 10; i++) {
                await jest.advanceTimersByTimeAsync(1000);
            }
            expect(delayEventRestartError).toHaveBeenCalled();
        });
        it("falls back to using pure state events when some error occurs while sending delayed events", async () => {
            const unrecoverableError = jest.fn();
            (client._unstable_sendDelayedStateEvent as Mock<any>).mockRejectedValue(new HTTPError("unknown", 601));
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive, unrecoverableError);
            await waitForMockCall(client.sendStateEvent);
            expect(unrecoverableError).not.toHaveBeenCalledWith();
            expect(client.sendStateEvent).toHaveBeenCalled();
        });
        it("retries before failing in case its a network error", async () => {
            const unrecoverableError = jest.fn();
            (client._unstable_sendDelayedStateEvent as Mock<any>).mockRejectedValue(new HTTPError("unknown", 501));
            const manager = new MembershipManager(
                { networkErrorRetryMs: 1000, maximumNetworkErrorRetryCount: 7 },
                room,
                client,
                callSession,
            );
            manager.join([focus], focusActive, unrecoverableError);
            for (let retries = 0; retries < 7; retries++) {
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(retries + 1);
                await jest.advanceTimersByTimeAsync(1000);
            }
            expect(unrecoverableError).toHaveBeenCalled();
            expect(unrecoverableError.mock.lastCall![0].message).toMatch(
                "The MembershipManager shut down because of the end condition",
            );
            expect(client.sendStateEvent).not.toHaveBeenCalled();
        });
        it("falls back to using pure state events when UnsupportedDelayedEventsEndpointError encountered for delayed events", async () => {
            const unrecoverableError = jest.fn();
            (client._unstable_sendDelayedStateEvent as Mock<any>).mockRejectedValue(
                new UnsupportedDelayedEventsEndpointError("not supported", "sendDelayedStateEvent"),
            );
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([focus], focusActive, unrecoverableError);
            await jest.advanceTimersByTimeAsync(1);

            expect(unrecoverableError).not.toHaveBeenCalled();
            expect(client.sendStateEvent).toHaveBeenCalled();
        });
    });
    describe("probablyLeft", () => {
        it("emits probablyLeft when the membership manager could not hear back from the server for the duration of the delayed event", async () => {
            const manager = new MembershipManager(
                { delayedLeaveEventDelayMs: 10000 },
                room,
                client,

                callSession,
            );
            const { promise: stuckPromise, reject: rejectStuckPromise } = Promise.withResolvers<EmptyObject>();
            const probablyLeftEmit = jest.fn();
            manager.on(MembershipManagerEvent.ProbablyLeft, probablyLeftEmit);
            manager.join([focus], focusActive);
            try {
                // Let the scheduler run one iteration so that we can send the join state event
                await waitForMockCall(client._unstable_updateDelayedEvent);

                // We never resolve the delayed event so that we can test the probablyLeft event.
                // This simulates the case where the server does not respond to the delayed event.
                client._unstable_updateDelayedEvent = jest.fn(() => stuckPromise);
                expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
                expect(manager.status).toBe(Status.Connected);
                expect(probablyLeftEmit).not.toHaveBeenCalledWith(true);
                // We expect the probablyLeft event to be emitted after the `delayedLeaveEventDelayMs` = 10000.
                // We also track the calls to updated the delayed event that all will never resolve to simulate the server not responding.
                // The numbers are a bit arbitrary since we use the local timeout that does not perfectly match the 5s check interval in this test.
                await jest.advanceTimersByTimeAsync(5000);
                // No emission after 5s
                expect(probablyLeftEmit).not.toHaveBeenCalledWith(true);
                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(1);

                await jest.advanceTimersByTimeAsync(4999);
                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(3);
                expect(probablyLeftEmit).not.toHaveBeenCalledWith(true);

                // Reset mocks before we setup the next delayed event restart by advancing the timers 1 more ms.
                (client._unstable_updateDelayedEvent as Mock<any>).mockResolvedValue({});

                // Emit after 10s
                await jest.advanceTimersByTimeAsync(1);
                expect(client._unstable_updateDelayedEvent).toHaveBeenCalledTimes(4);
                expect(probablyLeftEmit).toHaveBeenCalledWith(true);

                // Mock a sync which does not include our own membership
                await manager.onRTCSessionMemberUpdate([]);
                // Wait for the current ongoing delayed event sending to finish
                await jest.advanceTimersByTimeAsync(1);
                // We should send a new state event and an associated delayed leave event.
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(2);
                expect(client.sendStateEvent).toHaveBeenCalledTimes(2);
                // At the same time we expect the probablyLeft event to be emitted with false so we are back operational.
                expect(probablyLeftEmit).toHaveBeenCalledWith(false);
            } finally {
                rejectStuckPromise();
            }
        });
    });

    describe("updateCallIntent()", () => {
        it("should fail if the user has not joined the call", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            // After joining we want our own focus to be the one we select.
            try {
                await manager.updateCallIntent("video");
                throw Error("Should have thrown");
            } catch {}
        });

        it("can adjust the intent", async () => {
            const manager = new MembershipManager({}, room, client, callSession);
            manager.join([]);
            expect(manager.isActivated()).toEqual(true);
            const membership = mockCallMembership({ ...membershipTemplate, user_id: client.getUserId()! }, room.roomId);
            await manager.onRTCSessionMemberUpdate([membership]);
            await manager.updateCallIntent("video");
            expect(client.sendStateEvent).toHaveBeenCalledTimes(2);
            const eventContent = (client.sendStateEvent as Mock).mock.calls[0][2] as SessionMembershipData;
            expect(eventContent["created_ts"]).toEqual(membership.createdTs());
            expect(eventContent["m.call.intent"]).toEqual("video");
        });

        it("does nothing if the intent doesn't change", async () => {
            const manager = new MembershipManager({ callIntent: "video" }, room, client, callSession);
            manager.join([]);
            expect(manager.isActivated()).toEqual(true);
            const membership = mockCallMembership(
                { ...membershipTemplate, "user_id": client.getUserId()!, "m.call.intent": "video" },
                room.roomId,
            );
            await manager.onRTCSessionMemberUpdate([membership]);
            await manager.updateCallIntent("video");
            expect(client.sendStateEvent).toHaveBeenCalledTimes(0);
        });
    });

    describe("StickyEventMembershipManager", () => {
        beforeEach(() => {
            // Provide a default mock that is like the default "non error" server behaviour.
            (client._unstable_sendStickyDelayedEvent as Mock<any>).mockResolvedValue({ delay_id: "id" });
            (client._unstable_sendStickyEvent as Mock<any>).mockResolvedValue(undefined);
        });

        describe("join()", () => {
            describe("sends an rtc membership event", () => {
                it("sends a membership event and schedules delayed leave when joining a call", async () => {
                    const updateDelayedEventHandle = createAsyncHandle<void>(
                        client._unstable_updateDelayedEvent as Mock,
                    );
                    const memberManager = new StickyEventMembershipManager(undefined, room, client, callSession);

                    memberManager.join([], focus);

                    await waitForMockCall(client._unstable_sendStickyEvent, Promise.resolve({ event_id: "id" }));
                    // Test we sent the initial join
                    expect(client._unstable_sendStickyEvent).toHaveBeenCalledWith(
                        room.roomId,
                        3600000,
                        null,
                        "org.matrix.msc4143.rtc.member",
                        {
                            application: { type: "m.call" },
                            member: {
                                user_id: "@alice:example.org",
                                id: "_@alice:example.org_AAAAAAA_m.call",
                                device_id: "AAAAAAA",
                            },
                            slot_id: "m.call#",
                            rtc_transports: [focus],
                            versions: [],
                            msc4354_sticky_key: "_@alice:example.org_AAAAAAA_m.call",
                        },
                    );
                    updateDelayedEventHandle.resolve?.();

                    // Ensure we have sent the delayed disconnect event.
                    expect(client._unstable_sendStickyDelayedEvent).toHaveBeenCalledWith(
                        room.roomId,
                        MAX_STICKY_DURATION_MS,
                        { delay: 8000 },
                        null,
                        "org.matrix.msc4143.rtc.member",
                        {
                            msc4354_sticky_key: "_@alice:example.org_AAAAAAA_m.call",
                        },
                    );
                    // ..once
                    expect(client._unstable_sendStickyDelayedEvent).toHaveBeenCalledTimes(1);
                });
            });
        });
    });
});

it("Should prefix log with MembershipManager used", () => {
    const client = makeMockClient("@alice:example.org", "AAAAAAA");
    const room = makeMockRoom([membershipTemplate]);

    const membershipManager = new MembershipManager(undefined, room, client, callSession);

    const spy = jest.spyOn(console, "error");
    // Double join
    membershipManager.join([]);
    membershipManager.join([]);

    expect(spy).toHaveBeenCalled();
    const logline: string = spy.mock.calls[0][0];
    expect(logline.startsWith("[MembershipManager]")).toBe(true);
});
