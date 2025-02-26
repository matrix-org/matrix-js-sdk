/**
 * @jest-environment ./spec/unit/matrixrtc/memberManagerTestEnvironment.ts
 */
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

import { EventType, HTTPError, MatrixError, type Room } from "../../../src";
import { type Focus, type LivekitFocusActive, type SessionMembershipData } from "../../../src/matrixrtc";
import { LegacyMembershipManager } from "../../../src/matrixrtc/MembershipManager";
import { makeMockClient, makeMockRoom, membershipTemplate, mockCallMembership, type MockClient } from "./mocks";
import { defer } from "../../../src/utils";

function waitForMockCall(method: MockedFunction<any>, returnVal?: Promise<any>) {
    return new Promise<void>((resolve) => {
        method.mockImplementation(() => {
            resolve();
            return returnVal ?? Promise.resolve();
        });
    });
}

function createAsyncHandle(method: MockedFunction<any>) {
    const { reject, resolve, promise } = defer();
    method.mockImplementation(() => promise);
    return { reject, resolve };
}

/**
 * Tests different MembershipManager implementations. Some tests don't apply to `LegacyMembershipManager`
 * use !FailsForLegacy to skip those. See: testEnvironment for more details.
 */
describe.each([
    { TestMembershipManager: LegacyMembershipManager, description: "LegacyMembershipManager" },
    // { TestMembershipManager: MembershipManager, description: "MembershipManager" },
])("$description", ({ TestMembershipManager }) => {
    let client: MockClient;
    let room: Room;
    const focusActive: LivekitFocusActive = {
        focus_selection: "oldest_membership",
        type: "livekit",
    };
    const focus: Focus = {
        type: "livekit",
        livekit_service_url: "https://active.url",
        livekit_alias: "!active:active.url",
    };

    beforeEach(() => {
        // Default to fake timers.
        jest.useFakeTimers();
        client = makeMockClient("@alice:example.org", "AAAAAAA");
        room = makeMockRoom(membershipTemplate);
        // Provide a default mock that is like the default "non error" server behaviour.
        (client._unstable_sendDelayedStateEvent as Mock<any>).mockResolvedValue({ delay_id: "id" });
        (client._unstable_updateDelayedEvent as Mock<any>).mockResolvedValue(undefined);
        (client.sendStateEvent as Mock<any>).mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        // There is no need to clean up mocks since we will recreate the client.
    });

    describe("isJoined()", () => {
        it("defaults to false", () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            expect(manager.isJoined()).toEqual(false);
        });

        it("returns true after join()", () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            manager.join([]);
            expect(manager.isJoined()).toEqual(true);
        });
    });

    describe("join()", () => {
        describe("sends a membership event", () => {
            it("sends a membership event and schedules delayed leave when joining a call", async () => {
                // Spys/Mocks

                const updateDelayedEventHandle = createAsyncHandle(client._unstable_updateDelayedEvent as Mock);

                // Test
                const memberManager = new TestMembershipManager(undefined, room, client, () => undefined);
                memberManager.join([focus], focusActive);
                // expects
                await waitForMockCall(client.sendStateEvent);
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
                    "_@alice:example.org_AAAAAAA",
                );
                updateDelayedEventHandle.resolve?.();
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledWith(
                    room.roomId,
                    { delay: 8000 },
                    "org.matrix.msc3401.call.member",
                    {},
                    "_@alice:example.org_AAAAAAA",
                );
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

                    const userStateKey = `${!useOwnedStateEvents ? "_" : ""}@alice:example.org_AAAAAAA`;
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
                    const manager = new TestMembershipManager(
                        {
                            membershipServerSideExpiryTimeout: 9000,
                        },
                        room,
                        client,
                        () => undefined,
                    );
                    manager.join([focus], focusActive);

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
                const manager = new TestMembershipManager({}, room, client, () => undefined);
                manager.join([focus], focusActive);
                delayedHandle.reject?.(Error("Server does not support the delayed events API"));
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            });
            it("does try to schedule a delayed leave event again if rate limited", async () => {
                const delayedHandle = createAsyncHandle(client._unstable_sendDelayedStateEvent as Mock);
                const manager = new TestMembershipManager({}, room, client, () => undefined);
                manager.join([focus], focusActive);
                delayedHandle.reject?.(new HTTPError("rate limited", 429, undefined));
                await jest.advanceTimersByTimeAsync(5000);
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(2);
            });
            it("uses membershipServerSideExpiryTimeout from config", () => {
                const manager = new TestMembershipManager(
                    { membershipServerSideExpiryTimeout: 123456 },
                    room,
                    client,
                    () => undefined,
                );
                manager.join([focus], focusActive);
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledWith(
                    room.roomId,
                    { delay: 123456 },
                    "org.matrix.msc3401.call.member",
                    {},
                    "_@alice:example.org_AAAAAAA",
                );
            });
        });

        it("uses membershipExpiryTimeout from config", async () => {
            const manager = new TestMembershipManager(
                { membershipExpiryTimeout: 1234567 },
                room,
                client,
                () => undefined,
            );

            manager.join([focus], focusActive);
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
                "_@alice:example.org_AAAAAAA",
            );
        });

        it("does nothing if join called when already joined", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            manager.join([focus], focusActive);
            await waitForMockCall(client.sendStateEvent);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            manager.join([focus], focusActive);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
        });
    });

    describe("leave()", () => {
        // TODO add rate limit cases.
        it("resolves delayed leave event when leave is called", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            await manager.leave();
            expect(client._unstable_updateDelayedEvent).toHaveBeenLastCalledWith("id", "send");
            expect(client.sendStateEvent).toHaveBeenCalled();
        });
        it("send leave event when leave is called and resolving delayed leave fails", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValue("unknown");
            await manager.leave();
            // We send a normal leave event since we failed using updateDelayedEvent with the "send" action.
            expect(client.sendStateEvent).toHaveBeenLastCalledWith(
                room.roomId,
                "org.matrix.msc3401.call.member",
                {},
                "_@alice:example.org_AAAAAAA",
            );
        });
        // FailsForLegacy because legacy implementation always sends the empty state event even though it isn't needed
        it("does nothing if not joined !FailsForLegacy", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            await manager.leave();
            expect(client._unstable_sendDelayedStateEvent).not.toHaveBeenCalled();
            expect(client.sendStateEvent).not.toHaveBeenCalled();
        });
    });

    describe("getsActiveFocus", () => {
        it("gets the correct active focus with oldest_membership", () => {
            const getOldestMembership = jest.fn();
            const manager = new TestMembershipManager({}, room, client, getOldestMembership);
            // Before joining the active focus should be undefined (see FocusInUse on MatrixRTCSession)
            expect(manager.getActiveFocus()).toBe(undefined);
            manager.join([focus], focusActive);
            // After joining we want our own focus to be the one we select.
            getOldestMembership.mockReturnValue(
                mockCallMembership(
                    {
                        ...membershipTemplate,
                        foci_preferred: [
                            {
                                livekit_alias: "!active:active.url",
                                livekit_service_url: "https://active.url",
                                type: "livekit",
                            },
                        ],
                        device_id: client.getDeviceId(),
                        created_ts: 1000,
                    },
                    room.roomId,
                    client.getUserId()!,
                ),
            );
            expect(manager.getActiveFocus()).toStrictEqual(focus);
            getOldestMembership.mockReturnValue(
                mockCallMembership(
                    Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                    room.roomId,
                ),
            );
            // If there is an older member we use its focus.
            expect(manager.getActiveFocus()).toBe(membershipTemplate.foci_preferred[0]);
        });

        it("does not provide focus if the selection method is unknown", () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            manager.join([focus], Object.assign(focusActive, { type: "unknown_type" }));
            expect(manager.getActiveFocus()).toBe(undefined);
        });
    });

    describe("onRTCSessionMemberUpdate()", () => {
        it("does nothing if not joined", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            await manager.onRTCSessionMemberUpdate([mockCallMembership(membershipTemplate, room.roomId)]);
            await jest.advanceTimersToNextTimerAsync();
            expect(client.sendStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_sendDelayedStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_updateDelayedEvent).not.toHaveBeenCalled();
        });
        it("does nothing if own membership still present", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
            manager.join([focus], focusActive);
            await jest.advanceTimersByTimeAsync(1);
            const myMembership = (client.sendStateEvent as Mock).mock.calls[0][2];
            // reset all mocks before checking what happens when calling: `onRTCSessionMemberUpdate`
            (client.sendStateEvent as Mock).mockClear();
            (client._unstable_updateDelayedEvent as Mock).mockClear();
            (client._unstable_sendDelayedStateEvent as Mock).mockClear();

            await manager.onRTCSessionMemberUpdate([
                mockCallMembership(membershipTemplate, room.roomId),
                mockCallMembership(myMembership as SessionMembershipData, room.roomId, client.getUserId() ?? undefined),
            ]);

            await jest.advanceTimersByTimeAsync(1);

            expect(client.sendStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_sendDelayedStateEvent).not.toHaveBeenCalled();
            expect(client._unstable_updateDelayedEvent).not.toHaveBeenCalled();
        });
        it("recreates membership if it is missing", async () => {
            const manager = new TestMembershipManager({}, room, client, () => undefined);
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
    });

    // TODO: Not sure about this name
    describe("background timers", () => {
        it("sends only one keep-alive for delayed leave event per `membershipKeepAlivePeriod`", async () => {
            const manager = new TestMembershipManager(
                { membershipKeepAlivePeriod: 10_000, membershipServerSideExpiryTimeout: 30_000 },
                room,
                client,
                () => undefined,
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

        // !FailsForLegacy because the expires logic was removed for the legacy call manager.
        // Delayed events should replace it entirely but before they have wide adoption
        // the expiration logic still makes sense.
        // TODO: add git commit when we removed it.
        it("extends `expires` when call still active !FailsForLegacy", async () => {
            const manager = new TestMembershipManager(
                { membershipExpiryTimeout: 10_000 },
                room,
                client,
                () => undefined,
            );
            manager.join([focus], focusActive);
            await waitForMockCall(client.sendStateEvent);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
            const sentMembership = (client.sendStateEvent as Mock).mock.calls[0][2] as SessionMembershipData;
            expect(sentMembership.expires).toBe(10_000);
            for (let i = 2; i <= 12; i++) {
                await jest.advanceTimersByTimeAsync(10_000);
                expect(client.sendStateEvent).toHaveBeenCalledTimes(i);
                const sentMembership = (client.sendStateEvent as Mock).mock.lastCall![2] as SessionMembershipData;
                expect(sentMembership.expires).toBe(10_000 * i);
            }
        });
    });

    describe("server error handling", () => {
        // Types of server error: 429 rate limit with no retry-after header, 429 with retry-after, 50x server error (maybe retry every second), connection/socket timeout
        describe("retries sending delayed leave event", () => {
            it("sends retry if call membership event is still valid at time of retry", async () => {
                const handle = createAsyncHandle(client._unstable_sendDelayedStateEvent);

                const manager = new TestMembershipManager({}, room, client, () => undefined);
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
            // FailsForLegacy as implementation does not re-check membership before retrying.
            it("abandons retry loop and sends new own membership if not present anymore !FailsForLegacy", async () => {
                (client._unstable_sendDelayedStateEvent as any).mockRejectedValue(
                    new MatrixError(
                        { errcode: "M_LIMIT_EXCEEDED" },
                        429,
                        undefined,
                        undefined,
                        new Headers({ "Retry-After": "1" }),
                    ),
                );
                const manager = new TestMembershipManager({}, room, client, () => undefined);
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
            // FailsForLegacy as implementation does not re-check membership before retrying.
            it("abandons retry loop if leave() was called !FailsForLegacy", async () => {
                const handle = createAsyncHandle(client._unstable_sendDelayedStateEvent);

                const manager = new TestMembershipManager({}, room, client, () => undefined);
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
                // await flushPromises();
                await jest.advanceTimersByTimeAsync(1000);

                // No new events should have been sent:
                expect(client._unstable_sendDelayedStateEvent).toHaveBeenCalledTimes(1);
            });
        });
        describe("retries sending update delayed leave event restart", () => {
            it("resends the initial check delayed update event !FailsForLegacy", async () => {
                (client._unstable_updateDelayedEvent as Mock<any>).mockRejectedValue(
                    new MatrixError(
                        { errcode: "M_LIMIT_EXCEEDED" },
                        429,
                        undefined,
                        undefined,
                        new Headers({ "Retry-After": "1" }),
                    ),
                );
                const manager = new TestMembershipManager({}, room, client, () => undefined);
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
});
