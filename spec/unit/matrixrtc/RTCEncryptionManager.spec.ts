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

import { type Mocked } from "jest-mock";

import { RTCEncryptionManager } from "../../../src/matrixrtc/RTCEncryptionManager.ts";
import { type CallMembership, type Statistics } from "../../../src/matrixrtc";
import { type ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import { KeyTransportEvents, type KeyTransportEventsHandlerMap } from "../../../src/matrixrtc/IKeyTransport.ts";
import { membershipTemplate, mockCallMembership } from "./mocks.ts";
import { decodeBase64, TypedEventEmitter } from "../../../src";
import { RoomAndToDeviceTransport } from "../../../src/matrixrtc/RoomAndToDeviceKeyTransport.ts";
import { type RoomKeyTransport } from "../../../src/matrixrtc/RoomKeyTransport.ts";
import type { Logger } from "../../../src/logger.ts";
import { getParticipantId } from "../../../src/matrixrtc/utils.ts";

describe("RTCEncryptionManager", () => {
    // The manager being tested
    let encryptionManager: RTCEncryptionManager;
    let getMembershipMock: jest.Mock;
    let mockTransport: Mocked<ToDeviceKeyTransport>;
    let statistics: Statistics;
    let onEncryptionKeysChanged: jest.Mock;

    beforeEach(() => {
        statistics = {
            counters: {
                roomEventEncryptionKeysSent: 0,
                roomEventEncryptionKeysReceived: 0,
            },
            totals: {
                roomEventEncryptionKeysReceivedTotalAge: 0,
            },
        };
        getMembershipMock = jest.fn().mockReturnValue([]);
        onEncryptionKeysChanged = jest.fn();
        mockTransport = {
            start: jest.fn(),
            stop: jest.fn(),
            sendKey: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            off: jest.fn(),
        } as unknown as Mocked<ToDeviceKeyTransport>;

        encryptionManager = new RTCEncryptionManager(
            "@alice:example.org",
            "DEVICE01",
            getMembershipMock,
            mockTransport,
            statistics,
            onEncryptionKeysChanged,
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
        it("Set up my key asap even if no key distribution is needed", () => {
            getMembershipMock.mockReturnValue([]);

            encryptionManager.join(undefined);
            // After join it is too early, key might be lost as no one is listening yet
            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            encryptionManager.onMembershipsUpdate([]);
            // The key should have been rolled out immediately
            expect(onEncryptionKeysChanged).toHaveBeenCalled();
        });

        it("Should distribute keys to members on join", async () => {
            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate([]);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );
            await jest.runOnlyPendingTimersAsync();
            // The key should have been rolled out immediately
            expect(onEncryptionKeysChanged).toHaveBeenCalled();
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                0,
                "@alice:example.org:DEVICE01",
            );
        });

        it("Should re-distribute keys to members whom callMemberhsip ts has changed", async () => {
            let members = [aCallMembership("@bob:example.org", "BOBDEVICE", 1000)];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate([]);

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
            await jest.runOnlyPendingTimersAsync();
            // The key should have been rolled out immediately
            expect(onEncryptionKeysChanged).toHaveBeenCalled();

            mockTransport.sendKey.mockClear();
            onEncryptionKeysChanged.mockClear();

            members = [aCallMembership("@bob:example.org", "BOBDEVICE", 2000)];
            getMembershipMock.mockReturnValue(members);

            // There are no membership change but the callMembership ts has changed (reset?)
            // Resend the key
            encryptionManager.onMembershipsUpdate(members);
            await jest.runOnlyPendingTimersAsync();

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

        it("Should not rotate key when a user join", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // initial rollout
            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate([]);
            await jest.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );
            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            const updatedMembers = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(updatedMembers);

            encryptionManager.onMembershipsUpdate(updatedMembers);

            await jest.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It should not have incremented the key index
                0,
                // And send it to the newly joined only
                [{ userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1000 }],
            );

            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(1000);

            expect(statistics.counters.roomEventEncryptionKeysSent).toBe(2);
        });

        it("Should not resend keys when no changes", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            // initial rollout
            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate([]);
            await jest.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            onEncryptionKeysChanged.mockClear();
            mockTransport.sendKey.mockClear();

            encryptionManager.onMembershipsUpdate(members);
            await jest.advanceTimersByTimeAsync(200);
            encryptionManager.onMembershipsUpdate(members);
            await jest.advanceTimersByTimeAsync(100);
            encryptionManager.onMembershipsUpdate(members);
            await jest.advanceTimersByTimeAsync(50);
            encryptionManager.onMembershipsUpdate(members);
            await jest.advanceTimersByTimeAsync(100);

            expect(mockTransport.sendKey).not.toHaveBeenCalled();
        });

        it("Should rotate key when a user leaves and delay the rollout", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate([]);
            await jest.advanceTimersByTimeAsync(10);

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
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(updatedMembers);

            encryptionManager.onMembershipsUpdate(updatedMembers);

            await jest.advanceTimersByTimeAsync(200);
            // The is rotated but not rolled out yet to give time for the key to be sent
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It should have incremented the key index
                1,
                // And send it to the updated members
                updatedMembers.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
            );

            expect(onEncryptionKeysChanged).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(1000);

            // now should be rolled out
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                expect.any(Uint8Array<ArrayBufferLike>),
                1,
                "@alice:example.org:DEVICE01",
            );

            expect(statistics.counters.roomEventEncryptionKeysSent).toBe(2);
        });
    });

    describe("Receiving Keys", () => {
        beforeEach(() => {
            const emitter = new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>();
            mockTransport = {
                start: jest.fn(),
                stop: jest.fn(),
                sendKey: jest.fn().mockResolvedValue(undefined),
                on: emitter.on.bind(emitter),
                off: emitter.off.bind(emitter),
                emit: emitter.emit.bind(emitter),
            } as unknown as Mocked<ToDeviceKeyTransport>;
            encryptionManager = new RTCEncryptionManager(
                "@alice:example.org",
                "DEVICE01",
                getMembershipMock,
                mockTransport,
                statistics,
                onEncryptionKeysChanged,
            );
        });

        it("should accept keys from transport", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate([]);
            await jest.advanceTimersByTimeAsync(10);

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@bob:example.org",
                "BOBDEVICE",
                "AAAAAAAAAAA",
                0 /* KeyId */,
                0 /* Timestamp */,
            );
            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@bob:example.org",
                "BOBDEVICE2",
                "BBBBBBBBBBB",
                4 /* KeyId */,
                0 /* Timestamp */,
            );
            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@carl:example.org",
                "CARLDEVICE",
                "CCCCCCCCCC",
                8 /* KeyId */,
                0 /* Timestamp */,
            );

            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(4);
            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("AAAAAAAAAAA"),
                0,
                "@bob:example.org:BOBDEVICE",
            );

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("BBBBBBBBBBB"),
                4,
                "@bob:example.org:BOBDEVICE2",
            );

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("CCCCCCCCCC"),
                8,
                "@carl:example.org:CARLDEVICE",
            );

            expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(3);
        });

        it("Should support quick re-joiner if keys received out of order", async () => {
            jest.useFakeTimers();

            const members = [aCallMembership("@carl:example.org", "CARLDEVICE")];
            getMembershipMock.mockReturnValue(members);

            // Let's join
            encryptionManager.join(undefined);
            await jest.advanceTimersByTimeAsync(10);

            // Simulate Carl leaving then joining back, and key received out of order
            const initialKey0TimeStamp = 1000;
            const newKey0TimeStamp = 2000;

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@carol:example.org",
                "CAROLDEVICE",
                "BBBBBBBBBBB",
                0 /* KeyId */,
                newKey0TimeStamp,
            );

            await jest.advanceTimersByTimeAsync(20);

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@carol:example.org",
                "CAROLDEVICE",
                "AAAAAAAAAAA",
                0 /* KeyId */,
                initialKey0TimeStamp,
            );

            await jest.advanceTimersByTimeAsync(20);

            // The latest key used for carol should be the one with the latest timestamp

            expect(onEncryptionKeysChanged).toHaveBeenLastCalledWith(
                decodeBase64("BBBBBBBBBBB"),
                0,
                "@carol:example.org:CAROLDEVICE",
            );
        });

        it("Should store keys for later retrieval", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            // Let's join
            encryptionManager.join(undefined);
            encryptionManager.onMembershipsUpdate(members);

            await jest.advanceTimersByTimeAsync(10);

            // Simulate Carl leaving then joining back, and key received out of order

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@carl:example.org",
                "CARLDEVICE",
                "BBBBBBBBBBB",
                0 /* KeyId */,
                1000,
            );

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@carl:example.org",
                "CARLDEVICE",
                "CCCCCCCCCCC",
                5 /* KeyId */,
                1000,
            );

            mockTransport.emit(
                KeyTransportEvents.ReceivedKeys,
                "@bob:example.org",
                "BOBDEVICE2",
                "DDDDDDDDDDD",
                0 /* KeyId */,
                1000,
            );

            const knownKeys = encryptionManager.getEncryptionKeys();

            // My own key should be there
            const myRing = knownKeys.get(getParticipantId("@alice:example.org", "DEVICE01"));
            expect(myRing).toBeDefined();
            expect(myRing).toHaveLength(1);
            expect(myRing![0]).toMatchObject(
                expect.objectContaining({
                    keyIndex: 0,
                    key: expect.any(Uint8Array),
                }),
            );

            const carlRing = knownKeys.get(getParticipantId("@carl:example.org", "CARLDEVICE"));
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

            const bobRing = knownKeys.get(getParticipantId("@bob:example.org", "BOBDEVICE2"));
            expect(bobRing).toBeDefined();
            expect(bobRing).toHaveLength(1);
            expect(bobRing![0]).toMatchObject(
                expect.objectContaining({
                    keyIndex: 0,
                    key: decodeBase64("DDDDDDDDDDD"),
                }),
            );

            const bob1Ring = knownKeys.get(getParticipantId("@bob:example.org", "BOBDEVICE"));
            expect(bob1Ring).not.toBeDefined();
        });
    });

    it("Should only rotate once again if several membership changes during a rollout", async () => {
        jest.useFakeTimers();

        let members = [
            aCallMembership("@bob:example.org", "BOBDEVICE"),
            aCallMembership("@bob:example.org", "BOBDEVICE2"),
            aCallMembership("@carl:example.org", "CARLDEVICE"),
        ];
        getMembershipMock.mockReturnValue(members);

        // Let's join
        encryptionManager.join(undefined);
        encryptionManager.onMembershipsUpdate([]);
        await jest.advanceTimersByTimeAsync(10);

        // The initial rollout
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            0,
            "@alice:example.org:DEVICE01",
        );
        onEncryptionKeysChanged.mockClear();

        // Trigger a key rotation with a leaver
        members = [aCallMembership("@bob:example.org", "BOBDEVICE"), aCallMembership("@bob:example.org", "BOBDEVICE2")];
        getMembershipMock.mockReturnValue(members);

        // This should start a new key rollout
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(10);

        // Now simulate a new leaver
        members = [aCallMembership("@bob:example.org", "BOBDEVICE")];
        getMembershipMock.mockReturnValue(members);

        // The key `1` rollout is in progress
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(10);

        // And another one ( plus a joiner)
        const lastMembership = [aCallMembership("@bob:example.org", "BOBDEVICE3")];
        getMembershipMock.mockReturnValue(lastMembership);
        // The key `1` rollout is still in progress
        encryptionManager.onMembershipsUpdate(lastMembership);
        await jest.advanceTimersByTimeAsync(10);

        // Let all rollouts finish
        await jest.advanceTimersByTimeAsync(2000);

        // There should 2 rollout. The `1` rollout, then just one additional one
        // that has "buffered" the 2 membership changes with leavers
        expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(2);
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            1,
            "@alice:example.org:DEVICE01",
        );
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            2,
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

    it("Should re-distribute key on transport switch", async () => {
        const toDeviceEmitter = new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>();
        const mockToDeviceTransport = {
            start: jest.fn(),
            stop: jest.fn(),
            sendKey: jest.fn().mockResolvedValue(undefined),
            on: toDeviceEmitter.on.bind(toDeviceEmitter),
            off: toDeviceEmitter.off.bind(toDeviceEmitter),
            emit: toDeviceEmitter.emit.bind(toDeviceEmitter),
            setParentLogger: jest.fn(),
        } as unknown as Mocked<ToDeviceKeyTransport>;

        const roomEmitter = new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>();
        const mockRoomTransport = {
            start: jest.fn(),
            stop: jest.fn(),
            sendKey: jest.fn().mockResolvedValue(undefined),
            on: roomEmitter.on.bind(roomEmitter),
            off: roomEmitter.off.bind(roomEmitter),
            emit: roomEmitter.emit.bind(roomEmitter),
            setParentLogger: jest.fn(),
        } as unknown as Mocked<RoomKeyTransport>;

        const mockLogger = {
            debug: jest.fn(),
            warn: jest.fn(),
        } as unknown as Mocked<Logger>;

        const transport = new RoomAndToDeviceTransport(mockToDeviceTransport, mockRoomTransport, {
            getChild: jest.fn().mockReturnValue(mockLogger),
        } as unknown as Mocked<Logger>);

        encryptionManager = new RTCEncryptionManager(
            "@alice:example.org",
            "DEVICE01",
            getMembershipMock,
            transport,
            statistics,
            onEncryptionKeysChanged,
        );

        const members = [
            aCallMembership("@bob:example.org", "BOBDEVICE"),
            aCallMembership("@bob:example.org", "BOBDEVICE2"),
            aCallMembership("@carl:example.org", "CARLDEVICE"),
        ];
        getMembershipMock.mockReturnValue(members);

        // Let's join
        encryptionManager.join(undefined);
        encryptionManager.onMembershipsUpdate([]);
        await jest.advanceTimersByTimeAsync(10);

        // Should have sent the key to the toDevice transport
        expect(mockToDeviceTransport.sendKey).toHaveBeenCalledTimes(1);
        expect(mockRoomTransport.sendKey).not.toHaveBeenCalled();

        // Simulate receiving a key by room transport
        roomEmitter.emit(
            KeyTransportEvents.ReceivedKeys,
            "@bob:example.org",
            "BOBDEVICE",
            "AAAAAAAAAAA",
            0 /* KeyId */,
            0 /* Timestamp */,
        );

        await jest.runOnlyPendingTimersAsync();

        // The key should have beed re-distributed to the room transport
        expect(mockRoomTransport.sendKey).toHaveBeenCalled();
        expect(mockToDeviceTransport.sendKey).toHaveBeenCalledWith(
            expect.any(String),
            // It is the first key re-distributed
            0,
            // to all the members
            members.map((m) => ({ userId: m.sender, deviceId: m.deviceId, membershipTs: m.createdTs() })),
        );
    });

    function aCallMembership(userId: string, deviceId: string, ts: number = 1000): CallMembership {
        return mockCallMembership(
            Object.assign({}, membershipTemplate, { device_id: deviceId, created_ts: ts }),
            "!room:id",
            userId,
        );
    }
});
