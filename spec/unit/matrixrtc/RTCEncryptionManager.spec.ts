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
import { type ParticipantDeviceInfo } from "../../../src/matrixrtc/types.ts";
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

        // The manager blocks every rotation for `rotationInterval * Math.random() * 2` to spread the clients
        // of a session out. Pin the draw to 0.5, so that rotations are blocked for exactly one rotation
        // interval; tests that are about the jitter itself override this.
        vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    afterEach(() => {
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
            // With a single other participant the rotation interval is 0ms, so the block expires immediately.
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

            // The first key blocks rotations for one rotation interval (the jitter draw is pinned in
            // `beforeEach`) of the 2 participant session it is created in: 2s with this contingent.
            const blockMs = gracePeriodMsFor(2);
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

            // Carl joins, while the rotation is still blocked
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            await vi.advanceTimersByTimeAsync(blockMs / 2 - 1);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(mockTransport.sendKey).toHaveBeenCalledExactlyOnceWith(
                expect.any(String),
                // It should not have incremented the key index
                0,
                // And send it to the newly joined only
                [{ userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1000 }],
            );

            // The rotation is deferred to the end of the block, not skipped: nothing happens before that.
            await vi.advanceTimersByTimeAsync(blockMs / 2 - 1);
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();

            // Now the block started by the first key is over, the key is rotated for everyone.
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

            // Wait until the block started by the first key has long expired
            await vi.advanceTimersByTimeAsync(gracePeriod);
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // The current key is shared with the new joiner right away, so that they can decrypt our media
            // while the rotation is blocked for one more rotation interval (of the now 3 participant session).
            expect(mockTransport.sendKey).toHaveBeenCalledExactlyOnceWith(expect.any(String), 0, [
                { userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1000 },
            ]);

            await vi.advanceTimersByTimeAsync(gracePeriod - 1);
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

            // initial rollout. The first key blocks rotations for one rotation interval of the 2 participant
            // session it is created in (2s), and all the joins below land inside that block.
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
                await vi.advanceTimersByTimeAsync(300);
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
            // Wait out the rotation block: with the pinned jitter draw it ends one rotation interval after the join
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
            // A rotation is blocked for `rotationInterval * Math.random() * 2`: a draw of 0.9 blocks for
            // 1.8 rotation intervals.
            vi.spyOn(Math, "random").mockReturnValue(0.9);
            const jitterFactor = 0.9 * 2;

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

            // Nothing happens until the block started by the first key (1.8 rotation intervals of the
            // 3 participant session) has expired.
            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(3) * jitterFactor);

            // Carl leaves. Every other participant sees that at the same moment and would rotate at the same
            // moment, so instead of rotating right away the rotation is blocked for another jittered delay
            // (1.8 rotation intervals of the now 2 participant session: 3.6s).
            getMembershipMock.mockReturnValue([bob, bob2]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // Nothing is sent in the meantime: there is no joiner to share the current key with.
            expect(mockTransport.sendKey).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(2) * jitterFactor - 1);
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

        it("Should rotate consecutively without any extra delay when the membership keeps changing inside the grace period", async () => {
            vi.useFakeTimers();

            getMembershipMock.mockReturnValue([bob, bob2]);
            encryptionManager.join({ sharedPerMinuteToDeviceContingent: TEST_CONTINGENT, useKeyDelay });

            // Initial rollout of key 0 at T+0. It blocks rotations for one rotation interval of the
            // 2 participant session it is created in: 2s (the jitter draw is pinned in `beforeEach`).
            encryptionManager.onMembershipsUpdate();
            await flushPromises();
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);

            // Carl joins 100ms later, well inside the block
            await vi.advanceTimersByTimeAsync(100);
            getMembershipMock.mockReturnValue([bob, bob2, carl]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // Dave joins 100ms after that, still inside the block
            await vi.advanceTimersByTimeAsync(100);
            getMembershipMock.mockReturnValue([bob, bob2, carl, dave]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            // Both of them only got the current key, no rotation happened yet...
            expect(mockTransport.sendKey).toHaveBeenCalledTimes(3);
            expect(mockTransport.sendKey).toHaveBeenNthCalledWith(2, expect.any(String), 0, [participantInfo(carl)]);
            expect(mockTransport.sendKey).toHaveBeenNthCalledWith(3, expect.any(String), 0, [participantInfo(dave)]);

            // The rotation happens when the block started by key 0 ends, and not before. Neither of the two
            // joins moved that deadline, and neither of them earned a second delay of its own.
            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(2) - 200 - 1);
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

            // Eve joins 100ms after the rollout of key 1 has finished. The same thing happens again: she gets
            // the current key right away, and the rotation is deferred to the end of the block started by the
            // rotation to key 1 (one rotation interval of the 4 participant session: 12s after that rotation).
            await vi.advanceTimersByTimeAsync(100);
            getMembershipMock.mockReturnValue([bob, bob2, carl, dave, eve]);
            encryptionManager.onMembershipsUpdate();
            await flushPromises();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(5);
            expect(mockTransport.sendKey).toHaveBeenLastCalledWith(expect.any(String), 1, [participantInfo(eve)]);

            // Key 1 was created at T+2000, so its block ends at T+2000+12000. We are at T+3100.
            await vi.advanceTimersByTimeAsync(gracePeriodMsFor(4) - useKeyDelay - 100 - 1);
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
        });
    });

    describe("To-device rate in a simulated call", () => {
        /**
         * The simulation runs on the contingent a client gets when it configures nothing, so that what it
         * measures is what a deployment would really see. The rotation intervals it implies
         * (`60_000 * N * (N - 1) / contingent`) are:
         *  - 100 participants: 3.3min
         *  - 300 participants: 29.9min
         * None of that costs anything to simulate, the fake timers jump straight from one scheduled wake up
         * to the next.
         */
        // Mirrors the default of `EncryptionConfig.sharedPerMinuteToDeviceContingent`. It would be better
        // for the manager to export this, so that the two cannot drift apart.
        const SIMULATION_CONTINGENT = 3000;
        const graceFor = (participantCount: number): number =>
            gracePeriodMsFor(participantCount, SIMULATION_CONTINGENT);

        /** The call sizes we simulate, one after the other. */
        const CALL_SIZES = [10, 100, 300];

        /**
         * How many participants of a call actually get their own encryption manager.
         *
         * Every client runs the same algorithm on the same view of the memberships, so a sample of them
         * characterises the whole call; the recorded traffic is scaled up by `participants / simulated clients`
         * to get the numbers the homeserver would really see. Running all 300 managers of the biggest call
         * takes more than a minute, this keeps the test at a few seconds.
         */
        const SIMULATED_CLIENTS = 25;

        /**
         * The call fills up in {@link RAMP_UP_STEPS} steps of this length, rather than everybody joining at
         * once. Sync delivers membership updates in batches, so a step adds a few participants at a time.
         */
        const JOIN_INTERVAL_MS = 50;
        const RAMP_UP_STEPS = 50;

        /**
         * Everything after the ramp up is measured in multiples of the rotation interval of the call being
         * simulated, because with the real contingent that interval spans three orders of magnitude
         * (1.8s for 10 participants, 3.3min for 100, 29.9min for 300). A phase that is long enough to see a
         * 300 participant call rotate would need hundreds of thousands of membership changes at a rate that
         * makes sense for a 10 participant one.
         */
        /** Membership changes arrive four times as fast as a client is allowed to rotate. */
        const CHANGES_PER_INTERVAL = 4;
        /** How many rotation intervals the memberships keep changing for. */
        const TOGGLING_INTERVALS = 6;
        /**
         * How many rotation intervals the memberships are then left alone for. Has to exceed the worst case
         * for the last postponed rotation, which is two intervals, so that "nothing happens any more" is
         * actually asserted over a meaningful stretch of time.
         */
        const QUIET_INTERVALS = 3;
        /** How long the ramp up is given to play out before the measurement starts. */
        const SETTLE_INTERVALS = 3;

        /** The timings a call of `participantCount` participants is simulated with. */
        function timingsFor(participantCount: number) {
            // The call oscillates between `participantCount` and one more, so its rotation interval does too.
            // Everything is derived from the smaller one, the shortest interval the call can use.
            const rotationIntervalMs = graceFor(participantCount);
            return {
                rotationIntervalMs,
                toggleIntervalMs: rotationIntervalMs / CHANGES_PER_INTERVAL,
                togglingMs: rotationIntervalMs * TOGGLING_INTERVALS,
                quietMs: rotationIntervalMs * QUIET_INTERVALS,
                phaseMs: rotationIntervalMs * (TOGGLING_INTERVALS + QUIET_INTERVALS),
            };
        }

        /** One `sendKey` call of one simulated client. */
        interface KeyShare {
            /** When the key was sent, relative to the start of the measured phase. */
            time: number;
            /** Device id of the client that sent it. */
            sender: string;
            /** How many to-device messages this share produces (the transport does not send one to ourselves). */
            toDeviceMessages: number;
            /**
             * Whether this is a rotation (a brand new key, sent to everyone) or just the current key being
             * handed to a new joiner.
             */
            isRotation: boolean;
        }

        interface SimulationResult {
            participantCount: number;
            simulatedClients: number;
            timings: ReturnType<typeof timingsFor>;
            /** Every key share of every simulated client, in the order they were sent. */
            shares: KeyShare[];
        }

        /**
         * Runs a call of `participantCount` participants and records every to-device message the simulated
         * clients send.
         *
         * The participants join one after the other, and only once they are all in and the rotations that
         * caused have run out does the measurement start.
         *
         * On top of the participants that stay for the whole simulation there is one extra participant that
         * joins and leaves {@link CHANGES_PER_INTERVAL} times per rotation interval for
         * {@link TOGGLING_INTERVALS} intervals, and is then gone for {@link QUIET_INTERVALS} of them. That
         * flapping participant has no manager of its own, we only care about how the others react to it.
         *
         * Only what happens after everybody has joined is recorded: filling up the call is not something the
         * contingent is meant to limit.
         */
        async function simulateCall(participantCount: number): Promise<SimulationResult> {
            const timings = timingsFor(participantCount);
            const participants = Array.from({ length: participantCount }, (_, i) =>
                aStateBaseMembership(`@user${i}:example.org`, `DEVICE${i}`),
            );
            const flappingParticipant = aStateBaseMembership("@flapping:example.org", "FLAPPINGDEVICE");

            let memberships: CallMembership[] = [];
            let shares: KeyShare[] = [];
            let phaseStart = 0;
            const lastKeyIndex = new Map<string, number>();

            const simulatedClients = Math.min(participantCount, SIMULATED_CLIENTS);
            // Spread the clients we simulate evenly over the joining order, so that the sample covers the
            // whole ramp up and not just the participants that were there first.
            const simulatedIndices = new Set(
                Array.from({ length: simulatedClients }, (_, i) =>
                    Math.floor((i * participantCount) / simulatedClients),
                ),
            );

            const managers: RTCEncryptionManager[] = [];
            const addManagerFor = (own: CallMembership): void => {
                const transport = {
                    start: vi.fn(),
                    stop: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    sendKey: vi.fn((_key: string, keyIndex: number, targets: ParticipantDeviceInfo[]) => {
                        const previousKeyIndex = lastKeyIndex.get(own.deviceId);
                        lastKeyIndex.set(own.deviceId, keyIndex);
                        shares.push({
                            time: Date.now() - phaseStart,
                            sender: own.deviceId,
                            // `ToDeviceKeyTransport.sendKey` filters ourselves out of the targets
                            toDeviceMessages: targets.filter((t) => t.deviceId !== own.deviceId).length,
                            isRotation: previousKeyIndex !== undefined && previousKeyIndex !== keyIndex,
                        });
                        return Promise.resolve();
                    }),
                } as unknown as Mocked<ToDeviceKeyTransport>;

                const manager = new RTCEncryptionManager(
                    { userId: own.sender, deviceId: own.deviceId, memberId: `${own.sender}:${own.deviceId}` },
                    // Like `MatrixRTCSession` does it, this includes our own membership
                    () => memberships,
                    transport,
                    () => {},
                    // No logger on purpose: this runs thousands of rollouts and assembling the log lines
                    // (some of which list every participant) would dominate the runtime of this test.
                    undefined,
                    (userId, deviceId) => Promise.resolve(`${userId}|${deviceId}`),
                );
                manager.join({
                    // Neither `sharedPerMinuteToDeviceContingent` nor `useKeyDelay`: with fake timers there
                    // is no reason not to run the simulation on the defaults a real client would use.
                    // No hard rotation limit: we want to observe the slow down, not the suppression.
                    keyRotationParticipantLimit: undefined,
                });
                managers.push(manager);
            };

            const membershipsChanged = async (): Promise<void> => {
                for (const manager of managers) manager.onMembershipsUpdate();
                await flushPromises();
            };

            // The participants trickle in a few at a time rather than all at once, which is what a call
            // really looks like. A client creates its first key when it joins, so this leaves the clients
            // with keys of different ages to start with. Note that this on its own is *not* enough to keep
            // their rotations apart: rotating is driven by membership changes, which every client observes
            // at the same moment, and two clients that once rotate in the same round share the age of their
            // key from then on and stay locked together for good.
            memberships = [];
            const joinersPerStep = Math.ceil(participantCount / RAMP_UP_STEPS);
            for (let joined = 0; joined < participantCount; joined += joinersPerStep) {
                for (const [index, participant] of participants.slice(joined, joined + joinersPerStep).entries()) {
                    memberships = [...memberships, participant];
                    if (simulatedIndices.has(joined + index)) addManagerFor(participant);
                }
                await membershipsChanged();
                await vi.advanceTimersByTimeAsync(JOIN_INTERVAL_MS);
            }

            // Let the rotations that the ramp up owes run out...
            await vi.advanceTimersByTimeAsync(SETTLE_INTERVALS * graceFor(participantCount + 1));
            // ...and only start recording from here on.
            phaseStart = Date.now();
            shares = [];

            // One participant joins and leaves over and over again.
            for (let elapsed = 0; elapsed < timings.togglingMs; elapsed += timings.toggleIntervalMs) {
                memberships = memberships.includes(flappingParticipant)
                    ? participants
                    : [...participants, flappingParticipant];
                await membershipsChanged();
                await vi.advanceTimersByTimeAsync(timings.toggleIntervalMs);
            }

            // Nothing changes anymore.
            await vi.advanceTimersByTimeAsync(timings.quietMs);

            managers.forEach((manager) => manager.leave());
            vi.clearAllTimers();
            return { participantCount, simulatedClients, timings, shares };
        }

        /** The to-device messages the whole call sent, extrapolated from the simulated clients. */
        function totalToDeviceMessages({ participantCount, simulatedClients, shares }: SimulationResult): number {
            const sampled = shares.reduce((sum, share) => sum + share.toDeviceMessages, 0);
            return (sampled * participantCount) / simulatedClients;
        }

        /** How often a single client rotated its key during the phase. */
        function rotationsPerClient({ simulatedClients, shares }: SimulationResult): number {
            return shares.filter((share) => share.isRotation).length / simulatedClients;
        }

        /** Formats a duration the way a human reads the rotation intervals of a call. */
        function humanMs(ms: number): string {
            if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`;
            return `${(ms / 1000).toFixed(1)}s`;
        }

        /**
         * Buckets the whole call's to-device traffic into a histogram, half a rotation interval per bucket:
         * a client rotates at most once per interval, so an evenly spread call puts about half of the
         * clients in each bucket, and a call that rotates in lockstep puts all of them in one.
         */
        function distribution(result: SimulationResult): Array<{ messages: number; rotations: number }> {
            const scale = result.participantCount / result.simulatedClients;
            const bucketMs = result.timings.rotationIntervalMs / 2;
            const buckets = Array.from({ length: Math.ceil(result.timings.phaseMs / bucketMs) }, () => ({
                messages: 0,
                rotations: 0,
            }));
            for (const share of result.shares) {
                const bucket = buckets[Math.floor(share.time / bucketMs)];
                if (!bucket) continue;
                bucket.messages += share.toDeviceMessages * scale;
                if (share.isRotation) bucket.rotations += scale;
            }
            return buckets;
        }

        function logDistribution(result: SimulationResult): void {
            const { rotationIntervalMs, phaseMs, togglingMs } = result.timings;
            const buckets = distribution(result);
            const bucketMs = rotationIntervalMs / 2;
            const peak = Math.max(...buckets.map((b) => b.messages), 1);
            const total = totalToDeviceMessages(result);
            const perMinute = (total / phaseMs) * 60_000;
            const rotations = result.shares.filter((share) => share.isRotation);
            const distinct = new Set(rotations.map((share) => share.time)).size;
            console.log(
                `\n${result.participantCount} participants (${result.simulatedClients} simulated), ` +
                    `rotation interval ${humanMs(rotationIntervalMs)}, ` +
                    `${rotationsPerClient(result).toFixed(1)} rotations per client over ${humanMs(phaseMs)}\n` +
                    `${total} to-device messages ` +
                    `= ${perMinute.toFixed(0)}/min of the ${SIMULATION_CONTINGENT}/min contingent\n` +
                    `${distinct} of ${rotations.length} rotations happen at a moment of their own ` +
                    `(1 of ${result.simulatedClients} would mean the whole call rotates in lockstep)`,
            );
            for (const [index, bucket] of buckets.entries()) {
                const bar = "#".repeat(Math.round((bucket.messages / peak) * 40));
                const phase = index * bucketMs < togglingMs ? "toggling" : "quiet   ";
                console.log(
                    `  ${humanMs(index * bucketMs).padStart(7)} ${phase} ${bar.padEnd(40)} ` +
                        `${String(Math.round(bucket.messages)).padStart(8)} msgs ` +
                        `${String(Math.round(bucket.rotations)).padStart(4)} rot`,
                );
            }
        }

        it("Should stay inside the contingent and stop rotating once the memberships settle", async () => {
            vi.useFakeTimers();
            // Every run explores a different set of jitter draws, but through a seeded PRNG whose seed is
            // logged, so that a failing draw can be replayed by hard coding the seed here.
            let seed = 1 + Math.floor(Math.random() * 0x7fff_fffd);
            console.log(`jitter seed: ${seed}`);
            vi.spyOn(Math, "random").mockImplementation(() => {
                seed = (seed * 48271) % 0x7fff_ffff;
                return seed / 0x7fff_ffff;
            });

            const results = new Map<number, SimulationResult>();
            for (const participantCount of CALL_SIZES) {
                results.set(participantCount, await simulateCall(participantCount));
            }

            /** The gaps between one client's consecutive rotations, for every simulated client. */
            const rotationIntervals = (result: SimulationResult): number[][] =>
                [...new Set(result.shares.map((share) => share.sender))].map((client) => {
                    const times = result.shares
                        .filter((share) => share.isRotation && share.sender === client)
                        .map((share) => share.time);
                    return times.slice(1).map((time, i) => time - times[i]);
                });

            for (const [participantCount, result] of results) {
                logDistribution(result);
                const { rotationIntervalMs, toggleIntervalMs, togglingMs, phaseMs } = result.timings;

                // Every message of a phase falls into this window: the toggling, plus at the very worst two
                // rotation intervals for the last postponed rotation (see QUIET_INTERVALS).
                const lastMembershipChange = togglingMs - toggleIntervalMs;
                const activeWindowMs = lastMembershipChange + 2 * graceFor(participantCount + 1) + 1;

                // The contingent is the number of to-device messages the whole call may send per minute.
                const perMinute = (totalToDeviceMessages(result) / activeWindowMs) * 60_000;
                expect(perMinute).toBeLessThanOrEqual(SIMULATION_CONTINGENT);

                // Every single client keeps to the rotation interval that the contingent implies. The call
                // oscillates between `participantCount` and `participantCount + 1` members, so the shortest
                // interval it can ever use is the one of the smaller session.
                // `Date.now()` is whole milliseconds, the interval usually is not, so allow the rounding.
                const intervals = rotationIntervals(result);
                expect(Math.min(...intervals.flat(), Infinity)).toBeGreaterThanOrEqual(Math.floor(rotationIntervalMs));
                // ...and does not sit idle for much longer than that either, once it owes a rotation.
                const mean = intervals.flat().reduce((a, b) => a + b, 0) / intervals.flat().length;
                expect(mean).toBeLessThanOrEqual(graceFor(participantCount + 1) * 1.5);

                // The clients do not rotate in lockstep. Every one of them rotates on its own schedule, so
                // the rotations land on their own moments in time rather than on a handful of shared ones.
                // (Before the rotations were spread out, all clients of a call shared the same timestamps and
                // this ratio was about 1/25 rather than about 1.)
                const rotations = result.shares.filter((share) => share.isRotation);
                const distinctMoments = new Set(rotations.map((share) => share.time)).size;
                expect(distinctMoments).toBeGreaterThan(rotations.length * 0.5);

                // Once the memberships stop changing, the postponed rotation is caught up on and then
                // everything goes quiet: nothing is sent for the rest of the phase.
                expect(activeWindowMs).toBeLessThan(phaseMs);
                expect(result.shares.filter((share) => share.time > activeWindowMs)).toEqual([]);
            }

            // The whole point of the contingent: the bigger the call, the further apart the rotations of a
            // single client are, because each of them costs `N - 1` to-device messages.
            const measuredInterval = (participantCount: number): number => {
                const flat = rotationIntervals(results.get(participantCount)!).flat();
                return flat.reduce((a, b) => a + b, 0) / flat.length;
            };
            expect(measuredInterval(100)).toBeGreaterThan(measuredInterval(10) * 10);
            expect(measuredInterval(300)).toBeGreaterThan(measuredInterval(100) * 5);
            // ...but a call this size never stops rotating altogether, that is what the hard participant
            // limit ({@link EncryptionConfig.keyRotationParticipantLimit}) is for.
            expect(rotationsPerClient(results.get(300)!)).toBeGreaterThan(0);
        }, 30_000);
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

    it("Should only rotate once when several membership changes happen while the rotation is blocked", async () => {
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

        // The rotation this triggers is blocked until the end of the first key's rotation interval
        // (120ms for the 3 participants the key was created for)
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // Now simulate a new leaver
        members = [aStateBaseMembership("@bob:example.org", "BOBDEVICE")];
        getMembershipMock.mockReturnValue(members);

        // The rotation is still blocked
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // And another change (a leaver plus a joiner), still inside the block
        const lastMembership = [aStateBaseMembership("@bob:example.org", "BOBDEVICE3")];
        getMembershipMock.mockReturnValue(lastMembership);
        encryptionManager.onMembershipsUpdate();
        await vi.advanceTimersByTimeAsync(10);

        // Let the block expire and the rollout finish
        await vi.advanceTimersByTimeAsync(2000);

        // All three membership changes are coalesced into a single rotation at the end of the block,
        // based on the memberships at that point.
        expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(1);
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

        // Key `1` should only be distributed to the last membership
        expect(mockTransport.sendKey).toHaveBeenLastCalledWith(expect.any(String), 1, [
            {
                userId: "@bob:example.org",
                deviceId: "BOBDEVICE3",
                membershipTs: 1000,
            },
        ]);
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
