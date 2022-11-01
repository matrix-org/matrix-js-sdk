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
import { CallEventHandler, CallEventHandlerEvent } from "../../../src/webrtc/callEventHandler";
import { SyncState } from "../../../src/sync";

describe("callEventHandler", () => {
    it("should ignore a call if invite & hangup come within a single sync", () => {
        const testClient = new TestClient();
        const client = testClient.client;
        const room = new Room("!room:id", client, "@user:id");
        const timelineData: IRoomTimelineData = { timeline: new EventTimeline(new EventTimelineSet(room, {})) };
        client.callEventHandler = new CallEventHandler(client);
        client.callEventHandler.start();

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
        client.emit(ClientEvent.Sync, SyncState.Syncing, null);

        expect(incomingCallEmitted).not.toHaveBeenCalled();
    });
});
