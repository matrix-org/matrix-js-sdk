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

import { ClientEvent, MatrixClient } from "../../../src";
import { CallMembershipData } from "../../../src/matrixrtc/CallMembership";
import { makeMockRoom } from "./mocks";

const membershipTemplate: CallMembershipData = {
    call_id: "",
    scope: "m.room",
    application: "m.call",
    device_id: "AAAAAAA",
    expires: 60 * 60 * 1000,
};

describe("MatrixRTCSessionManager", () => {
    let client: MatrixClient;

    beforeEach(async () => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.matrixRTC.start();
    });

    afterEach(() => {
        client.matrixRTC.stop();
    });

    it.skip("Gets active MatrixRTC sessions accross multiple rooms", () => {
        const room1 = makeMockRoom([membershipTemplate]);
        const room2 = makeMockRoom([membershipTemplate]);

        jest.spyOn(client, "getRooms").mockReturnValue([room1, room2]);

        client.emit(ClientEvent.Room, room1);
        client.emit(ClientEvent.Room, room2);

        const sessions = client.matrixRTC.getActiveSessions();
        expect(sessions).toHaveLength(2);
    });

    it.skip("Ignores inactive sessions", () => {
        const room1 = makeMockRoom([membershipTemplate]);
        const room2 = makeMockRoom([]);

        jest.spyOn(client, "getRooms").mockReturnValue([room1, room2]);

        client.emit(ClientEvent.Room, room1);
        client.emit(ClientEvent.Room, room2);

        const sessions = client.matrixRTC.getActiveSessions();
        expect(sessions).toHaveLength(1);
    });
});
