/*
Copyright 2025-2026 The Matrix.org Foundation C.I.C.

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

import { type Mock, type Mocked } from "vitest";

import { RTCEncryptionManager } from "../../../src/matrixrtc/RTCEncryptionManager.ts";
import { type CallMembership } from "../../../src/matrixrtc";
import { type ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import { KeyTransportEvents, type KeyTransportEventsHandlerMap } from "../../../src/matrixrtc/IKeyTransport.ts";
import { sessionMembershipTemplate, mockCallMembership } from "./mocks.ts";
import { decodeBase64, TypedEventEmitter } from "../../../src";
import { logger } from "../../../src/logger.ts";
import { getEncryptionKeyMapKey } from "../../../src/matrixrtc/EncryptionManager.ts";
import { flushPromises } from "../../test-utils/flushPromises.ts";

/**
 * The rotation grace period is not configured directly, it is derived from the number of participants:
 * `60_000 * N * (N - 1) / sharedPerMinuteToDeviceContingent`.
 *
 * With this contingent the grace period is a comfortable `1_000 * N * (N - 1)` ms, see {@link gracePeriodMsFor}.
 * The default contingent (3000) would give 40ms for 2 participants and 240ms for 4, which is impractical to test with.
 */
const TEST_CONTINGENT = 60;

/**
 * The grace period the encryption manager will use for a session with `participantCount` **other** participants.
 * (`getMemberships()` is mocked to return the other members only in this spec, our own membership is not part of it)
 */
function gracePeriodMsFor(participantCount: number, contingent: number = TEST_CONTINGENT): number {
    return (60_000 * participantCount * (participantCount - 1)) / contingent;
}

/** The shape in which a membership is handed to {@link IKeyTransport.sendKey} */
function participantInfo(membership: CallMembership) {
    return { userId: membership.sender, deviceId: membership.deviceId, membershipTs: membership.createdTs() };
}

const OWN_MEMBERSHIP = {
    userId: "@alice:example.org",
    deviceId: "DEVICE01",
    memberId: "@alice:example.org:DEVICE01",
};
const OWN_RTC_BACKEND_IDENTITY = "@alice:example.org:DEVICE01";

describe("RTCEncryptionManager", () => {
    // The manager being tested
    let encryptionManager: RTCEncryptionManager;
    let getMembershipMock: Mock;
    let mockTransport: Mocked<ToDeviceKeyTransport>;
    let onEncryptionKeysChanged: Mock;
    let rtcIdentifierProvider: Mock;

    beforeEach(() => {
        getMembershipMock = vi.fn().mockReturnValue([]);
        onEncryptionKeysChanged = vi.fn();
        mockTransport = {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as Mocked<ToDeviceKeyTransport>;

        rtcIdentifierProvider = vi.fn().mockImplementation((userId: string, deviceId: string, memberId: string) => {
            return `MOCKSHA<${userId}|${deviceId}|${memberId}>`;
        });

        encryptionManager = new RTCEncryptionManager(
            { userId: "@alice:example.org", deviceId: "DEVICE01", memberId: "@alice:example.org:DEVICE01" },
            getMembershipMock,
            mockTransport,
            onEncryptionKeysChanged,
            logger,
            rtcIdentifierProvider,
        );
    });

    afterEach(() => {
        // Some tests spy on `Math.random` to make the rotation jitter deterministic.
        vi.restoreAllMocks();
    });

    it("should start and stop the transport properly", () => {
        encryptionManager.join(undefined);

        expect(mockTransport.start).toHaveBeenCalledTimes(1);
        expect(mockTransport.on).toHaveBeenCalledTimes(1);
        expect(mockTransport.on).toHaveBeenCalledWith(KeyTransportEvents.ReceivedKeys, expect.any(Function));
        encryptionManager.leave();
        expect(mockTransport.stop).toHaveBeenCalledTimes(1);
        expect(mockTransport.off).toHaveBeenCalledWith(KeyTransportEvents.ReceivedKeys, expect.any(Function));
    });

    describe("Sharing Keys", () => {
        it("Set up my key asap even if no key distribution is needed", async () => {
            getMembershipMock.mockReturnValue([]);

            encryptionManager.join(undefined);
            // After join it is too early, key might be lost as no one is listening yet
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();

            encryptionManager.onMembershipsUpdate();
            await flushPromises();
            // The key should have been rolled out immediately
            expect(onEncryptionKeysChanged).toHaveBeenCalled();
        });

        it("Should distribute keys to members on join", async () => {
            vi.useFakeTimers();
            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate();
            await vi.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );
            await vi.runOnlyPendingTimersAsync();
            // The key should have been rolled out immediately
            expect(onEncryptionKeysChanged).toHaveBeenCalled();
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                {
                    deviceId: "DEVICE01",
                    memberId: "@alice:example.org:DEVICE01",
                    userId: "@alice:example.org",
                },
                "@alice:example.org:DEVICE01",
            );
        });

        it("Should re-distribute keys to members whom callMemberhsip ts has changed", async () => {
            vi.useFakeTimers();
            let members = [aStateBaseMembership("@bob:example.org", "BOBDEVICE", 1000)];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate();
            await vi.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                [
                    {
                        userId: "@bob:example.org",
                        deviceId: "BOBDEVICE",
                        membershipTs: 1000,
                    },
                ],
            );
            await vi.advanceTimersByTimeAsync(1);
            // The key should have been rolled out immediately
            expect(onEncryptionKeysChanged).toHaveBeenCalled();

            mockTransport.sendKey.mockClear();
            onEncryptionKeysChanged.mockClear();

            members = [aStateBaseMembership("@bob:example.org", "BOBDEVICE", 2000)];
            getMembershipMock.mockReturnValue(members);

            // There are no membership change but the callMembership ts has changed (reset?)
            // That member counts as a new joiner: resend the key
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(mockTransport.sendKey).toHaveBeenNthCalledWith(
                1,
                expect.any(String),
                // Re send the same key to that user
                0,
                [
                    {
                        userId: "@bob:example.org",
                        deviceId: "BOBDEVICE",
                        membershipTs: 2000,
                    },
                ],
            );

            // And, as for any other joiner, the key is rotated afterwards.
            // With a single other participant the grace period (and therefore the jitter) is 0ms.
            await vi.runOnlyPendingTimersAsync();
            expect(mockTransport.sendKey).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                // The key index has been incremented
                1,
                [
                    {
                        userId: "@bob:example.org",
                        deviceId: "BOBDEVICE",
                        membershipTs: 2000,
                    },
                ],
            );
        });

        it("Should not rotate key when a user join within the rotation grace period", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // With 3 participants and this contingent the grace period is 6s
            const gracePeriod = gracePeriodMsFor(3);
            // initial rollout
            encryptionManager.join({ sharedPerMinuteToDeviceContingent: TEST_CONTINGENT });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );
            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            // Carl joins, within the grace period
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            await vi.advanceTimersByTimeAsync(gracePeriod / 2);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(mockTransport.sendKey).toHaveBeenCalledExactlyOnceWith(
                expect.any(String),
                // It should not have incremented the key index
                0,
                // And send it to the newly joined only
                [{ userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1000 }],
            );

            // The rotation is deferred to the end of the grace period, not skipped: nothing happens before that.
            await vi.advanceTimersByTimeAsync(gracePeriod / 2 - 2);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();

            // Now the grace period of the current key has elapsed, it is rotated for everyone.
            await vi.advanceTimersByTimeAsync(1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(2);
            expect(mockTransport.sendKey).toHaveBeenLastCalledWith(
                expect.any(String),
                1,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );

            // And is used locally after the `useKeyDelay`
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
            expect(onEncryptionKeysChanged).toHaveBeenCalledExactlyOnceWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );
        });

        // Test an edge case where the use key delay is higher than the grace period. That is the case for any small
        // session with the default contingent (the grace period is 240ms for 4 participants).
        // This means that a membership change can arrive while the previous key is still being rolled out, and that
        // the key once rolled out is always too old to be considered "recent enough" for the next joiner.
        // So we expect another rotation to happen in all cases where a new member joins.
        it("test grace period lower than delay period", async () => {
            vi.useFakeTimers();
            // Make the jitter deterministic: half of the grace period
            vi.spyOn(Math, "random").mockReturnValue(0.5);

            const bob = aStateBaseMembership("@bob:example.org", "BOBDEVICE");
            const bob2 = aStateBaseMembership("@bob:example.org", "BOBDEVICE2");
            const carl = aStateBaseMembership("@carl:example.org", "CARLDEVICE");
            const david = aStateBaseMembership("@david:example.org", "DAVDEVICE");
            getMembershipMock.mockReturnValue([bob, bob2]);

            const useKeyDelay = 5_000;
            // The default contingent gives a grace period of 120ms for 3 and 240ms for 4 participants,
            // both far below the `useKeyDelay`.
            expect(gracePeriodMsFor(4, 3000)).toBeLessThan(useKeyDelay);

            // initial rollout
            encryptionManager.join({ useKeyDelay });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            // The existing members have been talking for 5mn
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

            // A new member joins, that should trigger a key rotation (jittered by 120ms/2).
            getMembershipMock.mockReturnValue([bob, bob2, carl]);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(3, 3000) / 2);

            // A new member joins while the rotated key is still in its `useKeyDelay` window
            await vi.advanceTimersByTimeAsync(1_000);
            getMembershipMock.mockReturnValue([bob, bob2, carl, david]);
            encryptionManager.onMembershipsUpdate();

            // Wait past the delay period of the ongoing rollout and the jitter of the rotation it triggers...
            await vi.advanceTimersByTimeAsync(useKeyDelay + gracePeriodMsFor(4, 3000));
            // ...and past the delay period of that second rotation
            await vi.advanceTimersByTimeAsync(useKeyDelay);

            // CARLDEVICE joined while key 0 was in use: it gets that key right away so that it can decrypt,
            // then the rotation to key 1 and the one triggered by DAVDEVICE (key 2).
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 0, "@carl:example.org", "CARLDEVICE");
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 1, "@carl:example.org", "CARLDEVICE");
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 2, "@carl:example.org", "CARLDEVICE");

            // DAVDEVICE joined while key 1 was in use, so it never sees key 0
            expectKeyAtIndexNotToHaveBeenSentTo(mockTransport, 0, "@david:example.org", "DAVDEVICE");
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 1, "@david:example.org", "DAVDEVICE");
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 2, "@david:example.org", "DAVDEVICE");

            // Both rotations have been rolled out locally, in order
            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(2);
            expect(onEncryptionKeysChanged).toHaveBeenNthCalledWith(
                1,
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );
            expect(onEncryptionKeysChanged).toHaveBeenNthCalledWith(
                2,
                expect.any(Uint8Array<ArrayBufferLike>),
                2,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );
        });

        it("Should rotate key when a user join past the rotation grace period", async () => {
            vi.useFakeTimers();
            // Make the jitter deterministic: half of the grace period
            const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // With 3 participants and this contingent the grace period is 6s
            const gracePeriod = gracePeriodMsFor(3);
            // initial rollout
            encryptionManager.join({ sharedPerMinuteToDeviceContingent: TEST_CONTINGENT });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();
            randomSpy.mockClear();

            await vi.advanceTimersByTimeAsync(gracePeriod);
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // The current key is shared with the new joiner right away, so that they can decrypt our media
            // while we wait for the jitter delay.
            expect(mockTransport.sendKey).toHaveBeenCalledExactlyOnceWith(expect.any(String), 0, [
                { userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1000 },
            ]);
            // This is the first membership change in a while: every participant would rotate at the same time,
            // so the rotation is delayed by `gracePeriod * Math.random()`.
            expect(randomSpy).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(gracePeriod * 0.5 - 1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(2);
            expect(mockTransport.sendKey).toHaveBeenLastCalledWith(
                expect.any(String),
                // It should have incremented the key index
                1,
                // And send it to everyone
                [
                    expect.objectContaining({ userId: "@bob:example.org", deviceId: "BOBDEVICE" }),
                    expect.objectContaining({ userId: "@bob:example.org", deviceId: "BOBDEVICE2" }),
                    expect.objectContaining({ userId: "@carl:example.org", deviceId: "CARLDEVICE" }),
                ],
            );

            // Wait for useKeyDelay to pass
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(5000);

            expect(onEncryptionKeysChanged).toHaveBeenCalledExactlyOnceWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );
        });

        it("Should not rotate key when several users join within the rotation grace period", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // initial rollout. With this contingent the grace period is 6s for 3 participants and grows up to 42s
            // for 7, so all the joins below land inside the grace period of the very first key.
            encryptionManager.join({ sharedPerMinuteToDeviceContingent: TEST_CONTINGENT });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            const newJoiners = [
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
                aStateBaseMembership("@dave:example.org", "DAVEDEVICE"),
                aStateBaseMembership("@eve:example.org", "EVEDEVICE"),
                aStateBaseMembership("@frank:example.org", "FRANKDEVICE"),
                aStateBaseMembership("@george:example.org", "GEORGEDEVICE"),
            ];

            for (const newJoiner of newJoiners) {
                members.push(newJoiner);
                getMembershipMock.mockReturnValue(members);
                await vi.advanceTimersByTimeAsync(1_000);
                encryptionManager.onMembershipsUpdate();
                await vi.advanceTimersByTimeAsync(1);
            }

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(newJoiners.length);

            for (const newJoiner of newJoiners) {
                expect(mockTransport.sendKey).toHaveBeenCalledWith(
                    expect.any(String),
                    // It should not have incremented the key index
                    0,
                    // And send it to the new joiners only
                    expect.arrayContaining([
                        expect.objectContaining({ userId: newJoiner.sender, deviceId: newJoiner.deviceId }),
                    ]),
                );
            }

            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
        });

        it("Should not resend keys when no changes", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // initial rollout
            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(200);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(100);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(50);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(100);

            expect(mockTransport.sendKey).not.toHaveBeenCalled();
        });

        it("Should rotate key when a user leaves and delay the rollout", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(10);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );
            // initial rollout
            expect(mockTransport.sendKey).toHaveBeenCalled();
            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(1);
            onEncryptionKeysChanged.mockClear();

            const updatedMembers = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(updatedMembers);

            encryptionManager.onMembershipsUpdate();

            await vi.advanceTimersByTimeAsync(200);
            // The is rotated but not rolled out yet to give time for the key to be sent
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It should have incremented the key index
                1,
                // And send it to the updated members
                updatedMembers.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );

            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);

            // now should be rolled out
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                {
                    userId: "@alice:example.org",
                    deviceId: "DEVICE01",
                    memberId: "@alice:example.org:DEVICE01",
                },
                "@alice:example.org:DEVICE01",
            );
        });

        it("Should not rotate key when a user joins and the participant limit is reached", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            // With 4 participants and this contingent the grace period is 12s
            const gracePeriod = gracePeriodMsFor(4);
            // initial rollout
            encryptionManager.join({
                sharedPerMinuteToDeviceContingent: TEST_CONTINGENT,
                keyRotationParticipantLimit: 4,
            });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            // Well past the grace period, so only the participant limit can prevent a rotation here
            await vi.advanceTimersByTimeAsync(gracePeriod + 5_000);
            members.push(aStateBaseMembership("@dave:example.org", "DAVEDEVICE"));
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // The key index should not have been incremented
                0,
                // And the existing key only sent to the new joiner
                [expect.objectContaining({ userId: "@dave:example.org", deviceId: "DAVEDEVICE" })],
            );

            // The key has not changed, so there is nothing to roll out locally
            await vi.advanceTimersByTimeAsync(5_000);
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
        });

        it("Should rotate key when a user joins and the participant limit is not reached yet", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // With 3 participants and this contingent the grace period is 6s
            const gracePeriod = gracePeriodMsFor(3);
            // initial rollout
            encryptionManager.join({
                sharedPerMinuteToDeviceContingent: TEST_CONTINGENT,
                keyRotationParticipantLimit: 4,
            });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            await vi.advanceTimersByTimeAsync(gracePeriod);
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            encryptionManager.onMembershipsUpdate();
            // Wait out the jitter delay, which is at most one grace period
            await vi.advanceTimersByTimeAsync(gracePeriod);

            // 3 participants is still below the limit of 4, so this rotates as usual
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                1,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );

            await vi.advanceTimersByTimeAsync(5_000);
            expect(onEncryptionKeysChanged).toHaveBeenCalled();
        });

        it("Should not rotate key when a user leaves and the participant limit is reached", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
                aStateBaseMembership("@dave:example.org", "DAVEDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            // initial rollout
            encryptionManager.join({ keyRotationParticipantLimit: 3 });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            // Dave leaves, 3 participants are left which is still at the limit
            getMembershipMock.mockReturnValue(members.slice(0, 3));
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(5_000);

            expect(mockTransport.sendKey).not.toHaveBeenCalled();
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
        });

        it("Should rotate key once the session shrinks below the participant limit", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
                aStateBaseMembership("@dave:example.org", "DAVEDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            // initial rollout
            encryptionManager.join({ keyRotationParticipantLimit: 3 });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            mockTransport.sendKey.mockClear();

            // Dave leaves, the rotation is suppressed as we are still at the limit
            getMembershipMock.mockReturnValue(members.slice(0, 3));
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(mockTransport.sendKey).not.toHaveBeenCalled();

            // Carl leaves as well, we are now below the limit and the key is rotated. Dave, who left while we
            // were above the limit, is excluded by this rotation too.
            const remaining = members.slice(0, 2);
            getMembershipMock.mockReturnValue(remaining);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(5_000);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                1,
                remaining.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );
        });

        it("Should expose whether key rotation is suppressed", () => {
            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join({ keyRotationParticipantLimit: 3 });
            expect(encryptionManager.isKeyRotationSuppressed).toBe(false);

            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            expect(encryptionManager.isKeyRotationSuppressed).toBe(true);

            getMembershipMock.mockReturnValue(members.slice(0, 2));
            expect(encryptionManager.isKeyRotationSuppressed).toBe(false);
        });

        it("Should never report key rotation as suppressed if encryption is disabled", () => {
            getMembershipMock.mockReturnValue([
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
            ]);

            encryptionManager.join({ manageMediaKeys: false, keyRotationParticipantLimit: 3 });

            expect(encryptionManager.isKeyRotationSuppressed).toBe(false);
        });

        it("Should not distribute keys if encryption is disabled", async () => {
            vi.useFakeTimers();
            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
                aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join({ manageMediaKeys: false });
            encryptionManager.onMembershipsUpdate();
            await vi.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).not.toHaveBeenCalled();
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
        });
    });

    describe("Rotation delays", () => {
        const bob = aStateBaseMembership("@bob:example.org", "BOBDEVICE");
        const bob2 = aStateBaseMembership("@bob:example.org", "BOBDEVICE2");
        const carl = aStateBaseMembership("@carl:example.org", "CARLDEVICE");
        const dave = aStateBaseMembership("@dave:example.org", "DAVEDEVICE");
        const eve = aStateBaseMembership("@eve:example.org", "EVEDEVICE");

        const useKeyDelay = 1_000;

        it("Should do a full rotation after a jitter delay when a user leaves", async () => {
            vi.useFakeTimers();
            // The jitter is `gracePeriod * Math.random()`, so 90% of the grace period here
            const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.9);

            getMembershipMock.mockReturnValue([bob, bob2, carl]);
            encryptionManager.join({ sharedPerMinuteToDeviceContingent: TEST_CONTINGENT, useKeyDelay });

            // Initial rollout: the first key is distributed as is, there is nothing to rotate away from.
            encryptionManager.onMembershipsUpdate();
            await flushPromises();
            expect(mockTransport.sendKey).toHaveBeenCalledExactlyOnceWith(expect.any(String), 0, [
                participantInfo(bob),
                participantInfo(bob2),
                participantInfo(carl),
            ]);
            expect(onEncryptionKeysChanged).toHaveBeenCalledExactlyOnceWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );
            mockTransport.sendKey.mockClear();
            onEncryptionKeysChanged.mockClear();
            randomSpy.mockClear();

            // Nothing happens for a while: the current key gets older than the grace period. The grace period of
            // the session we are about to have (2 remaining participants) is 2s.
            const gracePeriod = gracePeriodMsFor(2);
            await vi.advanceTimersByTimeAsync(gracePeriod);

            // Carl leaves. Every other participant sees that at the same time and would rotate at the same time,
            // so we delay our rotation by a random part of the grace period instead of rotating right away.
            getMembershipMock.mockReturnValue([bob, bob2]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(randomSpy).toHaveBeenCalledTimes(1);
            // Nothing is sent in the meantime: there is no joiner to share the current key with.
            expect(mockTransport.sendKey).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(gracePeriod * 0.9 - 1);
            expect(mockTransport.sendKey).not.toHaveBeenCalled();

            // The jitter delay has elapsed: a new key is created and sent to the remaining participants only.
            await vi.advanceTimersByTimeAsync(1);
            expect(mockTransport.sendKey).toHaveBeenCalledExactlyOnceWith(expect.any(String), 1, [
                participantInfo(bob),
                participantInfo(bob2),
            ]);

            // It is only used locally after the `useKeyDelay`, to give the other participants time to receive it.
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(useKeyDelay);
            expect(onEncryptionKeysChanged).toHaveBeenCalledExactlyOnceWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );
        });

        it("Should rotate consecutively without any jitter when the membership keeps changing inside the grace period", async () => {
            vi.useFakeTimers();
            // Only used to prove that no jitter delay is involved in this scenario
            const randomSpy = vi.spyOn(Math, "random");

            getMembershipMock.mockReturnValue([bob, bob2]);
            encryptionManager.join({ sharedPerMinuteToDeviceContingent: TEST_CONTINGENT, useKeyDelay });

            // Initial rollout of key 0 at T+0
            encryptionManager.onMembershipsUpdate();
            await flushPromises();
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);

            // Carl joins 100ms later, well inside the grace period of key 0 (6s for 3 participants)
            await vi.advanceTimersByTimeAsync(100);
            getMembershipMock.mockReturnValue([bob, bob2, carl]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // Dave joins 100ms after that, again inside the grace period (12s for 4 participants)
            await vi.advanceTimersByTimeAsync(100);
            getMembershipMock.mockReturnValue([bob, bob2, carl, dave]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // Both of them only got the current key, no rotation happened yet...
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(3);
            expect(mockTransport.sendKey).toHaveBeenNthCalledWith(2, expect.any(String), 0, [participantInfo(carl)]);
            expect(mockTransport.sendKey).toHaveBeenNthCalledWith(3, expect.any(String), 0, [participantInfo(dave)]);
            // ...and the pending rotation is not jittered, the grace period delay already spreads it out.
            expect(randomSpy).not.toHaveBeenCalled();

            // The rotation happens when key 0 leaves the grace period of the session it belongs to
            // (12s for the 4 participants we have now), and not before.
            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(4) - 200 - 1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(3);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(4);
            expect(mockTransport.sendKey).toHaveBeenLastCalledWith(expect.any(String), 1, [
                participantInfo(bob),
                participantInfo(bob2),
                participantInfo(carl),
                participantInfo(dave),
            ]);
            await vi.advanceTimersByTimeAsync(useKeyDelay);
            expect(onEncryptionKeysChanged).toHaveBeenLastCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );

            // Eve joins 100ms later, inside the grace period of the key we just rotated to.
            // The same thing happens again: the current key is shared with her and the rotation is deferred to the
            // end of the grace period of key 1 (20s for 5 participants), again without any jitter.
            await vi.advanceTimersByTimeAsync(100);
            getMembershipMock.mockReturnValue([bob, bob2, carl, dave, eve]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(5);
            expect(mockTransport.sendKey).toHaveBeenLastCalledWith(expect.any(String), 1, [participantInfo(eve)]);

            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(5) - useKeyDelay - 100 - 1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(5);

            await vi.advanceTimersByTimeAsync(1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(6);
            expect(mockTransport.sendKey).toHaveBeenLastCalledWith(expect.any(String), 2, [
                participantInfo(bob),
                participantInfo(bob2),
                participantInfo(carl),
                participantInfo(dave),
                participantInfo(eve),
            ]);

            await vi.advanceTimersByTimeAsync(useKeyDelay);
            expect(onEncryptionKeysChanged).toHaveBeenLastCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                2,
                OWN_MEMBERSHIP,
                OWN_RTC_BACKEND_IDENTITY,
            );

            // The two rotations were driven by the grace period only, `Math.random` was never consulted.
            expect(randomSpy).not.toHaveBeenCalled();
        });
    });

    describe("Receiving Keys", () => {
        beforeEach(() => {
            const emitter = new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>();
            mockTransport = {
                start: vi.fn(),
                stop: vi.fn(),
                sendKey: vi.fn().mockResolvedValue(undefined),
                on: emitter.on.bind(emitter),
                off: emitter.off.bind(emitter),
                emit: emitter.emit.bind(emitter),
            } as unknown as Mocked<ToDeviceKeyTransport>;
            encryptionManager = new RTCEncryptionManager(
                { userId: "@alice:example.org", deviceId: "DEVICE01", memberId: "@alice:example.org:DEVICE01" },
                getMembershipMock,
                mockTransport,
                onEncryptionKeysChanged,
            );
        });

        it("should not accept keys when manageMediaKeys is disabled", async () => {
            vi.useFakeTimers();

            const members = [aStateBaseMembership("@bob:example.org", "BOBDEVICE")];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join({ manageMediaKeys: false });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(10);

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@bob:example.org", deviceId: "BOBDEVICE", memberId: "@bob:example.org:BOBDEVICE" },
                "AAAAAAAAAAA",
                0 /* KeyId */,
                0 /* Timestamp */,
            );

            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
        });

        it("should accept keys from transport", async () => {
            vi.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE", 1000, "rtcIDBOB1"),
                aCallMembership("@bob:example.org", "BOBDEVICE2", 1000, "rtcIDBOB2"),
                aCallMembership("@carl:example.org", "CARLDEVICE", 1000, "rtcIDCARL1"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(10);

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@bob:example.org", deviceId: "BOBDEVICE", memberId: "@bob:example.org:BOBDEVICE" },
                "AAAAAAAAAAA",
                0 /* KeyId */,
                0 /* Timestamp */,
            );
            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@bob:example.org", deviceId: "BOBDEVICE2", memberId: "@bob:example.org:BOBDEVICE2" },
                "BBBBBBBBBBB",
                4 /* KeyId */,
                0 /* Timestamp */,
            );
            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@carl:example.org", deviceId: "CARLDEVICE", memberId: "@carl:example.org:CARLDEVICE" },
                "CCCCCCCCCC",
                8 /* KeyId */,
                0 /* Timestamp */,
            );

            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(4);
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("AAAAAAAAAAA"),
                0,
                {
                    userId: "@bob:example.org",
                    deviceId: "BOBDEVICE",
                    memberId: "@bob:example.org:BOBDEVICE",
                },
                "rtcIDBOB1",
            );

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("BBBBBBBBBBB"),
                4,
                {
                    userId: "@bob:example.org",
                    deviceId: "BOBDEVICE2",
                    memberId: "@bob:example.org:BOBDEVICE2",
                },
                "rtcIDBOB2",
            );

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("CCCCCCCCCC"),
                8,
                {
                    userId: "@carl:example.org",
                    deviceId: "CARLDEVICE",
                    memberId: "@carl:example.org:CARLDEVICE",
                },
                "rtcIDCARL1",
            );
        });

        it("Should support quick re-joiner if keys received out of order", async () => {
            vi.useFakeTimers();

            const members = [aStateBaseMembership("@carol:example.org", "CAROLDEVICE")];
            getMembershipMock.mockReturnValue(members);

            // Let's join
            encryptionManager.join(undefined);
            await vi.advanceTimersByTimeAsync(10);

            // Simulate Carl leaving then joining back, and key received out of order
            // XXX This can only happen in legacy because with sticky events the rtcBackendIdentity would be different.
            const initialKey0TimeStamp = 1000;
            const newKey0TimeStamp = 2000;

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@carol:example.org", deviceId: "CAROLDEVICE", memberId: "@carol:example.org:CAROLDEVICE" },
                "BBBBBBBBBBB",
                0 /* KeyId */,
                newKey0TimeStamp,
            );

            await vi.advanceTimersByTimeAsync(20);

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@carol:example.org", deviceId: "CAROLDEVICE", memberId: "@carol:example.org:CAROLDEVICE" },
                "AAAAAAAAAAA",
                0 /* KeyId */,
                initialKey0TimeStamp,
            );

            await vi.advanceTimersByTimeAsync(20);

            // The latest key used for carol should be the one with the latest timestamp

            expect(onEncryptionKeysChanged).toHaveBeenLastCalledWith(
                decodeBase64("BBBBBBBBBBB"),
                0,
                {
                    userId: "@carol:example.org",
                    deviceId: "CAROLDEVICE",
                    memberId: "@carol:example.org:CAROLDEVICE",
                },
                "@carol:example.org|CAROLDEVICE",
            );
        });

        it("Should store keys for later retrieval", async () => {
            vi.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE", 1000, "@bob:example.org|BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2", 1000, "@bob:example.org|BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE", 1000, "@carl:example.org|CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            // Let's join
            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate();

            await vi.advanceTimersByTimeAsync(10);

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@carl:example.org", deviceId: "CARLDEVICE", memberId: "@carl:example.org:CARLDEVICE" },
                "BBBBBBBBBBB",
                0 /* KeyId */,
                1000,
            );

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@carl:example.org", deviceId: "CARLDEVICE", memberId: "@carl:example.org:CARLDEVICE" },
                "CCCCCCCCCCC",
                5 /* KeyId */,
                1000,
            );

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@bob:example.org", deviceId: "BOBDEVICE2", memberId: "@bob:example.org:BOBDEVICE2" },
                "DDDDDDDDDDD",
                0 /* KeyId */,
                1000,
            );

            const knownKeys = encryptionManager.getEncryptionKeys();

            // My own key should be there
            const myRing = knownKeys.get(
                getEncryptionKeyMapKey({
                    userId: "@alice:example.org",
                    deviceId: "DEVICE01",
                    memberId: "@alice:example.org:DEVICE01",
                }),
            );
            expect(myRing).toBeDefined();
            expect(myRing).toHaveLength(1);
            expect(myRing![0]).toMatchObject(
                expect.objectContaining({
                    keyIndex: 0,
                    key: expect.any(Uint8Array),
                }),
            );

            const carlRing = knownKeys.get(
                getEncryptionKeyMapKey({
                    userId: "@carl:example.org",
                    deviceId: "CARLDEVICE",
                    memberId: "@carl:example.org:CARLDEVICE",
                }),
            );
            expect(carlRing).toBeDefined();
            expect(carlRing).toHaveLength(2);
            expect(carlRing![0]).toMatchObject(
                expect.objectContaining({
                    keyIndex: 0,
                    key: decodeBase64("BBBBBBBBBBB"),
                }),
            );
            expect(carlRing![1]).toMatchObject(
                expect.objectContaining({
                    keyIndex: 5,
                    key: decodeBase64("CCCCCCCCCCC"),
                }),
            );

            const bobRing = knownKeys.get(
                getEncryptionKeyMapKey({
                    userId: "@bob:example.org",
                    deviceId: "BOBDEVICE2",
                    memberId: "@bob:example.org:BOBDEVICE2",
                }),
            );
            expect(bobRing).toBeDefined();
            expect(bobRing).toHaveLength(1);
            expect(bobRing![0]).toMatchObject(
                expect.objectContaining({
                    keyIndex: 0,
                    key: decodeBase64("DDDDDDDDDDD"),
                }),
            );

            const bob1Ring = knownKeys.get(
                getEncryptionKeyMapKey({
                    userId: "@bob:example.org",
                    deviceId: "BOBDEVICE",
                    memberId: "@bob:example.org:BOBDEVICE",
                }),
            );
            expect(bob1Ring).not.toBeDefined();
        });
    });

    it("Should only rotate once again if several membership changes during a rollout", async () => {
        vi.useFakeTimers();

        let members = [
            aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
            aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            aStateBaseMembership("@carl:example.org", "CARLDEVICE"),
        ];
        getMembershipMock.mockReturnValue(members);

        // Let's join
        encryptionManager.join(undefined);
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // The initial rollout
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            0,
            {
                deviceId: "DEVICE01",
                memberId: "@alice:example.org:DEVICE01",
                userId: "@alice:example.org",
            },
            "@alice:example.org:DEVICE01",
        );
        onEncryptionKeysChanged.mockClear();

        // Trigger a key rotation with a leaver
        members = [
            aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
            aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
        ];
        getMembershipMock.mockReturnValue(members);

        // This should start a new key rollout
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // Now simulate a new leaver
        members = [aStateBaseMembership("@bob:example.org", "BOBDEVICE")];
        getMembershipMock.mockReturnValue(members);

        // The key `1` rollout is in progress
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // And another one ( plus a joiner)
        const lastMembership = [aStateBaseMembership("@bob:example.org", "BOBDEVICE3")];
        getMembershipMock.mockReturnValue(lastMembership);
        // The key `1` rollout is still in progress
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // Let all rollouts finish
        await vi.advanceTimersByTimeAsync(2000);

        // There should 2 rollout. The `1` rollout, then just one additional one
        // that has "buffered" the 2 membership changes with leavers
        expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(2);
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            1,
            {
                deviceId: "DEVICE01",
                userId: "@alice:example.org",
                memberId: "@alice:example.org:DEVICE01",
            },
            "@alice:example.org:DEVICE01",
        );
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            2,
            {
                deviceId: "DEVICE01",
                memberId: "@alice:example.org:DEVICE01",
                userId: "@alice:example.org",
            },
            "@alice:example.org:DEVICE01",
        );

        // Key `2` should only be distributed to the last membership
        expect(mockTransport.sendKey).toHaveBeenLastCalledWith(
            expect.any(String),
            2,
            // And send only to the last membership
            [
                {
                    userId: "@bob:example.org",
                    deviceId: "BOBDEVICE3",
                    membershipTs: 1000,
                },
            ],
        );
    });

    describe("RTC backend pseudonymous id", () => {
        it("Should use pseudo rtcBackendIdentity if using sticky events", async () => {
            getMembershipMock.mockReturnValue([]);
            encryptionManager.join({
                manageMediaKeys: true,
                unstableSendStickyEvents: true,
            });
            encryptionManager.onMembershipsUpdate();

            await flushPromises();

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                {
                    deviceId: "DEVICE01",
                    userId: "@alice:example.org",
                    memberId: "@alice:example.org:DEVICE01",
                },
                "MOCKSHA<@alice:example.org|DEVICE01|@alice:example.org:DEVICE01>",
            );
        });

        it("Should use legacy participant id if not using sticky event", async () => {
            getMembershipMock.mockReturnValue([]);
            encryptionManager.join({
                manageMediaKeys: true,
                unstableSendStickyEvents: false,
            });
            encryptionManager.onMembershipsUpdate();

            await flushPromises();

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                {
                    deviceId: "DEVICE01",
                    userId: "@alice:example.org",
                    memberId: "@alice:example.org:DEVICE01",
                },
                "@alice:example.org:DEVICE01",
            );
        });

        it("Should use early keys as soon as the membership is known", async () => {
            const emitter = new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>();
            mockTransport = {
                start: vi.fn(),
                stop: vi.fn(),
                sendKey: vi.fn().mockResolvedValue(undefined),
                on: emitter.on.bind(emitter),
                off: emitter.off.bind(emitter),
                emit: emitter.emit.bind(emitter),
            } as unknown as Mocked<ToDeviceKeyTransport>;

            encryptionManager = new RTCEncryptionManager(
                { userId: "@alice:example.org", deviceId: "DEVICE01", memberId: "@alice:example.org:DEVICE01" },
                getMembershipMock,
                mockTransport,
                onEncryptionKeysChanged,
                logger,
                rtcIdentifierProvider,
            );

            getMembershipMock.mockReturnValue([]);
            encryptionManager.join({
                manageMediaKeys: true,
                unstableSendStickyEvents: true,
            });
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // In 2.0 mode the participant identity is pseudo hashed and known from
            // the rtc membership itself. If a key is received before we have processed
            // the membership, we cannot pass it to the media layer yet because we don't know
            // the rtcBackendIdentity to use.
            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                { userId: "@bob:example.org", deviceId: "BOBDEVICE", memberId: "@bob:example.org:BOBDEVICE" },
                "AAAAAAAAAAA",
                0 /* KeyId */,
                0 /* Timestamp */,
            );

            await flushPromises();

            // No membership yet, cannot process the key, so should not have called the callback
            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(1 /* only own key */);
            expect(onEncryptionKeysChanged).not.toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                {
                    deviceId: "BOBDEVICE",
                    userId: "@bob:example.org",
                    memberId: "@bob:example.org:BOBDEVICE",
                },
                expect.any(String),
            );

            // Now process membership
            const bobRtcId = "MOCKSHA<@bob:example.org|BOBDEVICE|@bob:example.org:BOBDEVICE>";
            const members = [aCallMembership("@bob:example.org", "BOBDEVICE", 1000, bobRtcId)];
            getMembershipMock.mockReturnValue(members);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(2);
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                {
                    deviceId: "BOBDEVICE",
                    userId: "@bob:example.org",
                    memberId: "@bob:example.org:BOBDEVICE",
                },
                bobRtcId,
            );
        });
    });

    function aCallMembership(
        userId: string,
        deviceId: string,
        ts: number = 1000,
        rtcBackendIdentity: string,
    ): CallMembership {
        return mockCallMembership(
            { ...sessionMembershipTemplate, user_id: userId, device_id: deviceId, created_ts: ts },
            "!room:id",
            rtcBackendIdentity,
        );
    }

    /**
     * Creates a basic state membership event for the given user and device.
     * The rtcBackendIdentity is derived from userId and deviceId as `${userId}|${deviceId}`
     * @param userId
     * @param deviceId
     * @param ts
     */
    function aStateBaseMembership(userId: string, deviceId: string, ts: number = 1000): CallMembership {
        return mockCallMembership(
            { ...sessionMembershipTemplate, user_id: userId, device_id: deviceId, created_ts: ts },
            "!room:id",
            `${userId}|${deviceId}`,
        );
    }
});

function expectKeyAtIndexToHaveBeenSentTo(
    mockTransport: Mocked<ToDeviceKeyTransport>,
    index: number,
    userId: string,
    deviceId: string,
) {
    expect(mockTransport.sendKey).toHaveBeenCalledWith(
        expect.any(String),
        index,
        expect.arrayContaining([expect.objectContaining({ userId, deviceId })]),
    );
}

function expectKeyAtIndexNotToHaveBeenSentTo(
    mockTransport: Mocked<ToDeviceKeyTransport>,
    index: number,
    userId: string,
    deviceId: string,
) {
    expect(mockTransport.sendKey).not.toHaveBeenCalledWith(
        expect.any(String),
        index,
        expect.arrayContaining([expect.objectContaining({ userId, deviceId })]),
    );
}
