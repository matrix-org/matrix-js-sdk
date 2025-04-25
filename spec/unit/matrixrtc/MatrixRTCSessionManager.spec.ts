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

import { type Mock } from "jest-mock";

import { ClientEvent, EventTimeline, MatrixClient } from "../../../src";
import { RoomStateEvent } from "../../../src/models/room-state";
import { MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc/MatrixRTCSessionManager";
import { makeMockRoom, makeMockRoomState, membershipTemplate } from "./mocks";

describe("MatrixRTCSessionManager", () => {
    let client: MatrixClient;

    beforeEach(() => {
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
        const room1 = makeMockRoom(membershipTemplate);
        jest.spyOn(client, "getRooms").mockReturnValue([room1]);
        jest.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);

        (room1.getLiveTimeline as Mock).mockReturnValue({
            getState: jest.fn().mockReturnValue(makeMockRoomState([{}], room1.roomId)),
        });

        const roomState = room1.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
        const membEvent = roomState.getStateEvents("")[0];

        client.emit(RoomStateEvent.Events, membEvent, roomState, null);

        expect(onEnded).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
    });
});
