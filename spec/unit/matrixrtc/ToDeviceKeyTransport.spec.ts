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

import { makeMockEvent, membershipTemplate, mockCallMembership } from "./mocks";
import { ClientEvent, EventType, type MatrixClient } from "../../../src";
import { ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import { getMockClientWithEventEmitter } from "../../test-utils/client.ts";
import { type Statistics } from "../../../src/matrixrtc";
import { KeyTransportEvents } from "../../../src/matrixrtc/IKeyTransport.ts";
import { defer } from "../../../src/utils.ts";
import { type Logger } from "../../../src/logger.ts";

describe("ToDeviceKeyTransport", () => {
    const roomId = "!room:id";

    let mockClient: Mocked<MatrixClient>;
    let statistics: Statistics;
    let mockLogger: Mocked<Logger>;
    let transport: ToDeviceKeyTransport;

    beforeEach(() => {
        mockClient = getMockClientWithEventEmitter({
            encryptAndSendToDevice: jest.fn(),
        });
        mockLogger = {
            debug: jest.fn(),
            warn: jest.fn(),
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

        transport = new ToDeviceKeyTransport("@alice:example.org", "MYDEVICE", roomId, mockClient, statistics, {
            getChild: jest.fn().mockReturnValue(mockLogger),
        } as unknown as Mocked<Logger>);
    });

    it("should send my keys on via to device", async () => {
        transport.start();

        const keyBase64Encoded = "ABCDEDF";
        const keyIndex = 2;
        await transport.sendKey(keyBase64Encoded, keyIndex, [
            mockCallMembership(
                Object.assign({}, membershipTemplate, { device_id: "BOBDEVICE" }),
                roomId,
                "@bob:example.org",
            ),
            mockCallMembership(
                Object.assign({}, membershipTemplate, { device_id: "CARLDEVICE" }),
                roomId,
                "@carl:example.org",
            ),
            mockCallMembership(
                Object.assign({}, membershipTemplate, { device_id: "MATDEVICE" }),
                roomId,
                "@mat:example.org",
            ),
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
                keys: {
                    index: keyIndex,
                    key: keyBase64Encoded,
                },
                member: {
                    claimed_device_id: "MYDEVICE",
                },
                room_id: roomId,
                session: {
                    application: "m.call",
                    call_id: "",
                    scope: "m.room",
                },
            },
        );

        expect(statistics.counters.roomEventEncryptionKeysSent).toBe(1);
    });

    it("should emit when a key is received", async () => {
        const deferred = defer<{ userId: string; deviceId: string; keyBase64Encoded: string; index: number }>();
        transport.on(KeyTransportEvents.ReceivedKeys, (userId, deviceId, keyBase64Encoded, index, timestamp) => {
            deferred.resolve({ userId, deviceId, keyBase64Encoded, index });
        });
        transport.start();

        const testEncoded = "ABCDEDF";
        const testKeyIndex = 2;

        mockClient.emit(
            ClientEvent.ToDeviceEvent,
            makeMockEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, {
                keys: {
                    index: testKeyIndex,
                    key: testEncoded,
                },
                member: {
                    claimed_device_id: "BOBDEVICE",
                },
                room_id: roomId,
                session: {
                    application: "m.call",
                    call_id: "",
                    scope: "m.room",
                },
            }),
        );

        const { userId, deviceId, keyBase64Encoded, index } = await deferred.promise;
        expect(userId).toBe("@bob:example.org");
        expect(deviceId).toBe("BOBDEVICE");
        expect(keyBase64Encoded).toBe(testEncoded);
        expect(index).toBe(testKeyIndex);

        expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(1);
    });

    it("should not sent to ourself", async () => {
        const keyBase64Encoded = "ABCDEDF";
        const keyIndex = 2;
        await transport.sendKey(keyBase64Encoded, keyIndex, [
            mockCallMembership(
                Object.assign({}, membershipTemplate, { device_id: "MYDEVICE" }),
                roomId,
                "@alice:example.org",
            ),
        ]);

        transport.start();

        expect(mockClient.encryptAndSendToDevice).toHaveBeenCalledTimes(0);
    });

    it("should warn when there is a room mismatch", () => {
        transport.start();

        const testEncoded = "ABCDEDF";
        const testKeyIndex = 2;

        mockClient.emit(
            ClientEvent.ToDeviceEvent,
            makeMockEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, {
                keys: {
                    index: testKeyIndex,
                    key: testEncoded,
                },
                member: {
                    claimed_device_id: "BOBDEVICE",
                },
                room_id: "!anotherroom:id",
                session: {
                    application: "m.call",
                    call_id: "",
                    scope: "m.room",
                },
            }),
        );

        expect(mockLogger.warn).toHaveBeenCalledWith("Malformed Event: Mismatch roomId");
        expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(0);
    });

    describe("malformed events", () => {
        const MALFORMED_EVENT = [
            {
                keys: {},
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
            {
                keys: { index: 0 },
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
            {
                keys: { key: "ABCDEF" },
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!room:id",
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                room_id: "!room:id",
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                member: {},
                room_id: "!room:id",
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                member: { claimed_device_id: "MYDEVICE" },
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
            {
                keys: { key: "ABCDEF", index: 2 },
                member: { claimed_device_id: "MYDEVICE" },
                room_id: "!wrong_room",
                session: { application: "m.call", call_id: "", scope: "m.room" },
            },
        ];

        test.each(MALFORMED_EVENT)("should warn on malformed event %j", (event) => {
            transport.start();

            mockClient.emit(
                ClientEvent.ToDeviceEvent,
                makeMockEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", undefined, event),
            );

            expect(mockLogger.warn).toHaveBeenCalled();
            expect(statistics.counters.roomEventEncryptionKeysReceived).toBe(0);
        });
    });
});
