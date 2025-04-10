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

import { makeKey, makeMockEvent, makeMockRoom, membershipTemplate, mockCallMembership } from "./mocks";
import { EventType, type IRoomTimelineData, type Room, RoomEvent, type MatrixClient } from "../../../src";
import type { ToDeviceKeyTransport } from "../../../src/matrixrtc/ToDeviceKeyTransport.ts";
import {
    getMockClientWithEventEmitter,
    mockClientMethodsEvents,
    mockClientMethodsUser,
} from "../../test-utils/client.ts";
import { type Statistics } from "../../../src/matrixrtc";
import { KeyTransportEvents } from "../../../src/matrixrtc/IKeyTransport.ts";
import { type Logger } from "../../../src/logger.ts";
import { RoomAndToDeviceEvents, RoomAndToDeviceTransport } from "../../../src/matrixrtc/RoomAndToDeviceKeyTransport.ts";
import type { RoomKeyTransport } from "../../../src/matrixrtc/RoomKeyTransport.ts";

describe("RoomAndToDeviceTransport", () => {
    const roomId = "!room:id";

    let mockClient: Mocked<MatrixClient>;
    let statistics: Statistics;
    let mockLogger: Mocked<Logger>;
    let transport: RoomAndToDeviceTransport;
    let mockRoom: Room;
    let sendEventMock: jest.Mock;
    function getToDeviceTransport(transport: RoomAndToDeviceTransport): ToDeviceKeyTransport {
        return (transport as unknown as any).toDeviceTransport as ToDeviceKeyTransport;
    }
    function getRoomTransport(transport: RoomAndToDeviceTransport) {
        return (transport as unknown as any).roomKeyTransport as RoomKeyTransport;
    }
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
        transport = new RoomAndToDeviceTransport("@alice:example.org", "MYDEVICE", mockRoom, mockClient, statistics, {
            getChild: jest.fn().mockReturnValue(mockLogger),
        } as unknown as Mocked<Logger>);
    });

    it("should enable to device transport when starting", () => {
        transport.start();
        expect(transport.enabled.room).toBeFalsy();
        expect(transport.enabled.toDevice).toBeTruthy();
    });
    it("only sends to device keys when sending a key", async () => {
        transport.start();
        const toDeviceSpy = jest.spyOn(getToDeviceTransport(transport), "sendKey");
        const roomSpy = jest.spyOn(getRoomTransport(transport), "sendKey");
        await transport.sendKey("1235", 0, [mockCallMembership(membershipTemplate, roomId, "@alice:example.org")]);
        expect(toDeviceSpy).toHaveBeenCalledTimes(1);
        expect(roomSpy).toHaveBeenCalledTimes(0);
        expect(transport.enabled.room).toBeFalsy();
        expect(transport.enabled.toDevice).toBeTruthy();
    });

    it("enables room transport and disables to device transport when receiving a room key", async () => {
        transport.start();
        const roomSpy = jest.spyOn(getRoomTransport(transport), "sendKey");
        const toDeviceSpy = jest.spyOn(getToDeviceTransport(transport), "sendKey");
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

        await transport.sendKey("1235", 0, [mockCallMembership(membershipTemplate, roomId, "@alice:example.org")]);
        expect(sendEventMock).toHaveBeenCalledTimes(1);
        expect(roomSpy).toHaveBeenCalledTimes(1);
        expect(toDeviceSpy).toHaveBeenCalledTimes(0);
        expect(onTransportEnabled).toHaveBeenCalledWith({ toDevice: false, room: true });
    });
    it("does log that it did nothing when disabled", () => {
        transport.start();
        const debug = jest.fn();
        (transport as unknown as any).logger = { debug };
        const onNewKeyFromTransport = jest.fn();
        const onTransportEnabled = jest.fn();
        transport.on(KeyTransportEvents.ReceivedKeys, onNewKeyFromTransport);
        transport.on(RoomAndToDeviceEvents.EnabledTransportsChanged, onTransportEnabled);

        transport.setEnabled({ toDevice: false, room: false });
        const dateNow = Date.now();
        getRoomTransport(transport).emit(KeyTransportEvents.ReceivedKeys, "user", "device", "roomKey", 0, dateNow);
        getToDeviceTransport(transport).emit(
            KeyTransportEvents.ReceivedKeys,
            "user",
            "device",
            "toDeviceKey",
            0,
            Date.now(),
        );

        expect(debug).toHaveBeenCalledWith("To Device transport is disabled, ignoring received keys");
        // for room key transport we will never get a disabled message because its will always just turn on
        expect(onTransportEnabled).toHaveBeenNthCalledWith(1, { toDevice: false, room: false });
        expect(onTransportEnabled).toHaveBeenNthCalledWith(2, { toDevice: false, room: true });
        expect(onNewKeyFromTransport).toHaveBeenCalledTimes(1);
        expect(onNewKeyFromTransport).toHaveBeenCalledWith("user", "device", "roomKey", 0, dateNow);
    });
});
