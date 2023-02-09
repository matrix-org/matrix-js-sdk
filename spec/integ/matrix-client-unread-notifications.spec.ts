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

import "fake-indexeddb/auto";

import HttpBackend from "matrix-mock-request";

import { Category, ISyncResponse, MatrixClient, NotificationCountType, Room } from "../../src";
import { TestClient } from "../TestClient";

describe("MatrixClient syncing", () => {
    const userA = "@alice:localhost";
    const userB = "@bob:localhost";

    const selfUserId = userA;
    const selfAccessToken = "aseukfgwef";

    let client: MatrixClient | undefined;
    let httpBackend: HttpBackend | undefined;

    const setupTestClient = (): [MatrixClient, HttpBackend] => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        const httpBackend = testClient.httpBackend;
        const client = testClient.client;
        httpBackend!.when("GET", "/versions").respond(200, {});
        httpBackend!.when("GET", "/pushrules").respond(200, {});
        httpBackend!.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
        return [client, httpBackend];
    };

    beforeEach(() => {
        [client, httpBackend] = setupTestClient();
    });

    afterEach(() => {
        httpBackend!.verifyNoOutstandingExpectation();
        client!.stopClient();
        return httpBackend!.stop();
    });

    describe("Stuck unread notifications integration tests", () => {
        const ROOM_ID = "!room:localhost";

        const syncData = getSampleStuckNotificationSyncResponse(ROOM_ID);

        it("resets notifications if the last event originates from the logged in user", async () => {
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(req.queryParams!.filter).toEqual("a filter id");
                })
                .respond(200, syncData);

            client!.store.getSavedSyncToken = jest.fn().mockResolvedValue("this-is-a-token");
            client!.startClient({ initialSyncLimit: 1 });

            await httpBackend!.flushAllExpected();

            const room = client?.getRoom(ROOM_ID);

            expect(room).toBeInstanceOf(Room);
            expect(room?.getUnreadNotificationCount(NotificationCountType.Total)).toBe(0);
        });
    });

    function getSampleStuckNotificationSyncResponse(roomId: string): Partial<ISyncResponse> {
        return {
            next_batch: "batch_token",
            rooms: {
                [Category.Join]: {
                    [roomId]: {
                        timeline: {
                            events: [
                                {
                                    content: {
                                        creator: userB,
                                        room_version: "9",
                                    },
                                    origin_server_ts: 1,
                                    sender: userB,
                                    state_key: "",
                                    type: "m.room.create",
                                    event_id: "$event1",
                                },
                                {
                                    content: {
                                        avatar_url: "",
                                        displayname: userB,
                                        membership: "join",
                                    },
                                    origin_server_ts: 2,
                                    sender: userB,
                                    state_key: userB,
                                    type: "m.room.member",
                                    event_id: "$event2",
                                },
                                {
                                    content: {
                                        ban: 50,
                                        events: {
                                            "m.room.avatar": 50,
                                            "m.room.canonical_alias": 50,
                                            "m.room.encryption": 100,
                                            "m.room.history_visibility": 100,
                                            "m.room.name": 50,
                                            "m.room.power_levels": 100,
                                            "m.room.server_acl": 100,
                                            "m.room.tombstone": 100,
                                        },
                                        events_default: 0,
                                        historical: 100,
                                        invite: 0,
                                        kick: 50,
                                        redact: 50,
                                        state_default: 50,
                                        users: {
                                            [userA]: 100,
                                            [userB]: 100,
                                        },
                                        users_default: 0,
                                    },
                                    origin_server_ts: 3,
                                    sender: userB,
                                    state_key: "",
                                    type: "m.room.power_levels",
                                    event_id: "$event3",
                                },
                                {
                                    content: {
                                        join_rule: "invite",
                                    },
                                    origin_server_ts: 4,
                                    sender: userB,
                                    state_key: "",
                                    type: "m.room.join_rules",
                                    event_id: "$event4",
                                },
                                {
                                    content: {
                                        history_visibility: "shared",
                                    },
                                    origin_server_ts: 5,
                                    sender: userB,
                                    state_key: "",
                                    type: "m.room.history_visibility",
                                    event_id: "$event5",
                                },
                                {
                                    content: {
                                        guest_access: "can_join",
                                    },
                                    origin_server_ts: 6,
                                    sender: userB,
                                    state_key: "",
                                    type: "m.room.guest_access",
                                    unsigned: {
                                        age: 1651569,
                                    },
                                    event_id: "$event6",
                                },
                                {
                                    content: {
                                        algorithm: "m.megolm.v1.aes-sha2",
                                    },
                                    origin_server_ts: 7,
                                    sender: userB,
                                    state_key: "",
                                    type: "m.room.encryption",
                                    event_id: "$event7",
                                },
                                {
                                    content: {
                                        avatar_url: "",
                                        displayname: userA,
                                        is_direct: true,
                                        membership: "invite",
                                    },
                                    origin_server_ts: 8,
                                    sender: userB,
                                    state_key: userA,
                                    type: "m.room.member",
                                    event_id: "$event8",
                                },
                                {
                                    content: {
                                        msgtype: "m.text",
                                        body: "hello",
                                    },
                                    origin_server_ts: 9,
                                    sender: userB,
                                    type: "m.room.message",
                                    event_id: "$event9",
                                },
                                {
                                    content: {
                                        avatar_url: "",
                                        displayname: userA,
                                        membership: "join",
                                    },
                                    origin_server_ts: 10,
                                    sender: userA,
                                    state_key: userA,
                                    type: "m.room.member",
                                    event_id: "$event10",
                                },
                                {
                                    content: {
                                        msgtype: "m.text",
                                        body: "world",
                                    },
                                    origin_server_ts: 11,
                                    sender: userA,
                                    type: "m.room.message",
                                    event_id: "$event11",
                                },
                            ],
                            prev_batch: "123",
                            limited: false,
                        },
                        state: {
                            events: [],
                        },
                        account_data: {
                            events: [
                                {
                                    type: "m.fully_read",
                                    content: {
                                        event_id: "$dER5V1RCMxzAhHXQJoMjqyuoxpPtK2X6hCb9T8Jg2wU",
                                    },
                                },
                            ],
                        },
                        ephemeral: {
                            events: [
                                {
                                    type: "m.receipt",
                                    content: {
                                        $event9: {
                                            "m.read": {
                                                [userA]: {
                                                    ts: 100,
                                                },
                                            },
                                            "m.read.private": {
                                                [userA]: {
                                                    ts: 100,
                                                },
                                            },
                                        },
                                        dER5V1RCMxzAhHXQJoMjqyuoxpPtK2X6hCb9T8Jg2wU: {
                                            "m.read": {
                                                [userB]: {
                                                    ts: 666,
                                                },
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                        unread_notifications: {
                            notification_count: 1,
                            highlight_count: 0,
                        },
                        summary: {
                            "m.joined_member_count": 2,
                            "m.invited_member_count": 0,
                            "m.heroes": [userB],
                        },
                    },
                },
                [Category.Leave]: {},
                [Category.Invite]: {},
            },
        };
    }
});
