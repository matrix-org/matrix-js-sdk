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

import { BasicEncryptionManager } from "../../../src/matrixrtc/BasicEncryptionManager.ts";
import { type CallMembership, type Statistics } from "../../../src/matrixrtc";
import { type ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import { KeyTransportEvents, type KeyTransportEventsHandlerMap } from "../../../src/matrixrtc/IKeyTransport.ts";
import { membershipTemplate, mockCallMembership } from "./mocks.ts";
import { decodeBase64, TypedEventEmitter } from "../../../src";

describe("BasicEncryptionManager", () => {
    // The manager being tested
    let encryptionManager: BasicEncryptionManager;
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

        encryptionManager = new BasicEncryptionManager(
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
        it("Should distribute keys to members on join", async () => {
            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members,
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

        it("Should rotate key when a user join and delay the rollout", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            await jest.runOnlyPendingTimersAsync();

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members,
            );
            // initial rollout
            expect(mockTransport.sendKey).toHaveBeenCalled();
            expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(1);
            onEncryptionKeysChanged.mockClear();

            const updatedMembers = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
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
                updatedMembers,
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

        it("Should rotate key when a user leaves and delay the rollout", async () => {
            jest.useFakeTimers();

            const members = [
                aCallMembership("@bob:example.org", "BOBDEVICE"),
                aCallMembership("@bob:example.org", "BOBDEVICE2"),
                aCallMembership("@carl:example.org", "CARLDEVICE"),
            ];
            getMembershipMock.mockReturnValue(members);

            encryptionManager.join(undefined);
            await jest.advanceTimersByTimeAsync(10);

            expect(mockTransport.sendKey).toHaveBeenCalledTimes(1);
            expect(mockTransport.sendKey).toHaveBeenCalledWith(
                expect.any(String),
                // It is the first key
                0,
                members,
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
                updatedMembers,
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
            encryptionManager = new BasicEncryptionManager(
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
                "@bob:example.org",
                "CAROLDEVICE",
                "AAAAAAAAAAA",
                0 /* KeyId */,
                initialKey0TimeStamp,
            );

            await jest.advanceTimersByTimeAsync(20);

            // The latest key used for carol should be the one with the latest timestamp

            expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
                decodeBase64("BBBBBBBBBBB"),
                0,
                "@carol:example.org:CAROLDEVICE",
            );
        });
    });

    it("Should only rotate once again if several membership changes during a rollout", async () => {
        jest.useFakeTimers();

        const members = [
            aCallMembership("@bob:example.org", "BOBDEVICE"),
            aCallMembership("@bob:example.org", "BOBDEVICE2"),
            aCallMembership("@carl:example.org", "CARLDEVICE"),
        ];
        getMembershipMock.mockReturnValue(members);

        // Let's join
        encryptionManager.join(undefined);
        await jest.advanceTimersByTimeAsync(10);

        // The initial rollout
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            0,
            "@alice:example.org:DEVICE01",
        );

        // Simulate rapid fire membership changes
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(10);
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(10);
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(10);
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(10);
        encryptionManager.onMembershipsUpdate(members);

        await jest.advanceTimersByTimeAsync(1000);

        // The key should have been rolled out only once (two in total)
        expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(2);
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            1,
            "@alice:example.org:DEVICE01",
        );

        // A new one now should rotate
        encryptionManager.onMembershipsUpdate(members);
        await jest.advanceTimersByTimeAsync(1200);

        expect(onEncryptionKeysChanged).toHaveBeenCalledTimes(3);
        expect(onEncryptionKeysChanged).toHaveBeenCalledWith(
            expect.any(Uint8Array<ArrayBufferLike>),
            2,
            "@alice:example.org:DEVICE01",
        );
    });

    function aCallMembership(userId: string, deviceId: string): CallMembership {
        return mockCallMembership(
            Object.assign({}, membershipTemplate, { device_id: deviceId, created_ts: 1000 }),
            "!room:id",
            userId,
        );
    }
});
