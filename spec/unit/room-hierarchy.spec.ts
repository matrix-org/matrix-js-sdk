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

import fetchMock from "fetch-mock-jest";

import { EventType, MatrixClient, Room } from "../../src";
import { RoomHierarchy } from "../../src/room-hierarchy";

describe("RoomHierarchy", () => {
    const roomId = "!room:server";
    const client = new MatrixClient({ baseUrl: "https://server", userId: "@user:server" });

    it("should load data from /hierarchy API", async () => {
        const spy = fetchMock.getOnce(
            `https://server/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/hierarchy?suggested_only=false`,
            {
                rooms: [],
            },
            { overwriteRoutes: true },
        );

        const room = new Room(roomId, client, client.getSafeUserId());
        const hierarchy = new RoomHierarchy(room);
        const res = await hierarchy.load();

        expect(spy).toHaveBeenCalled();
        expect(res).toHaveLength(0);
    });

    describe("itSuggested", () => {
        it("should return true if a room is suggested", async () => {
            const spy = fetchMock.getOnce(
                `https://server/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/hierarchy?suggested_only=false`,
                {
                    rooms: [
                        {
                            children_state: [
                                {
                                    origin_server_ts: 111,
                                    content: {
                                        suggested: true,
                                        via: ["matrix.org"],
                                    },
                                    type: EventType.SpaceChild,
                                    state_key: "!child_room:server",
                                },
                            ],
                            room_id: roomId,
                        },
                    ],
                },
                { overwriteRoutes: true },
            );

            const room = new Room(roomId, client, client.getSafeUserId());
            const hierarchy = new RoomHierarchy(room);
            await hierarchy.load();

            expect(spy).toHaveBeenCalled();
            expect(hierarchy.isSuggested(hierarchy.root.roomId, "!child_room:server")).toBeTruthy();
        });
    });
});
