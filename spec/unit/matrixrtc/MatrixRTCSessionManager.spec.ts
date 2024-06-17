/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import {
    ClientEvent,
    EventTimeline,
    EventType,
    IRoomTimelineData,
    MatrixClient,
    MatrixEvent,
    RoomEvent,
} from "../../../src";
import { RoomStateEvent } from "../../../src/models/room-state";
import { CallMembershipData } from "../../../src/matrixrtc/CallMembership";
import { MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc/MatrixRTCSessionManager";
import { makeMockRoom } from "./mocks";

const membershipTemplate: CallMembershipData = {
    call_id: "",
    scope: "m.room",
    application: "m.call",
    device_id: "AAAAAAA",
    expires: 60 * 60 * 1000,
    membershipID: "bloop",
    foci_active: [{ type: "test" }],
};

describe("MatrixRTCSessionManager", () => {
    let client: MatrixClient;

    beforeEach(async () => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.matrixRTC.start();
    });

    afterEach(() => {
        client.stopClient();
        client.matrixRTC.stop();
    });

    it("Fires event when session starts", () => {
        const onStarted = jest.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

        try {
            const room1 = makeMockRoom([membershipTemplate]);
            jest.spyOn(client, "getRooms").mockReturnValue([room1]);

            client.emit(ClientEvent.Room, room1);
            expect(onStarted).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
        } finally {
            client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
        }
    });

    it("Fires event when session ends", () => {
        const onEnded = jest.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);

        const memberships = [membershipTemplate];

        const room1 = makeMockRoom(memberships);
        jest.spyOn(client, "getRooms").mockReturnValue([room1]);
        jest.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);

        memberships.splice(0, 1);

        const roomState = room1.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
        const membEvent = roomState.getStateEvents("")[0];

        client.emit(RoomStateEvent.Events, membEvent, roomState, null);

        expect(onEnded).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
    });

    it("Calls onCallEncryption on encryption keys event", async () => {
        const room1 = makeMockRoom([membershipTemplate]);
        jest.spyOn(client, "getRooms").mockReturnValue([room1]);
        jest.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);
        const onCallEncryptionMock = jest.fn();
        client.matrixRTC.getRoomSession(room1).onCallEncryption = onCallEncryptionMock;
        client.decryptEventIfNeeded = () => Promise.resolve();
        const timelineEvent = {
            getType: jest.fn().mockReturnValue(EventType.CallEncryptionKeysPrefix),
            getContent: jest.fn().mockReturnValue({}),
            getSender: jest.fn().mockReturnValue("@mock:user.example"),
            getRoomId: jest.fn().mockReturnValue("!room:id"),
            sender: {
                userId: "@mock:user.example",
            },
        } as unknown as MatrixEvent;
        client.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);
        await new Promise(process.nextTick);
        expect(onCallEncryptionMock).toHaveBeenCalled();
    });
});
