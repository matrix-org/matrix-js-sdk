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

import { type Mocked } from "vitest";

import { makeMatrixEvent } from "./mocks.ts";
import { ClientEvent, EventType, type MatrixClient } from "../../../src";
import { ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import { getMockClientWithEventEmitter } from "../../test-utils/client.ts";
import { type Statistics } from "../../../src/matrixrtc";
import { KeyTransportEvents } from "../../../src/matrixrtc/IKeyTransport.ts";
import { type Logger } from "../../../src/logger.ts";

describe("ToDeviceKeyTransport", () => {
    const roomId = "!room:id";

    let mockClient: Mocked<MatrixClient>;
    let statistics: Statistics;
    let mockLogger: Mocked<Logger>;
    let transport: ToDeviceKeyTransport;

    beforeEach(() => {
        mockClient = getMockClientWithEventEmitter({
            encryptAndSendToDevice: vi.fn().mockImplementation(() => Promise.resolve()),
        });
        mockLogger = {
            debug: vi.fn(),
            warn: vi.fn(),
        } as unknown as Mocked<Logger>;
        statistics = {
            counters: {
                roomEventEncryptionKeysSent: 0,
                roomEventEncryptionKeysReceived: 0,
            },
            totals: {
                roomEventEncryptionKeysReceivedTotalAge: 0,
            },
        };

        transport = new ToDeviceKeyTransport(
            { userId: "@alice:example.org", deviceId: "MYDEVICE", memberId: "@alice:example.org:MYDEVICE" },
            roomId,
            mockClient,
            statistics,
            {
                getChild: vi.fn().mockReturnValue(mockLogger),
            } as unknown as Mocked<Logger>,
        );
    });

    it("should send my keys on via to device", async () => {
        transport.start();

        const keyBase64Encoded = "ABCDEDF";
        const keyIndex = 2;
        await transport.sendKey(keyBase64Encoded, keyIndex, [
            { userId: "@bob:example.org", deviceId: "BOBDEVICE", membershipTs: 1234 },
            { userId: "@carl:example.org", deviceId: "CARLDEVICE", membershipTs: 1234 },
            { userId: "@mat:example.org", deviceId: "MATDEVICE", membershipTs: 1234 },
        ]);

        expect(mockClient.encryptAndSendToDevice).toHaveBeenCalledTimes(1);
        expect(mockClient.encryptAndSendToDevice).toHaveBeenCalledWith(
            "io.element.call.encryption_keys",
            [
                { userId: "@bob:example.org", deviceId: "BOBDEVICE" },
                { userId: "@carl:example.org", deviceId: "CARLDEVICE" },
                { userId: "@mat:example.org", deviceId: "MATDEVICE" },
            ],
            {
                room_id: roomId,
                member_id: "@alice:example.org:MYDEVICE",
                media_key: {
                    index: keyIndex,
                    key: keyBase64Encoded,
                },
                keys: {
                    index: keyIndex,
                    key: keyBase64Encoded,
                },
                member: {
                    claimed_device_id: "MYDEVICE",
                    id: "@alice:example.org:MYDEVICE",
                },
            },
        );

        expect(statistics.counters.roomEventEncryptionKeysSent).toBe(1);
    });

    /**
     * Starts the transport, emits an encrypted key event with the given content from bob and returns
     * what the transport emitted for it.
     */
    async function receiveKeyEvent(content: Record<string, unknown>): Promise<{
        userId: string;
        deviceId: string;
        memberId: string;
        keyBase64Encoded: string;
        index: number;
    }> {
        const receivedKeyResolvers = Promise.withResolvers<{
            userId: string;
            deviceId: string;
            memberId: string;
            keyBase64Encoded: string;
            index: number;
        }>();
        transport.on(KeyTransportEvents.ReceivedKeys, (membership, keyBase64Encoded, index, _timestamp) => {
            receivedKeyResolvers.resolve({
                userId: membership.userId,
                deviceId: membership.deviceId,
                memberId: membership.memberId,
                keyBase64Encoded,
                index,
            });
        });
        transport.start();

        const mockEvent = makeMatrixEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, content);
        mockEvent.makeEncrypted(EventType.RoomMessageEncrypted, {}, "", "");
        mockClient.emit(ClientEvent.ToDeviceEvent, mockEvent);

        return receivedKeyResolvers.promise;
    }

    it("should emit when a key is received in the MSC4143 format", async () => {
        const testEncoded = "ABCDEDF";
        const testKeyIndex = 2;

        const { userId, deviceId, memberId, keyBase64Encoded, index } = await receiveKeyEvent({
            room_id: roomId,
            member_id: "BOBMEMBERID",
            media_key: {
                index: testKeyIndex,
                key: testEncoded,
            },
            member: {
                claimed_device_id: "BOBDEVICE",
            },
        });
        expect(userId).toBe("@bob:example.org");
        expect(deviceId).toBe("BOBDEVICE");
        expect(memberId).toBe("BOBMEMBERID");
        expect(keyBase64Encoded).toBe(testEncoded);
        expect(index).toBe(testKeyIndex);

        expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(1);
    });

    it("should emit when a key is received in the deprecated format", async () => {
        const testEncoded = "ABCDEDF";
        const testKeyIndex = 2;

        const { userId, deviceId, memberId, keyBase64Encoded, index } = await receiveKeyEvent({
            keys: {
                index: testKeyIndex,
                key: testEncoded,
            },
            member: {
                claimed_device_id: "BOBDEVICE",
                id: "BOBMEMBERID",
            },
            room_id: roomId,
        });
        expect(userId).toBe("@bob:example.org");
        expect(deviceId).toBe("BOBDEVICE");
        expect(memberId).toBe("BOBMEMBERID");
        expect(keyBase64Encoded).toBe(testEncoded);
        expect(index).toBe(testKeyIndex);

        expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(1);
    });

    it("should fall back to a member id derived from the sender and device when none is given", async () => {
        const { memberId } = await receiveKeyEvent({
            keys: {
                index: 2,
                key: "ABCDEDF",
            },
            member: {
                claimed_device_id: "BOBDEVICE",
            },
            room_id: roomId,
        });
        expect(memberId).toBe("@bob:example.org:BOBDEVICE");
    });

    it("should prefer the MSC4143 properties over the deprecated ones", async () => {
        const { memberId, keyBase64Encoded, index } = await receiveKeyEvent({
            room_id: roomId,
            member_id: "NEWMEMBERID",
            media_key: {
                index: 3,
                key: "NEWKEY",
            },
            keys: {
                index: 2,
                key: "OLDKEY",
            },
            member: {
                claimed_device_id: "BOBDEVICE",
                id: "OLDMEMBERID",
            },
        });
        expect(memberId).toBe("NEWMEMBERID");
        expect(keyBase64Encoded).toBe("NEWKEY");
        expect(index).toBe(3);
    });

    it("should fall back to the deprecated key property when media_key is malformed", async () => {
        const { keyBase64Encoded, index } = await receiveKeyEvent({
            room_id: roomId,
            member_id: "BOBMEMBERID",
            media_key: {
                key: "NEWKEY",
            },
            keys: {
                index: 2,
                key: "OLDKEY",
            },
            member: {
                claimed_device_id: "BOBDEVICE",
            },
        });
        expect(keyBase64Encoded).toBe("OLDKEY");
        expect(index).toBe(2);
    });

    it("should drop non-encrypted/clear to-device events", () => {
        const receivedKeyResolvers = vi.fn();
        transport.on(KeyTransportEvents.ReceivedKeys, (membership, keyBase64Encoded, index, _timestamp) => {
            receivedKeyResolvers();
        });
        transport.start();

        const testEncoded = "ABCDEDF";
        const testKeyIndex = 2;

        const clearEvent = makeMatrixEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, {
            keys: {
                index: testKeyIndex,
                key: testEncoded,
            },
            member: {
                claimed_device_id: "BOBDEVICE",
            },
            room_id: roomId,
        });
        mockClient.emit(ClientEvent.ToDeviceEvent, clearEvent);

        expect(receivedKeyResolvers).toHaveBeenCalledTimes(0);

        clearEvent.makeEncrypted(EventType.RoomMessageEncrypted, {}, "", "");
        mockClient.emit(ClientEvent.ToDeviceEvent, clearEvent);

        expect(receivedKeyResolvers).toHaveBeenCalledTimes(1);
    });

    it("should not sent to ourself", async () => {
        const keyBase64Encoded = "ABCDEDF";
        const keyIndex = 2;
        await transport.sendKey(keyBase64Encoded, keyIndex, [
            { userId: "@alice:example.org", deviceId: "MYDEVICE", membershipTs: 1234 },
        ]);

        transport.start();

        expect(mockClient.encryptAndSendToDevice).toHaveBeenCalledTimes(0);
    });

    it("should warn when there is a room mismatch", () => {
        transport.start();

        const testEncoded = "ABCDEDF";
        const testKeyIndex = 2;

        const keyEvent = makeMatrixEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, {
            keys: {
                index: testKeyIndex,
                key: testEncoded,
            },
            member: {
                claimed_device_id: "BOBDEVICE",
            },
            room_id: "!anotherroom:id",
        });

        keyEvent.makeEncrypted(EventType.RoomMessageEncrypted, {}, "", "");
        mockClient.emit(ClientEvent.ToDeviceEvent, keyEvent);

        expect(mockLogger.warn).toHaveBeenCalledWith("Malformed Event: Mismatch roomId");
        expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(0);
    });

    describe("malformed events", () => {
        const MALFORMED_EVENT = [
            {
                keys: {},
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                keys: { index: 0 },
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                keys: { key: "ABCDEF" },
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                room_id: "!room:id",
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                member: {},
                room_id: "!room:id",
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                member: { claimed_device_id: "MYDEVICE" },
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!wrong_room",
            },
            {
                media_key: {},
                member_id: "MEMBERID",
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                media_key: { index: 0 },
                member_id: "MEMBERID",
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                media_key: { key: "ABCDEF" },
                member_id: "MEMBERID",
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                media_key: { key: "ABCDEF", index: 2 },
                member_id: 42,
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
            },
            {
                media_key: { key: "ABCDEF", index: 2 },
                member_id: "MEMBERID",
                room_id: "!room:id",
            },
            {
                media_key: { key: "ABCDEF", index: 2 },
                member_id: "MEMBERID",
                member: {},
                room_id: "!room:id",
            },
        ];

        test.each(MALFORMED_EVENT)("should warn on malformed event %j", (event) => {
            transport.start();

            mockClient.emit(
                ClientEvent.ToDeviceEvent,
                makeMatrixEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, event),
            );

            expect(mockLogger.warn).toHaveBeenCalled();
            expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(0);
        });
    });
});
