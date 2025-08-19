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

import { ClientEvent, EventTimeline, MatrixClient } from "../../../src";
import { RoomStateEvent } from "../../../src/models/room-state";
import { MatrixRTCSessionManager, MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc/MatrixRTCSessionManager";
import { makeMockRoom, membershipTemplate, mockRoomState } from "./mocks";
import { logger } from "../../../src/logger";

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

    it("Doesn't fire event if unrelated sessions starts", () => {
        const onStarted = jest.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

        try {
            const room1 = makeMockRoom([{ ...membershipTemplate, application: "m.other" }]);
            jest.spyOn(client, "getRooms").mockReturnValue([room1]);

            client.emit(ClientEvent.Room, room1);
            expect(onStarted).not.toHaveBeenCalled();
        } finally {
            client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
        }
    });

    it("Fires event when session ends", () => {
        const onEnded = jest.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
        const room1 = makeMockRoom([membershipTemplate]);
        jest.spyOn(client, "getRooms").mockReturnValue([room1]);
        jest.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);

        mockRoomState(room1, [{ user_id: membershipTemplate.user_id }]);

        const roomState = room1.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
        const membEvent = roomState.getStateEvents("org.matrix.msc3401.call.member")[0];
        client.emit(RoomStateEvent.Events, membEvent, roomState, null);

        expect(onEnded).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
    });

    it("Fires correctly with for with custom sessionDescription", () => {
        const onStarted = jest.fn();
        const onEnded = jest.fn();
        // create a session manager with a custom session description
        const sessionManager = new MatrixRTCSessionManager(logger, client, { id: "test", application: "m.notCall" });

        // manually start the session manager (its not the default one started by the client)
        sessionManager.start();
        sessionManager.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
        sessionManager.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

        try {
            const room1 = makeMockRoom([{ ...membershipTemplate, application: "m.other" }]);
            jest.spyOn(client, "getRooms").mockReturnValue([room1]);

            client.emit(ClientEvent.Room, room1);
            expect(onStarted).not.toHaveBeenCalled();
            onStarted.mockClear();

            const room2 = makeMockRoom([{ ...membershipTemplate, application: "m.notCall", call_id: "test" }]);
            jest.spyOn(client, "getRooms").mockReturnValue([room1, room2]);

            client.emit(ClientEvent.Room, room2);
            expect(onStarted).toHaveBeenCalled();
            onStarted.mockClear();

            mockRoomState(room2, [{ user_id: membershipTemplate.user_id }]);
            jest.spyOn(client, "getRoom").mockReturnValue(room2);

            const roomState = room2.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
            const membEvent = roomState.getStateEvents("org.matrix.msc3401.call.member")[0];
            client.emit(RoomStateEvent.Events, membEvent, roomState, null);
            expect(onEnded).toHaveBeenCalled();
            onEnded.mockClear();

            mockRoomState(room1, [{ user_id: membershipTemplate.user_id }]);
            jest.spyOn(client, "getRoom").mockReturnValue(room1);

            const roomStateOther = room1.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
            const membEventOther = roomStateOther.getStateEvents("org.matrix.msc3401.call.member")[0];
            client.emit(RoomStateEvent.Events, membEventOther, roomStateOther, null);
            expect(onEnded).not.toHaveBeenCalled();
        } finally {
            client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
            client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
        }
    });

    it("Doesn't fire event if unrelated sessions ends", () => {
        const onEnded = jest.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
        const room1 = makeMockRoom([{ ...membershipTemplate, application: "m.other_app" }]);
        jest.spyOn(client, "getRooms").mockReturnValue([room1]);
        jest.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);

        mockRoomState(room1, [{ user_id: membershipTemplate.user_id }]);

        const roomState = room1.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
        const membEvent = roomState.getStateEvents("org.matrix.msc3401.call.member")[0];
        client.emit(RoomStateEvent.Events, membEvent, roomState, null);

        expect(onEnded).not.toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
    });
});
