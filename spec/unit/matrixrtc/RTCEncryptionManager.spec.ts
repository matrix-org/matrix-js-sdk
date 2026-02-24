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
            // Resend the key
            encryptionManager.onMembershipsUpdate();
            await vi.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
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
        });

        it("Should not rotate key when a user join within the rotation grace period", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            const gracePeriod = 15_000; // 15 seconds
            // initial rollout
            encryptionManager.join({ keyRotationGracePeriodMs: gracePeriod });
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

            await vi.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It should not have incremented the key index
                0,
                // And send it to the newly joined only
                [{ userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1000 }],
            );

            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
        });

        // Test an edge case where the use key delay is higher than the grace period.
        // This means that no matter what, the key once rolled out will be too old to be re-used for the new member that
        // joined within the grace period.
        // So we expect another rotation to happen in all cases where a new member joins.
        // eslint-disable-next-line @vitest/expect-expect
        it("test grace period lower than delay period", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            const gracePeriod = 3_000; // 3 seconds
            const useKeyDelay = gracePeriod + 2_000; // 5 seconds
            // initial rollout
            encryptionManager.join({
                useKeyDelay,
                keyRotationGracePeriodMs: gracePeriod,
            });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            // The existing members have been talking for 5mn
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

            // A new member joins, that should trigger a key rotation.
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            // A new member joins, within the grace period, but under the delay period
            members.push(aStateBaseMembership("@david:example.org", "DAVDEVICE"));
            await vi.advanceTimersByTimeAsync((useKeyDelay - gracePeriod) / 2);
            encryptionManager.onMembershipsUpdate();

            // Wait past the delay period
            await vi.advanceTimersByTimeAsync(5_000);

            // Even though the new member joined within the grace period, the key should be rotated because once the delay period has passed
            // also the grace period is exceeded/the key is too old to be reshared.

            // CARLDEVICE should have received a key with index 1 and another one with index 2
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 1, "@carl:example.org", "CARLDEVICE");
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 2, "@carl:example.org", "CARLDEVICE");
            // Of course, should not have received the first key
            expectKeyAtIndexNotToHaveBeenSentTo(mockTransport, 0, "@carl:example.org", "CARLDEVICE");

            // DAVDEVICE should only have received a key with index 2
            expectKeyAtIndexToHaveBeenSentTo(mockTransport, 2, "@david:example.org", "DAVDEVICE");
            expectKeyAtIndexNotToHaveBeenSentTo(mockTransport, 1, "@david:example.org", "DAVDEVICE");
        });

        it("Should rotate key when a user join past the rotation grace period", async () => {
            vi.useFakeTimers();

            const members = [
                aStateBaseMembership("@bob:example.org", "BOBDEVICE"),
                aStateBaseMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            const gracePeriod = 15_000; // 15 seconds
            // initial rollout
            encryptionManager.join({ keyRotationGracePeriodMs: gracePeriod });
            encryptionManager.onMembershipsUpdate();
            await vi.advanceTimersByTimeAsync(1);

            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            await vi.advanceTimersByTimeAsync(gracePeriod + 1000);
            members.push(aStateBaseMembership("@carl:example.org", "CARLDEVICE"));
            encryptionManager.onMembershipsUpdate();

            expect(mockTransport.sendKey).toHaveBeenCalledWith(
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
            await vi.advanceTimersByTimeAsync(5000);

            expect(onEncryptionKeysChanged).toHaveBeenCalled();
        });

        it("Should not rotate key when several users join within the rotation grace period", async () => {
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
