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

import { makeKey, makeMockEvent, makeMockRoom } from "./mocks";
import { EventType, type IRoomTimelineData, type Room, RoomEvent, type MatrixClient } from "../../../src";
import { ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import {
    getMockClientWithEventEmitter,
    mockClientMethodsEvents,
    mockClientMethodsUser,
} from "../../test-utils/client.ts";
import { type ParticipantDeviceInfo, type Statistics } from "../../../src/matrixrtc";
import { KeyTransportEvents } from "../../../src/matrixrtc/IKeyTransport.ts";
import { type Logger } from "../../../src/logger.ts";
import { RoomAndToDeviceEvents, RoomAndToDeviceTransport } from "../../../src/matrixrtc/RoomAndToDeviceKeyTransport.ts";
import { RoomKeyTransport } from "../../../src/matrixrtc/RoomKeyTransport.ts";

describe("RoomAndToDeviceTransport", () => {
    const roomId = "!room:id";

    let mockClient: Mocked<MatrixClient>;
    let statistics: Statistics;
    let mockLogger: Mocked<Logger>;
    let transport: RoomAndToDeviceTransport;
    let mockRoom: Room;
    let sendEventMock: jest.Mock;
    let roomKeyTransport: RoomKeyTransport;
    let toDeviceKeyTransport: ToDeviceKeyTransport;
    let toDeviceSendKeySpy: jest.SpyInstance;
    let roomSendKeySpy: jest.SpyInstance;
    beforeEach(() => {
        sendEventMock = jest.fn();
        mockClient = getMockClientWithEventEmitter({
            encryptAndSendToDevice: jest.fn(),
            getDeviceId: jest.fn().mockReturnValue("MYDEVICE"),
            ...mockClientMethodsEvents(),
            ...mockClientMethodsUser("@alice:example.org"),
            sendEvent: sendEventMock,
        });
        mockRoom = makeMockRoom([]);
        mockLogger = {
            debug: jest.fn(),
            warn: jest.fn(),
            getChild: jest.fn(),
        } as unknown as Mocked<Logger>;
        mockLogger.getChild.mockReturnValue(mockLogger);
        statistics = {
            counters: {
                roomEventEncryptionKeysSent: 0,
                roomEventEncryptionKeysReceived: 0,
            },
            totals: {
                roomEventEncryptionKeysReceivedTotalAge: 0,
            },
        };
        roomKeyTransport = new RoomKeyTransport(mockRoom, mockClient, statistics);
        toDeviceKeyTransport = new ToDeviceKeyTransport(
            "@alice:example.org",
            "MYDEVICE",
            mockRoom.roomId,
            mockClient,
            statistics,
        );
        transport = new RoomAndToDeviceTransport(toDeviceKeyTransport, roomKeyTransport, mockLogger);
        toDeviceSendKeySpy = jest.spyOn(toDeviceKeyTransport, "sendKey");
        roomSendKeySpy = jest.spyOn(roomKeyTransport, "sendKey");
    });

    it("should enable to device transport when starting", () => {
        transport.start();
        expect(transport.enabled.room).toBeFalsy();
        expect(transport.enabled.toDevice).toBeTruthy();
    });
    it("only sends to device keys when sending a key", async () => {
        transport.start();
        await transport.sendKey("1235", 0, [
            { userId: "@alice:example.org", deviceId: "ALICEDEVICE", membershipTs: 1234 },
        ]);
        expect(toDeviceSendKeySpy).toHaveBeenCalledTimes(1);
        expect(roomSendKeySpy).toHaveBeenCalledTimes(0);
        expect(transport.enabled.room).toBeFalsy();
        expect(transport.enabled.toDevice).toBeTruthy();
    });

    it("enables room transport and disables to device transport when receiving a room key", async () => {
        transport.start();
        const onNewKeyFromTransport = jest.fn();
        const onTransportEnabled = jest.fn();
        transport.on(KeyTransportEvents.ReceivedKeys, onNewKeyFromTransport);
        transport.on(RoomAndToDeviceEvents.EnabledTransportsChanged, onTransportEnabled);
        mockRoom.emit(
            RoomEvent.Timeline,
            makeMockEvent(EventType.CallEncryptionKeysPrefix, "@bob:example.org", roomId, {
                call_id: "",
                keys: [makeKey(0, "testKey")],
                sent_ts: Date.now(),
                device_id: "AAAAAAA",
            }),
            undefined,
            undefined,
            false,
            {} as IRoomTimelineData,
        );
        await jest.advanceTimersByTimeAsync(1);
        expect(transport.enabled.room).toBeTruthy();
        expect(transport.enabled.toDevice).toBeFalsy();

        await transport.sendKey("1235", 0, [
            { userId: "@alice:example.org", deviceId: "AlICEDEV", membershipTs: 1234 },
        ]);
        expect(sendEventMock).toHaveBeenCalledTimes(1);
        expect(roomSendKeySpy).toHaveBeenCalledTimes(1);
        expect(toDeviceSendKeySpy).toHaveBeenCalledTimes(0);
        expect(onTransportEnabled).toHaveBeenCalledWith({ toDevice: false, room: true });
    });

    it("enables room transport and disables to device transport on widget driver error", async () => {
        mockClient.encryptAndSendToDevice.mockRejectedValue({
            message:
                "unknown variant `send_to_device`, expected one of `supported_api_versions`, `content_loaded`, `get_openid`, `org.matrix.msc2876.read_events`, `send_event`, `org.matrix.msc4157.update_delayed_event` at line 1 column 22",
        });

        transport.start();
        const membership: ParticipantDeviceInfo = {
            userId: "@alice:example.org",
            deviceId: "ALICEDEVICE",
            membershipTs: 1234,
        };
        const onTransportEnabled = jest.fn();
        transport.on(RoomAndToDeviceEvents.EnabledTransportsChanged, onTransportEnabled);

        // We start with toDevice transport enabled
        expect(transport.enabled.room).toBeFalsy();
        expect(transport.enabled.toDevice).toBeTruthy();

        await transport.sendKey("1235", 0, [membership]);

        // We switched transport, now room transport is enabled
        expect(onTransportEnabled).toHaveBeenCalledWith({ toDevice: false, room: true });
        expect(transport.enabled.room).toBeTruthy();
        expect(transport.enabled.toDevice).toBeFalsy();

        // sanity check that we called the failang to device send key.
        expect(toDeviceKeyTransport.sendKey).toHaveBeenCalledWith("1235", 0, [membership]);
        expect(toDeviceKeyTransport.sendKey).toHaveBeenCalledTimes(1);
        // We re-sent the key via the room transport
        expect(roomKeyTransport.sendKey).toHaveBeenCalledWith("1235", 0, [membership]);
        expect(roomKeyTransport.sendKey).toHaveBeenCalledTimes(1);

        mockClient.encryptAndSendToDevice.mockRestore();
    });

    it("does log that it did nothing when disabled", () => {
        transport.start();
        const onNewKeyFromTransport = jest.fn();
        const onTransportEnabled = jest.fn();
        transport.on(KeyTransportEvents.ReceivedKeys, onNewKeyFromTransport);
        transport.on(RoomAndToDeviceEvents.EnabledTransportsChanged, onTransportEnabled);

        transport.setEnabled({ toDevice: false, room: false });
        const dateNow = Date.now();
        roomKeyTransport.emit(KeyTransportEvents.ReceivedKeys, "user", "device", "roomKey", 0, dateNow);
        toDeviceKeyTransport.emit(KeyTransportEvents.ReceivedKeys, "user", "device", "toDeviceKey", 0, Date.now());

        expect(mockLogger.debug).toHaveBeenCalledWith("To Device transport is disabled, ignoring received keys");
        // for room key transport we will never get a disabled message because its will always just turn on
        expect(onTransportEnabled).toHaveBeenNthCalledWith(1, { toDevice: false, room: false });
        expect(onTransportEnabled).toHaveBeenNthCalledWith(2, { toDevice: false, room: true });
        expect(onNewKeyFromTransport).toHaveBeenCalledTimes(1);
        expect(onNewKeyFromTransport).toHaveBeenCalledWith("user", "device", "roomKey", 0, dateNow);
    });
});
