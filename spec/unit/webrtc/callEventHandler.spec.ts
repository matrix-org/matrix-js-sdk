/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { TestClient } from '../../TestClient';
import {
    ClientEvent,
    EventTimeline,
    EventTimelineSet,
    EventType,
    IRoomTimelineData,
    MatrixEvent,
    Room,
    RoomEvent,
} from "../../../src";
import { MatrixClient } from "../../../src/client";
import { CallEventHandler, CallEventHandlerEvent } from "../../../src/webrtc/callEventHandler";
import { GroupCallEventHandler } from "../../../src/webrtc/groupCallEventHandler";
import { SyncState } from "../../../src/sync";

describe("CallEventHandler", () => {
    let client: MatrixClient;
    beforeEach(() => {
        client = new TestClient("@alice:foo", "somedevice", "token", undefined, {}).client;
        client.callEventHandler = new CallEventHandler(client);
        client.callEventHandler.start();
        client.groupCallEventHandler = new GroupCallEventHandler(client);
        client.groupCallEventHandler.start();
    });

    afterEach(() => {
        client.callEventHandler.stop();
        client.groupCallEventHandler.stop();
    });

    it("should enforce inbound toDevice message ordering", async () => {
        const callEventHandler = client.callEventHandler;
        const event1 = new MatrixEvent({
            type: EventType.CallInvite,
            content: {
                call_id: "123",
                seq: 0,
            },
        });
        callEventHandler["onToDeviceEvent"](event1);

        expect(callEventHandler.callEventBuffer.length).toBe(1);
        expect(callEventHandler.callEventBuffer[0]).toBe(event1);

        const event2 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 1,
            },
        });
        callEventHandler["onToDeviceEvent"](event2);

        expect(callEventHandler.callEventBuffer.length).toBe(2);
        expect(callEventHandler.callEventBuffer[1]).toBe(event2);

        const event3 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 3,
            },
        });
        callEventHandler["onToDeviceEvent"](event3);

        expect(callEventHandler.callEventBuffer.length).toBe(2);
        expect(callEventHandler.nextSeqByCall.get("123")).toBe(2);
        expect(callEventHandler.toDeviceEventBuffers.get("123").length).toBe(1);

        const event4 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 4,
            },
        });
        callEventHandler["onToDeviceEvent"](event4);

        expect(callEventHandler.callEventBuffer.length).toBe(2);
        expect(callEventHandler.nextSeqByCall.get("123")).toBe(2);
        expect(callEventHandler.toDeviceEventBuffers.get("123").length).toBe(2);

        const event5 = new MatrixEvent({
            type: EventType.CallCandidates,
            content: {
                call_id: "123",
                seq: 2,
            },
        });
        callEventHandler["onToDeviceEvent"](event5);

        expect(callEventHandler.callEventBuffer.length).toBe(5);
        expect(callEventHandler.nextSeqByCall.get("123")).toBe(5);
        expect(callEventHandler.toDeviceEventBuffers.get("123").length).toBe(0);
    });

    it("should ignore a call if invite & hangup come within a single sync", () => {
        const room = new Room("!room:id", client, "@user:id");
        const timelineData: IRoomTimelineData = { timeline: new EventTimeline(new EventTimelineSet(room, {})) };

        // Fire off call invite then hangup within a single sync
        const callInvite = new MatrixEvent({
            type: EventType.CallInvite,
            content: {
                call_id: "123",
            },
        });
        client.emit(RoomEvent.Timeline, callInvite, room, false, false, timelineData);

        const callHangup = new MatrixEvent({
            type: EventType.CallHangup,
            content: {
                call_id: "123",
            },
        });
        client.emit(RoomEvent.Timeline, callHangup, room, false, false, timelineData);

        const incomingCallEmitted = jest.fn();
        client.on(CallEventHandlerEvent.Incoming, incomingCallEmitted);

        client.getSyncState = jest.fn().mockReturnValue(SyncState.Syncing);
        client.emit(ClientEvent.Sync, SyncState.Syncing);

        expect(incomingCallEmitted).not.toHaveBeenCalled();
    });
});
