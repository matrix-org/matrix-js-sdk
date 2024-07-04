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

import "fake-indexeddb/auto";

import HttpBackend from "matrix-mock-request";

import {
    EventTimeline,
    MatrixEvent,
    RoomEvent,
    RoomStateEvent,
    RoomMemberEvent,
    UNSTABLE_MSC2716_MARKER,
    MatrixClient,
    ClientEvent,
    IndexedDBCryptoStore,
    ISyncResponse,
    IRoomEvent,
    IJoinedRoom,
    IStateEvent,
    IMinimalEvent,
    NotificationCountType,
    IEphemeral,
    Room,
    IndexedDBStore,
    RelationType,
    EventType,
    MatrixEventEvent,
} from "../../src";
import { ReceiptType } from "../../src/@types/read_receipts";
import { UNREAD_THREAD_NOTIFICATIONS } from "../../src/@types/sync";
import * as utils from "../test-utils/test-utils";
import { TestClient } from "../TestClient";
import { emitPromise, mkEvent, mkMessage } from "../test-utils/test-utils";
import { THREAD_RELATION_TYPE } from "../../src/models/thread";
import { IActionsObject } from "../../src/pushprocessor";
import { KnownMembership } from "../../src/@types/membership";

describe("MatrixClient syncing", () => {
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const otherUserId = "@bob:localhost";
    const userA = "@alice:bar";
    const userB = "@bob:bar";
    const userC = "@claire:bar";
    const roomOne = "!foo:localhost";
    const roomTwo = "!bar:localhost";
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

    describe("startClient", () => {
        const syncData = {
            next_batch: "batch_token",
            rooms: {},
            presence: {},
        };

        it("should /sync after /pushrules and /filter.", async () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            await httpBackend!.flushAllExpected();
        });

        it("should pass the 'next_batch' token from /sync to the since= param  of the next /sync", async () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(req.queryParams!.since).toEqual(syncData.next_batch);
                })
                .respond(200, syncData);

            client!.startClient();

            await httpBackend!.flushAllExpected();
        });

        it("should emit RoomEvent.MyMembership for invite->leave->invite cycles", async () => {
            await client!.initCrypto();

            const roomId = "!cycles:example.org";

            // First sync: an invite
            const inviteSyncRoomSection = {
                invite: {
                    [roomId]: {
                        invite_state: {
                            events: [
                                {
                                    type: "m.room.member",
                                    state_key: selfUserId,
                                    content: {
                                        membership: KnownMembership.Invite,
                                    },
                                },
                            ],
                        },
                    },
                },
            };
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: inviteSyncRoomSection,
            });

            // Second sync: a leave (reject of some kind)
            httpBackend!.when("POST", "/leave").respond(200, {});
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: {
                    leave: {
                        [roomId]: {
                            account_data: { events: [] },
                            ephemeral: { events: [] },
                            state: {
                                events: [
                                    {
                                        type: "m.room.member",
                                        state_key: selfUserId,
                                        content: {
                                            membership: KnownMembership.Leave,
                                        },
                                        prev_content: {
                                            membership: KnownMembership.Invite,
                                        },
                                        // XXX: And other fields required on an event
                                    },
                                ],
                            },
                            timeline: {
                                limited: false,
                                events: [
                                    {
                                        type: "m.room.member",
                                        state_key: selfUserId,
                                        content: {
                                            membership: KnownMembership.Leave,
                                        },
                                        prev_content: {
                                            membership: KnownMembership.Invite,
                                        },
                                        // XXX: And other fields required on an event
                                    },
                                ],
                            },
                        },
                    },
                },
            });

            // Third sync: another invite
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: inviteSyncRoomSection,
            });

            // First fire: an initial invite
            let fires = 0;
            client!.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                // Room, string, string
                fires++;
                expect(room.roomId).toBe(roomId);
                expect(membership).toBe(KnownMembership.Invite);
                expect(oldMembership).toBeFalsy();

                // Second fire: a leave
                client!.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                    fires++;
                    expect(room.roomId).toBe(roomId);
                    expect(membership).toBe(KnownMembership.Leave);
                    expect(oldMembership).toBe(KnownMembership.Invite);

                    // Third/final fire: a second invite
                    client!.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                        fires++;
                        expect(room.roomId).toBe(roomId);
                        expect(membership).toBe(KnownMembership.Invite);
                        expect(oldMembership).toBe(KnownMembership.Leave);
                    });
                });

                // For maximum safety, "leave" the room after we register the handler
                client!.leave(roomId);
            });

            // noinspection ES6MissingAwait
            client!.startClient();
            await httpBackend!.flushAllExpected();

            expect(fires).toBe(3);
        });

        it("should emit RoomEvent.MyMembership for knock->leave->knock cycles", async () => {
            await client!.initCrypto();

            const roomId = "!cycles:example.org";

            // First sync: an knock
            const knockSyncRoomSection = {
                knock: {
                    [roomId]: {
                        knock_state: {
                            events: [
                                {
                                    type: "m.room.member",
                                    state_key: selfUserId,
                                    content: {
                                        membership: KnownMembership.Knock,
                                    },
                                },
                            ],
                        },
                    },
                },
            };
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: knockSyncRoomSection,
            });

            // Second sync: a leave (reject of some kind)
            httpBackend!.when("POST", "/leave").respond(200, {});
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: {
                    leave: {
                        [roomId]: {
                            account_data: { events: [] },
                            ephemeral: { events: [] },
                            state: {
                                events: [
                                    {
                                        type: "m.room.member",
                                        state_key: selfUserId,
                                        content: {
                                            membership: KnownMembership.Leave,
                                        },
                                        prev_content: {
                                            membership: KnownMembership.Knock,
                                        },
                                        // XXX: And other fields required on an event
                                    },
                                ],
                            },
                            timeline: {
                                limited: false,
                                events: [
                                    {
                                        type: "m.room.member",
                                        state_key: selfUserId,
                                        content: {
                                            membership: KnownMembership.Leave,
                                        },
                                        prev_content: {
                                            membership: KnownMembership.Knock,
                                        },
                                        // XXX: And other fields required on an event
                                    },
                                ],
                            },
                        },
                    },
                },
            });

            // Third sync: another knock
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: knockSyncRoomSection,
            });

            // First fire: an initial knock
            let fires = 0;
            client!.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                // Room, string, string
                fires++;
                expect(room.roomId).toBe(roomId);
                expect(membership).toBe(KnownMembership.Knock);
                expect(oldMembership).toBeFalsy();

                // Second fire: a leave
                client!.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                    fires++;
                    expect(room.roomId).toBe(roomId);
                    expect(membership).toBe(KnownMembership.Leave);
                    expect(oldMembership).toBe(KnownMembership.Knock);

                    // Third/final fire: a second knock
                    client!.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                        fires++;
                        expect(room.roomId).toBe(roomId);
                        expect(membership).toBe(KnownMembership.Knock);
                        expect(oldMembership).toBe(KnownMembership.Leave);
                    });
                });

                // For maximum safety, "leave" the room after we register the handler
                client!.leave(roomId);
            });

            // noinspection ES6MissingAwait
            client!.startClient();
            await httpBackend!.flushAllExpected();

            expect(fires).toBe(3);
        });

        it("should honour lazyLoadMembers if user is not a guest", () => {
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(JSON.parse(req.queryParams!.filter).room.state.lazy_load_members).toBeTruthy();
                })
                .respond(200, syncData);

            client!.setGuest(false);
            client!.startClient({ lazyLoadMembers: true });

            return httpBackend!.flushAllExpected();
        });

        it("should not honour lazyLoadMembers if user is a guest", () => {
            httpBackend!.expectedRequests = [];
            httpBackend!.when("GET", "/versions").respond(200, {});
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(JSON.parse(req.queryParams!.filter).room?.state?.lazy_load_members).toBeFalsy();
                })
                .respond(200, syncData);

            client!.setGuest(true);
            client!.startClient({ lazyLoadMembers: true });

            return httpBackend!.flushAllExpected();
        });

        it("should emit ClientEvent.Room when invited while crypto is disabled", async () => {
            const roomId = "!invite:example.org";

            // First sync: an invite
            const inviteSyncRoomSection = {
                invite: {
                    [roomId]: {
                        invite_state: {
                            events: [
                                {
                                    type: "m.room.member",
                                    state_key: selfUserId,
                                    content: {
                                        membership: KnownMembership.Invite,
                                    },
                                },
                            ],
                        },
                    },
                },
            };
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: inviteSyncRoomSection,
            });

            // First fire: an initial invite
            let fires = 0;
            client!.once(ClientEvent.Room, (room) => {
                fires++;
                expect(room.roomId).toBe(roomId);
            });

            // noinspection ES6MissingAwait
            client!.startClient();
            await httpBackend!.flushAllExpected();

            expect(fires).toBe(1);
        });

        it("should emit ClientEvent.Room when knocked while crypto is disabled", async () => {
            const roomId = "!knock:example.org";

            // First sync: a knock
            const knockSyncRoomSection = {
                knock: {
                    [roomId]: {
                        knock_state: {
                            events: [
                                {
                                    type: "m.room.member",
                                    state_key: selfUserId,
                                    content: {
                                        membership: KnownMembership.Knock,
                                    },
                                },
                            ],
                        },
                    },
                },
            };
            httpBackend!.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: knockSyncRoomSection,
            });

            // First fire: an initial knock
            let fires = 0;
            client!.once(ClientEvent.Room, (room) => {
                fires++;
                expect(room.roomId).toBe(roomId);
            });

            // noinspection ES6MissingAwait
            client!.startClient();
            await httpBackend!.flushAllExpected();

            expect(fires).toBe(1);
        });

        it("should work when all network calls fail", async () => {
            httpBackend!.expectedRequests = [];
            httpBackend!.when("GET", "").fail(0, new Error("CORS or something"));
            const prom = client!.startClient();
            await Promise.all([expect(prom).resolves.toBeUndefined(), httpBackend!.flushAllExpected()]);
        });
    });

    describe("initial sync", () => {
        const syncData = {
            next_batch: "batch_token",
            rooms: {},
            presence: {},
        };

        it("should only apply initialSyncLimit to the initial sync", () => {
            // 1st request
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(JSON.parse(req.queryParams!.filter).room.timeline.limit).toEqual(1);
                })
                .respond(200, syncData);
            // 2nd request
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(req.queryParams!.filter).toEqual("a filter id");
                })
                .respond(200, syncData);

            client!.startClient({ initialSyncLimit: 1 });

            httpBackend!.flushSync(undefined);
            return httpBackend!.flushAllExpected();
        });

        it("should not apply initialSyncLimit to a first sync if we have a stored token", () => {
            httpBackend!
                .when("GET", "/sync")
                .check((req) => {
                    expect(req.queryParams!.filter).toEqual("a filter id");
                })
                .respond(200, syncData);

            client!.store.getSavedSyncToken = jest.fn().mockResolvedValue("this-is-a-token");
            client!.startClient({ initialSyncLimit: 1 });

            return httpBackend!.flushAllExpected();
        });
    });

    describe("resolving invites to profile info", () => {
        const syncData: ISyncResponse = {
            account_data: {
                events: [],
            },
            next_batch: "s_5_3",
            presence: {
                events: [],
            },
            rooms: {
                join: {},
                invite: {},
                leave: {},
                knock: {},
            },
        };

        beforeEach(() => {
            syncData.presence!.events = [];
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne,
                            user: otherUserId,
                            msg: "hello",
                        }) as IRoomEvent,
                    ],
                },
                state: {
                    events: [
                        utils.mkMembership({
                            room: roomOne,
                            mship: KnownMembership.Join,
                            user: otherUserId,
                        }),
                        utils.mkMembership({
                            room: roomOne,
                            mship: KnownMembership.Join,
                            user: selfUserId,
                        }),
                        utils.mkEvent({
                            type: "m.room.create",
                            room: roomOne,
                            user: selfUserId,
                            content: {},
                        }),
                    ],
                },
            } as unknown as IJoinedRoom;
        });

        it("should resolve incoming invites from /sync", () => {
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne,
                    mship: KnownMembership.Invite,
                    user: userC,
                }) as IStateEvent,
            );

            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!.when("GET", "/profile/" + encodeURIComponent(userC)).respond(200, {
                avatar_url: "mxc://flibble/wibble",
                displayname: "The Boss",
            });

            client!.startClient({
                resolveInvitesToProfiles: true,
            });

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const member = client!.getRoom(roomOne)!.getMember(userC)!;
                expect(member.name).toEqual("The Boss");
                expect(member.getAvatarUrl("home.server.url", 1, 1, "", false, false)).toBeTruthy();
            });
        });

        it("should use cached values from m.presence wherever possible", () => {
            syncData.presence!.events = [
                utils.mkPresence({
                    user: userC,
                    presence: "online",
                    name: "The Ghost",
                }) as IMinimalEvent,
            ];
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne,
                    mship: KnownMembership.Invite,
                    user: userC,
                }) as IStateEvent,
            );

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient({
                resolveInvitesToProfiles: true,
            });

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const member = client!.getRoom(roomOne)!.getMember(userC)!;
                expect(member.name).toEqual("The Ghost");
            });
        });

        it("should result in events on the room member firing", () => {
            syncData.presence!.events = [
                utils.mkPresence({
                    user: userC,
                    presence: "online",
                    name: "The Ghost",
                }) as IMinimalEvent,
            ];
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne,
                    mship: KnownMembership.Invite,
                    user: userC,
                }) as IStateEvent,
            );

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            let latestFiredName: string;
            client!.on(RoomMemberEvent.Name, (event, m) => {
                if (m.userId === userC && m.roomId === roomOne) {
                    latestFiredName = m.name;
                }
            });

            client!.startClient({
                resolveInvitesToProfiles: true,
            });

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                expect(latestFiredName).toEqual("The Ghost");
            });
        });

        it("should no-op if resolveInvitesToProfiles is not set", () => {
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne,
                    mship: KnownMembership.Invite,
                    user: userC,
                }) as IStateEvent,
            );

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const member = client!.getRoom(roomOne)!.getMember(userC)!;
                expect(member.name).toEqual(userC);
                expect(member.getAvatarUrl("home.server.url", 1, 1, "", false, false)).toBe(null);
            });
        });
    });

    describe("users", () => {
        const syncData = {
            next_batch: "nb",
            presence: {
                events: [
                    utils.mkPresence({
                        user: userA,
                        presence: "online",
                    }),
                    utils.mkPresence({
                        user: userB,
                        presence: "unavailable",
                    }),
                ],
            },
        };

        it("should create users for presence events from /sync", () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                expect(client!.getUser(userA)!.presence).toEqual("online");
                expect(client!.getUser(userB)!.presence).toEqual("unavailable");
            });
        });
    });

    describe("room state", () => {
        const msgText = "some text here";
        const otherDisplayName = "Bob Smith";

        const syncData = {
            rooms: {
                join: {
                    [roomOne]: {
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: roomOne,
                                    user: otherUserId,
                                    msg: "hello",
                                }),
                            ],
                        },
                        state: {
                            events: [
                                utils.mkEvent({
                                    type: "m.room.name",
                                    room: roomOne,
                                    user: otherUserId,
                                    content: {
                                        name: "Old room name",
                                    },
                                }),
                                utils.mkMembership({
                                    room: roomOne,
                                    mship: KnownMembership.Join,
                                    user: otherUserId,
                                }),
                                utils.mkMembership({
                                    room: roomOne,
                                    mship: KnownMembership.Join,
                                    user: selfUserId,
                                }),
                                utils.mkEvent({
                                    type: "m.room.create",
                                    room: roomOne,
                                    user: selfUserId,
                                    content: {},
                                }),
                            ],
                        },
                    },
                    [roomTwo]: {
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: roomTwo,
                                    user: otherUserId,
                                    msg: "hiii",
                                }),
                            ],
                        },
                        state: {
                            events: [
                                utils.mkMembership({
                                    room: roomTwo,
                                    mship: KnownMembership.Join,
                                    user: otherUserId,
                                    name: otherDisplayName,
                                }),
                                utils.mkMembership({
                                    room: roomTwo,
                                    mship: KnownMembership.Join,
                                    user: selfUserId,
                                }),
                                utils.mkEvent({
                                    type: "m.room.create",
                                    room: roomTwo,
                                    user: selfUserId,
                                    content: {},
                                }),
                            ],
                        },
                    },
                },
            },
        };

        const nextSyncData = {
            rooms: {
                join: {
                    [roomOne]: {
                        state: {
                            events: [
                                utils.mkEvent({
                                    type: "m.room.name",
                                    room: roomOne,
                                    user: selfUserId,
                                    content: { name: "A new room name" },
                                }),
                            ],
                        },
                    },
                    [roomTwo]: {
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: roomTwo,
                                    user: otherUserId,
                                    msg: msgText,
                                }),
                            ],
                        },
                        ephemeral: {
                            events: [
                                utils.mkEvent({
                                    type: "m.typing",
                                    room: roomTwo,
                                    content: { user_ids: [otherUserId] },
                                }),
                            ],
                        },
                    },
                },
            },
        };

        it("should continually recalculate the right room name.", () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]).then(() => {
                const room = client!.getRoom(roomOne)!;
                // should have clobbered the name to the one from /events
                expect(room.name).toEqual(nextSyncData.rooms.join[roomOne].state.events[0].content?.name);
            });
        });

        it("should store the right events in the timeline.", () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]).then(() => {
                const room = client!.getRoom(roomTwo)!;
                // should have added the message from /events
                expect(room.timeline.length).toEqual(2);
                expect(room.timeline[1].getContent().body).toEqual(msgText);
            });
        });

        it("should set the right room name.", () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

            client!.startClient();
            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]).then(() => {
                const room = client!.getRoom(roomTwo)!;
                // should use the display name of the other person.
                expect(room.name).toEqual(otherDisplayName);
            });
        });

        it("should set the right user's typing flag.", () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]).then(() => {
                const room = client!.getRoom(roomTwo)!;
                let member = room.getMember(otherUserId)!;
                expect(member).toBeTruthy();
                expect(member.typing).toEqual(true);
                member = room.getMember(selfUserId)!;
                expect(member).toBeTruthy();
                expect(member.typing).toEqual(false);
            });
        });

        // XXX: This test asserts that the js-sdk obeys the spec and treats state
        // events that arrive in the incremental sync as if they preceeded the
        // timeline events, however this breaks peeking, so it's disabled
        // (see sync.js)
        it.skip("should correctly interpret state in incremental sync.", () => {
            httpBackend!.when("GET", "/sync").respond(200, syncData);
            httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

            client!.startClient();
            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]).then(() => {
                const room = client!.getRoom(roomOne)!;
                const stateAtStart = room.getLiveTimeline().getState(EventTimeline.BACKWARDS)!;
                const startRoomNameEvent = stateAtStart.getStateEvents("m.room.name", "");
                expect(startRoomNameEvent!.getContent().name).toEqual("Old room name");

                const stateAtEnd = room.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
                const endRoomNameEvent = stateAtEnd.getStateEvents("m.room.name", "");
                expect(endRoomNameEvent!.getContent().name).toEqual("A new room name");
            });
        });

        it.skip("should update power levels for users in a room", () => {});

        it.skip("should update the room topic", () => {});

        describe("onMarkerStateEvent", () => {
            const normalMessageEvent = utils.mkMessage({
                room: roomOne,
                user: otherUserId,
                msg: "hello",
            });

            it(
                "new marker event *NOT* from the room creator in a subsequent syncs " +
                    "should *NOT* mark the timeline as needing a refresh",
                async () => {
                    const roomCreateEvent = utils.mkEvent({
                        type: "m.room.create",
                        room: roomOne,
                        user: otherUserId,
                        content: {
                            room_version: "9",
                        },
                    });
                    const normalFirstSync = {
                        next_batch: "batch_token",
                        rooms: {
                            join: {
                                [roomOne]: {
                                    timeline: {
                                        events: [normalMessageEvent],
                                        prev_batch: "pagTok",
                                    },
                                    state: {
                                        events: [roomCreateEvent],
                                    },
                                },
                            },
                        },
                    };

                    const nextSyncData = {
                        next_batch: "batch_token",
                        rooms: {
                            join: {
                                [roomOne]: {
                                    timeline: {
                                        events: [
                                            // In subsequent syncs, a marker event in timeline
                                            // range should normally trigger
                                            // `timelineNeedsRefresh=true` but this marker isn't
                                            // being sent by the room creator so it has no
                                            // special meaning in existing room versions.
                                            utils.mkEvent({
                                                type: UNSTABLE_MSC2716_MARKER.name,
                                                room: roomOne,
                                                // The important part we're testing is here!
                                                // `userC` is not the room creator.
                                                user: userC,
                                                skey: "",
                                                content: {
                                                    "m.insertion_id": "$abc",
                                                },
                                            }),
                                        ],
                                        prev_batch: "pagTok",
                                    },
                                },
                            },
                        },
                    };

                    // Ensure the marker is being sent by someone who is not the room creator
                    // because this is the main thing we're testing in this spec.
                    const markerEvent = nextSyncData.rooms.join[roomOne].timeline.events[0];
                    expect(markerEvent.sender).toBeDefined();
                    expect(markerEvent.sender).not.toEqual(roomCreateEvent.sender);

                    httpBackend!.when("GET", "/sync").respond(200, normalFirstSync);
                    httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

                    client!.startClient();
                    await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]);

                    const room = client!.getRoom(roomOne)!;
                    expect(room.getTimelineNeedsRefresh()).toEqual(false);
                },
            );

            [
                {
                    label: "In existing room versions (when the room creator sends the MSC2716 events)",
                    roomVersion: "9",
                },
                {
                    label: "In a MSC2716 supported room version",
                    roomVersion: "org.matrix.msc2716v3",
                },
            ].forEach((testMeta) => {
                // eslint-disable-next-line jest/valid-title
                describe(testMeta.label, () => {
                    const roomCreateEvent = utils.mkEvent({
                        type: "m.room.create",
                        room: roomOne,
                        user: otherUserId,
                        content: {
                            room_version: testMeta.roomVersion,
                        },
                    });

                    const markerEventFromRoomCreator = utils.mkEvent({
                        type: UNSTABLE_MSC2716_MARKER.name,
                        room: roomOne,
                        user: otherUserId,
                        skey: "",
                        content: {
                            "m.insertion_id": "$abc",
                        },
                    });

                    const normalFirstSync = {
                        next_batch: "batch_token",
                        rooms: {
                            join: {
                                [roomOne]: {
                                    timeline: {
                                        events: [normalMessageEvent],
                                        prev_batch: "pagTok",
                                    },
                                    state: {
                                        events: [roomCreateEvent],
                                    },
                                },
                            },
                        },
                    };

                    it(
                        "no marker event in sync response " +
                            "should *NOT* mark the timeline as needing a refresh (check for a sane default)",
                        async () => {
                            const syncData = {
                                next_batch: "batch_token",
                                rooms: {
                                    join: {
                                        [roomOne]: {
                                            timeline: {
                                                events: [normalMessageEvent],
                                                prev_batch: "pagTok",
                                            },
                                            state: {
                                                events: [roomCreateEvent],
                                            },
                                        },
                                    },
                                },
                            };

                            httpBackend!.when("GET", "/sync").respond(200, syncData);

                            client!.startClient();
                            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                            const room = client!.getRoom(roomOne)!;
                            expect(room.getTimelineNeedsRefresh()).toEqual(false);
                        },
                    );

                    it(
                        "marker event already sent within timeline range when you join " +
                            "should *NOT* mark the timeline as needing a refresh (timelineWasEmpty)",
                        async () => {
                            const syncData = {
                                next_batch: "batch_token",
                                rooms: {
                                    join: {
                                        [roomOne]: {
                                            timeline: {
                                                events: [markerEventFromRoomCreator],
                                                prev_batch: "pagTok",
                                            },
                                            state: {
                                                events: [roomCreateEvent],
                                            },
                                        },
                                    },
                                },
                            };

                            httpBackend!.when("GET", "/sync").respond(200, syncData);

                            client!.startClient();
                            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                            const room = client!.getRoom(roomOne)!;
                            expect(room.getTimelineNeedsRefresh()).toEqual(false);
                        },
                    );

                    it(
                        "marker event already sent before joining (in state) " +
                            "should *NOT* mark the timeline as needing a refresh (timelineWasEmpty)",
                        async () => {
                            const syncData = {
                                next_batch: "batch_token",
                                rooms: {
                                    join: {
                                        [roomOne]: {
                                            timeline: {
                                                events: [normalMessageEvent],
                                                prev_batch: "pagTok",
                                            },
                                            state: {
                                                events: [roomCreateEvent, markerEventFromRoomCreator],
                                            },
                                        },
                                    },
                                },
                            };

                            httpBackend!.when("GET", "/sync").respond(200, syncData);

                            client!.startClient();
                            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                            const room = client!.getRoom(roomOne)!;
                            expect(room.getTimelineNeedsRefresh()).toEqual(false);
                        },
                    );

                    it(
                        "new marker event in a subsequent syncs timeline range " +
                            "should mark the timeline as needing a refresh",
                        async () => {
                            const nextSyncData = {
                                next_batch: "batch_token",
                                rooms: {
                                    join: {
                                        [roomOne]: {
                                            timeline: {
                                                events: [
                                                    // In subsequent syncs, a marker event in timeline
                                                    // range should trigger `timelineNeedsRefresh=true`
                                                    markerEventFromRoomCreator,
                                                ],
                                                prev_batch: "pagTok",
                                            },
                                        },
                                    },
                                },
                            };

                            const markerEventId = nextSyncData.rooms.join[roomOne].timeline.events[0].event_id;

                            // Only do the first sync
                            httpBackend!.when("GET", "/sync").respond(200, normalFirstSync);
                            client!.startClient();
                            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                            // Get the room after the first sync so the room is created
                            const room = client!.getRoom(roomOne)!;

                            let emitCount = 0;
                            room.on(RoomEvent.HistoryImportedWithinTimeline, (markerEvent, room) => {
                                expect(markerEvent.getId()).toEqual(markerEventId);
                                expect(room.roomId).toEqual(roomOne);
                                emitCount += 1;
                            });

                            // Now do a subsequent sync with the marker event
                            httpBackend!.when("GET", "/sync").respond(200, nextSyncData);
                            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                            expect(room.getTimelineNeedsRefresh()).toEqual(true);
                            // Make sure `RoomEvent.HistoryImportedWithinTimeline` was emitted
                            expect(emitCount).toEqual(1);
                        },
                    );

                    // Mimic a marker event being sent far back in the scroll back but since our last sync
                    it("new marker event in sync state should mark the timeline as needing a refresh", async () => {
                        const nextSyncData = {
                            next_batch: "batch_token",
                            rooms: {
                                join: {
                                    [roomOne]: {
                                        timeline: {
                                            events: [
                                                utils.mkMessage({
                                                    room: roomOne,
                                                    user: otherUserId,
                                                    msg: "hello again",
                                                }),
                                            ],
                                            prev_batch: "pagTok",
                                        },
                                        state: {
                                            events: [
                                                // In subsequent syncs, a marker event in state
                                                // should trigger `timelineNeedsRefresh=true`
                                                markerEventFromRoomCreator,
                                            ],
                                        },
                                    },
                                },
                            },
                        };

                        httpBackend!.when("GET", "/sync").respond(200, normalFirstSync);
                        httpBackend!.when("GET", "/sync").respond(200, nextSyncData);

                        client!.startClient();
                        await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent(2)]);

                        const room = client!.getRoom(roomOne)!;
                        expect(room.getTimelineNeedsRefresh()).toEqual(true);
                    });
                });
            });
        });

        // Make sure the state listeners work and events are re-emitted properly from
        // the client regardless if we reset and refresh the timeline.
        describe("state listeners and re-registered when RoomEvent.CurrentStateUpdated is fired", () => {
            const EVENTS = [
                utils.mkMessage({
                    room: roomOne,
                    user: userA,
                    msg: "we",
                }),
                utils.mkMessage({
                    room: roomOne,
                    user: userA,
                    msg: "could",
                }),
                utils.mkMessage({
                    room: roomOne,
                    user: userA,
                    msg: "be",
                }),
                utils.mkMessage({
                    room: roomOne,
                    user: userA,
                    msg: "heroes",
                }),
            ];

            const SOME_STATE_EVENT = utils.mkEvent({
                event: true,
                type: "org.matrix.test_state",
                room: roomOne,
                user: userA,
                skey: "",
                content: {
                    foo: "bar",
                },
            });

            const USER_MEMBERSHIP_EVENT = utils.mkMembership({
                room: roomOne,
                mship: KnownMembership.Join,
                user: userA,
            });

            // This appears to work even if we comment out
            // `RoomEvent.CurrentStateUpdated` part which triggers everything to
            // re-listen after the `room.currentState` reference changes. I'm
            // not sure how it's getting re-emitted.
            it(
                "should be able to listen to state events even after " +
                    "the timeline is reset during `limited` sync response",
                async () => {
                    // Create a room from the sync
                    httpBackend!.when("GET", "/sync").respond(200, syncData);
                    client!.startClient();
                    await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                    // Get the room after the first sync so the room is created
                    const room = client!.getRoom(roomOne)!;
                    expect(room).toBeTruthy();

                    let stateEventEmitCount = 0;
                    client!.on(RoomStateEvent.Update, () => {
                        stateEventEmitCount += 1;
                    });

                    // Cause `RoomStateEvent.Update` to be fired
                    room.currentState.setStateEvents([SOME_STATE_EVENT]);
                    // Make sure we can listen to the room state events before the reset
                    expect(stateEventEmitCount).toEqual(1);

                    // Make a `limited` sync which will cause a `room.resetLiveTimeline`
                    const limitedSyncData = {
                        next_batch: "batch_token",
                        rooms: {
                            join: {
                                [roomOne]: {
                                    timeline: {
                                        events: [
                                            utils.mkMessage({
                                                room: roomOne,
                                                user: otherUserId,
                                                msg: "world",
                                            }),
                                        ],
                                        // The important part, make the sync `limited`
                                        limited: true,
                                        prev_batch: "newerTok",
                                    },
                                },
                            },
                        },
                    };
                    httpBackend!.when("GET", "/sync").respond(200, limitedSyncData);

                    await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                    // This got incremented again from processing the sync response
                    expect(stateEventEmitCount).toEqual(2);

                    // Cause `RoomStateEvent.Update` to be fired
                    room.currentState.setStateEvents([SOME_STATE_EVENT]);
                    // Make sure we can still listen to the room state events after the reset
                    expect(stateEventEmitCount).toEqual(3);
                },
            );

            // Make sure it re-registers the state listeners after the
            // `room.currentState` reference changes
            it("should be able to listen to state events even after " + "refreshing the timeline", async () => {
                const testClientWithTimelineSupport = new TestClient(selfUserId, "DEVICE", selfAccessToken, undefined, {
                    timelineSupport: true,
                });
                httpBackend = testClientWithTimelineSupport.httpBackend;
                httpBackend!.when("GET", "/versions").respond(200, {});
                httpBackend!.when("GET", "/pushrules").respond(200, {});
                httpBackend!.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
                client = testClientWithTimelineSupport.client;

                // Create a room from the sync
                httpBackend!.when("GET", "/sync").respond(200, syncData);
                client!.startClient();
                await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                // Get the room after the first sync so the room is created
                const room = client!.getRoom(roomOne)!;
                expect(room).toBeTruthy();

                let stateEventEmitCount = 0;
                client!.on(RoomStateEvent.Update, () => {
                    stateEventEmitCount += 1;
                });

                // Cause `RoomStateEvent.Update` to be fired
                room.currentState.setStateEvents([SOME_STATE_EVENT]);
                // Make sure we can listen to the room state events before the reset
                expect(stateEventEmitCount).toEqual(1);

                const eventsInRoom = syncData.rooms.join[roomOne].timeline.events;
                const contextUrl =
                    `/rooms/${encodeURIComponent(roomOne)}/context/` +
                    `${encodeURIComponent(eventsInRoom[0].event_id!)}`;
                httpBackend!.when("GET", contextUrl).respond(200, () => {
                    return {
                        start: "start_token",
                        events_before: [EVENTS[1], EVENTS[0]],
                        event: EVENTS[2],
                        events_after: [EVENTS[3]],
                        state: [USER_MEMBERSHIP_EVENT],
                        end: "end_token",
                    };
                });

                // Refresh the timeline. This will cause the `room.currentState`
                // reference to change
                await Promise.all([room.refreshLiveTimeline(), httpBackend!.flushAllExpected()]);

                // Cause `RoomStateEvent.Update` to be fired
                room.currentState.setStateEvents([SOME_STATE_EVENT]);
                // Make sure we can still listen to the room state events after the reset
                expect(stateEventEmitCount).toEqual(2);
            });
        });
    });

    describe("timeline", () => {
        beforeEach(() => {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {
                        [roomOne]: {
                            timeline: {
                                events: [
                                    utils.mkMessage({
                                        room: roomOne,
                                        user: otherUserId,
                                        msg: "hello",
                                    }),
                                ],
                                prev_batch: "pagTok",
                            },
                        },
                    },
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();
            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);
        });

        it("should set the back-pagination token on new rooms", () => {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {
                        [roomTwo]: {
                            timeline: {
                                events: [
                                    utils.mkMessage({
                                        room: roomTwo,
                                        user: otherUserId,
                                        msg: "roomtwo",
                                    }),
                                ],
                                prev_batch: "roomtwotok",
                            },
                        },
                    },
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const room = client!.getRoom(roomTwo)!;
                expect(room).toBeTruthy();
                const tok = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
                expect(tok).toEqual("roomtwotok");
            });
        });

        it("should set the back-pagination token on gappy syncs", () => {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {
                        [roomOne]: {
                            timeline: {
                                events: [
                                    utils.mkMessage({
                                        room: roomOne,
                                        user: otherUserId,
                                        msg: "world",
                                    }),
                                ],
                                limited: true,
                                prev_batch: "newerTok",
                            },
                        },
                    },
                },
            };
            httpBackend!.when("GET", "/sync").respond(200, syncData);

            let resetCallCount = 0;
            // the token should be set *before* timelineReset is emitted
            client!.on(RoomEvent.TimelineReset, (room) => {
                resetCallCount++;

                const tl = room?.getLiveTimeline();
                expect(tl?.getEvents().length).toEqual(0);
                const tok = tl?.getPaginationToken(EventTimeline.BACKWARDS);
                expect(tok).toEqual("newerTok");
            });

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const room = client!.getRoom(roomOne)!;
                const tl = room.getLiveTimeline();
                expect(tl.getEvents().length).toEqual(1);
                expect(resetCallCount).toEqual(1);
            });
        });
    });

    describe("receipts", () => {
        const syncData = {
            rooms: {
                join: {
                    [roomOne]: {
                        ephemeral: {
                            events: [],
                        } as IEphemeral,
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: roomOne,
                                    user: otherUserId,
                                    msg: "hello",
                                }),
                                utils.mkMessage({
                                    room: roomOne,
                                    user: otherUserId,
                                    msg: "world",
                                }),
                            ],
                        },
                        state: {
                            events: [
                                utils.mkEvent({
                                    type: "m.room.name",
                                    room: roomOne,
                                    user: otherUserId,
                                    content: {
                                        name: "Old room name",
                                    },
                                }),
                                utils.mkMembership({
                                    room: roomOne,
                                    mship: KnownMembership.Join,
                                    user: otherUserId,
                                }),
                                utils.mkMembership({
                                    room: roomOne,
                                    mship: KnownMembership.Join,
                                    user: selfUserId,
                                }),
                                utils.mkEvent({
                                    type: "m.room.create",
                                    room: roomOne,
                                    user: selfUserId,
                                    content: {},
                                }),
                            ],
                        } as Partial<IJoinedRoom>,
                    },
                },
            },
        };

        beforeEach(() => {
            syncData.rooms.join[roomOne].ephemeral = {
                events: [],
            };
        });

        it("should sync receipts from /sync.", () => {
            const ackEvent = syncData.rooms.join[roomOne].timeline.events[0];
            const receipt: Record<string, any> = {};
            receipt[ackEvent.event_id!] = {
                "m.read": {},
            };
            receipt[ackEvent.event_id!]["m.read"][userC] = {
                ts: 176592842636,
            };
            syncData.rooms.join[roomOne].ephemeral.events = [
                {
                    content: receipt,
                    type: "m.receipt",
                },
            ];
            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const room = client!.getRoom(roomOne)!;
                expect(room.getReceiptsForEvent(new MatrixEvent(ackEvent))).toEqual([
                    {
                        type: "m.read",
                        userId: userC,
                        data: {
                            ts: 176592842636,
                        },
                    },
                ]);
            });
        });
    });

    describe("unread notifications", () => {
        const THREAD_ID = "$ThisIsARandomEventId";

        const syncData = {
            rooms: {
                join: {
                    [roomOne]: {
                        ephemeral: {
                            events: [],
                        },
                        timeline: {
                            events: [
                                utils.mkMessage({
                                    room: roomOne,
                                    user: otherUserId,
                                    msg: "hello",
                                }),
                                utils.mkMessage({
                                    room: roomOne,
                                    user: otherUserId,
                                    msg: "world",
                                }),
                            ],
                        },
                        state: {
                            events: [
                                utils.mkEvent({
                                    type: "m.room.name",
                                    room: roomOne,
                                    user: otherUserId,
                                    content: {
                                        name: "Room name",
                                    },
                                }),
                                utils.mkMembership({
                                    room: roomOne,
                                    mship: KnownMembership.Join,
                                    user: otherUserId,
                                }),
                                utils.mkMembership({
                                    room: roomOne,
                                    mship: KnownMembership.Join,
                                    user: selfUserId,
                                }),
                                utils.mkEvent({
                                    type: "m.room.create",
                                    room: roomOne,
                                    user: selfUserId,
                                    content: {},
                                }),
                            ],
                        },
                    },
                },
            },
        } as unknown as ISyncResponse;
        it("should sync unread notifications.", () => {
            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {
                [THREAD_ID]: {
                    highlight_count: 2,
                    notification_count: 5,
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const room = client!.getRoom(roomOne);

                expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(5);
                expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Highlight)).toBe(2);
            });
        });

        it("should zero total notifications for threads when absent from the notifications object", async () => {
            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {
                [THREAD_ID]: {
                    highlight_count: 2,
                    notification_count: 5,
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

            const room = client!.getRoom(roomOne);

            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(5);

            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {};

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(0);
        });

        it("should zero highlight notifications for threads in encrypted rooms", async () => {
            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {
                [THREAD_ID]: {
                    highlight_count: 2,
                    notification_count: 5,
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

            const room = client!.getRoom(roomOne);

            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(5);

            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {
                [THREAD_ID]: {
                    highlight_count: 0,
                    notification_count: 0,
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Highlight)).toBe(0);
        });

        it("should not zero highlight notifications for threads in encrypted rooms", async () => {
            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {
                [THREAD_ID]: {
                    highlight_count: 2,
                    notification_count: 5,
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            client!.startClient();

            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

            const room = client!.getRoom(roomOne);
            room!.hasEncryptionStateEvent = jest.fn().mockReturnValue(true);

            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(5);

            syncData.rooms.join[roomOne][UNREAD_THREAD_NOTIFICATIONS.name] = {
                [THREAD_ID]: {
                    highlight_count: 0,
                    notification_count: 0,
                },
            };

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Total)).toBe(0);
            expect(room!.getThreadUnreadNotificationCount(THREAD_ID, NotificationCountType.Highlight)).toBe(2);
        });

        it("caches unknown threads receipts and replay them when the thread is created", async () => {
            const THREAD_ID = "$unknownthread:localhost";

            const receipt = {
                type: "m.receipt",
                room_id: "!foo:bar",
                content: {
                    "$event1:localhost": {
                        [ReceiptType.Read]: {
                            "@alice:localhost": { ts: 666, thread_id: THREAD_ID },
                        },
                    },
                },
            };
            syncData.rooms.join[roomOne].ephemeral.events = [receipt];

            httpBackend!.when("GET", "/sync").respond(200, syncData);
            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const room = client?.getRoom(roomOne);
                expect(room).toBeInstanceOf(Room);

                expect(room?.cachedThreadReadReceipts.has(THREAD_ID)).toBe(true);

                const thread = room!.createThread(THREAD_ID, undefined, [], true);

                expect(room?.cachedThreadReadReceipts.has(THREAD_ID)).toBe(false);

                const receipt = thread.getReadReceiptForUserId("@alice:localhost");

                expect(receipt).toStrictEqual({
                    data: {
                        thread_id: "$unknownthread:localhost",
                        ts: 666,
                    },
                    eventId: "$event1:localhost",
                });
            });
        });

        it("only replays receipts relevant to the current context", async () => {
            const THREAD_ID = "$unknownthread:localhost";

            const receipt = {
                type: "m.receipt",
                room_id: "!foo:bar",
                content: {
                    "$event1:localhost": {
                        [ReceiptType.Read]: {
                            "@alice:localhost": { ts: 666, thread_id: THREAD_ID },
                        },
                    },
                    "$otherevent:localhost": {
                        [ReceiptType.Read]: {
                            "@alice:localhost": { ts: 999, thread_id: "$otherthread:localhost" },
                        },
                    },
                },
            };
            syncData.rooms.join[roomOne].ephemeral.events = [receipt];

            httpBackend!.when("GET", "/sync").respond(200, syncData);
            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]).then(() => {
                const room = client?.getRoom(roomOne);
                expect(room).toBeInstanceOf(Room);

                expect(room?.cachedThreadReadReceipts.has(THREAD_ID)).toBe(true);

                const thread = room!.createThread(THREAD_ID, undefined, [], true);

                expect(room?.cachedThreadReadReceipts.has(THREAD_ID)).toBe(false);

                const receipt = thread.getReadReceiptForUserId("@alice:localhost");

                expect(receipt).toStrictEqual({
                    data: {
                        thread_id: "$unknownthread:localhost",
                        ts: 666,
                    },
                    eventId: "$event1:localhost",
                });
            });
        });

        describe("encrypted notification logic", () => {
            let roomId: string;
            let syncData: ISyncResponse;

            beforeEach(() => {
                roomId = "!room123:server";
                syncData = {
                    rooms: {
                        join: {
                            [roomId]: {
                                ephemeral: {
                                    events: [],
                                },
                                timeline: {
                                    events: [
                                        utils.mkEvent({
                                            room: roomId,
                                            event: true,
                                            skey: "",
                                            type: EventType.RoomEncryption,
                                            content: {},
                                        }),
                                        utils.mkMessage({
                                            room: roomId,
                                            user: otherUserId,
                                            msg: "hello",
                                        }),
                                    ],
                                },
                                state: {
                                    events: [
                                        utils.mkMembership({
                                            room: roomId,
                                            mship: KnownMembership.Join,
                                            user: otherUserId,
                                        }),
                                        utils.mkMembership({
                                            room: roomId,
                                            mship: KnownMembership.Join,
                                            user: selfUserId,
                                        }),
                                        utils.mkEvent({
                                            type: "m.room.create",
                                            room: roomId,
                                            user: selfUserId,
                                            content: {},
                                        }),
                                    ],
                                },
                            },
                        },
                    },
                } as unknown as ISyncResponse;
            });

            it("should apply encrypted notification logic for events within the same sync blob", async () => {
                httpBackend!.when("GET", "/sync").respond(200, syncData);
                client!.startClient();

                await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                const room = client!.getRoom(roomId)!;
                expect(room).toBeInstanceOf(Room);
                expect(room.getRoomUnreadNotificationCount(NotificationCountType.Total)).toBe(0);
            });

            it("should recalculate highlights on unthreaded receipt for encrypted rooms", async () => {
                const myUserId = client!.getUserId()!;

                const firstEventId = syncData.rooms.join[roomId].timeline.events[1].event_id;

                // add a receipt for the first event in the room (let's say the user has already read that one)
                syncData.rooms.join[roomId].ephemeral.events = [
                    {
                        content: {
                            [firstEventId]: {
                                "m.read": {
                                    [myUserId]: { ts: 1 },
                                },
                            },
                        },
                        type: "m.receipt",
                    },
                ];

                // Now add a highlighting event after that receipt
                const pingEvent = utils.mkMessage({
                    room: roomId,
                    user: otherUserId,
                    msg: client?.getUserId() + " ping",
                }) as IRoomEvent;
                syncData.rooms.join[roomId].timeline.events.push(pingEvent);

                // fudge this to make it a highlight
                client!.getPushActionsForEvent = (ev: MatrixEvent): IActionsObject | null => {
                    if (ev.getId() === pingEvent.event_id) {
                        return {
                            notify: true,
                            tweaks: {
                                highlight: true,
                            },
                        };
                    }
                    return null;
                };

                httpBackend!.when("GET", "/sync").respond(200, syncData);
                client!.startClient();

                await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                const room = client!.getRoom(roomId)!;
                expect(room).toBeInstanceOf(Room);
                // the room should now have one highlight since our receipt was before the ping message
                expect(room.getRoomUnreadNotificationCount(NotificationCountType.Highlight)).toBe(1);
            });

            it("should recalculate highlights on main thread receipt for encrypted rooms", async () => {
                const myUserId = client!.getUserId()!;

                const firstEventId = syncData.rooms.join[roomId].timeline.events[1].event_id;

                // add a receipt for the first event in the room (let's say the user has already read that one)
                syncData.rooms.join[roomId].ephemeral.events = [
                    {
                        content: {
                            [firstEventId]: {
                                "m.read": {
                                    [myUserId]: { ts: 1, thread_id: "main" },
                                },
                            },
                        },
                        type: "m.receipt",
                    },
                ];

                // Now add a highlighting event after that receipt
                const pingEvent = utils.mkMessage({
                    room: roomId,
                    user: otherUserId,
                    msg: client?.getUserId() + " ping",
                }) as IRoomEvent;
                syncData.rooms.join[roomId].timeline.events.push(pingEvent);

                // fudge this to make it a highlight
                client!.getPushActionsForEvent = (ev: MatrixEvent): IActionsObject | null => {
                    if (ev.getId() === pingEvent.event_id) {
                        return {
                            notify: true,
                            tweaks: {
                                highlight: true,
                            },
                        };
                    }
                    return null;
                };

                httpBackend!.when("GET", "/sync").respond(200, syncData);
                client!.startClient();

                await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                const room = client!.getRoom(roomId)!;
                expect(room).toBeInstanceOf(Room);
                // the room should now have one highlight since our receipt was before the ping message
                expect(room.getRoomUnreadNotificationCount(NotificationCountType.Highlight)).toBe(1);
            });

            describe("notification processing in threads", () => {
                let threadEvent1: IRoomEvent;
                let threadEvent2: IRoomEvent;
                let firstEventId: string;

                beforeEach(() => {
                    firstEventId = syncData.rooms.join[roomId].timeline.events[1].event_id;

                    // Add a threaded event off of the first event
                    threadEvent1 = utils.mkEvent({
                        type: EventType.RoomMessage,
                        user: otherUserId,
                        room: roomId,
                        ts: 500,
                        content: {
                            "body": "first thread response",
                            "m.relates_to": {
                                "event_id": firstEventId,
                                "m.in_reply_to": {
                                    event_id: firstEventId,
                                },
                                "rel_type": "io.element.thread",
                            },
                        },
                    }) as IRoomEvent;
                    syncData.rooms.join[roomId].timeline.events.push(threadEvent1);

                    // ...and another
                    threadEvent2 = utils.mkEvent({
                        type: EventType.RoomMessage,
                        user: otherUserId,
                        room: roomId,
                        ts: 1500,
                        content: {
                            "body": "second thread response",
                            "m.relates_to": {
                                "event_id": firstEventId,
                                "m.in_reply_to": {
                                    event_id: firstEventId,
                                },
                                "rel_type": "io.element.thread",
                            },
                        },
                    }) as IRoomEvent;
                    syncData.rooms.join[roomId].timeline.events.push(threadEvent2);

                    // fudge to make these highlights
                    client!.getPushActionsForEvent = (ev: MatrixEvent): IActionsObject | null => {
                        if ([threadEvent1.event_id, threadEvent2.event_id].includes(ev.getId()!)) {
                            return {
                                notify: true,
                                tweaks: {
                                    highlight: true,
                                },
                            };
                        }
                        return null;
                    };
                });

                it("checks threads with notifications on unthreaded receipts", async () => {
                    const myUserId = client!.getUserId()!;

                    // add a receipt for a random, ficticious thread, otherwise the client will
                    // think that the thread is before any threaded receipts and ignore it.
                    syncData.rooms.join[roomId].ephemeral.events = [
                        {
                            content: {
                                [firstEventId]: {
                                    "m.read": {
                                        [myUserId]: { ts: 1, thread_id: "some_other_thread" },
                                    },
                                },
                            },
                            type: "m.receipt",
                        },
                    ];

                    httpBackend!.when("GET", "/sync").respond(200, syncData);
                    client!.startClient({ threadSupport: true });

                    await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                    const room = client!.getRoom(roomId)!;

                    // pretend that the client has decrypted an event to trigger it to compute
                    // local notifications
                    client?.emit(MatrixEventEvent.Decrypted, room.findEventById(firstEventId)!);
                    client?.emit(MatrixEventEvent.Decrypted, room.findEventById(threadEvent1.event_id)!);
                    client?.emit(MatrixEventEvent.Decrypted, room.findEventById(threadEvent2.event_id)!);

                    expect(room).toBeInstanceOf(Room);

                    // we should now have one highlight: the unread message that pings
                    expect(
                        room.getThreadUnreadNotificationCount(firstEventId, NotificationCountType.Highlight),
                    ).toEqual(2);

                    const syncData2 = {
                        rooms: {
                            join: {
                                [roomId]: {
                                    ephemeral: {
                                        events: [
                                            {
                                                content: {
                                                    [firstEventId]: {
                                                        "m.read": {
                                                            [myUserId]: { ts: 1 },
                                                        },
                                                    },
                                                },
                                                type: "m.receipt",
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    } as unknown as ISyncResponse;

                    httpBackend!.when("GET", "/sync").respond(200, syncData2);

                    await Promise.all([httpBackend!.flush("/sync", 1), utils.syncPromise(client!)]);

                    expect(room.getRoomUnreadNotificationCount(NotificationCountType.Highlight)).toBe(0);
                });

                it("should recalculate highlights on threaded receipt for encrypted rooms", async () => {
                    const myUserId = client!.getUserId()!;

                    // add a receipt for the first message in the threadm leaving the second one unread
                    syncData.rooms.join[roomId].ephemeral.events = [
                        {
                            content: {
                                [threadEvent1.event_id]: {
                                    "m.read": {
                                        [myUserId]: { ts: 1, thread_id: firstEventId },
                                    },
                                },
                            },
                            type: "m.receipt",
                        },
                    ];

                    // fudge to make both thread replies highlights
                    client!.getPushActionsForEvent = (ev: MatrixEvent): IActionsObject | null => {
                        if ([threadEvent1.event_id, threadEvent2.event_id].includes(ev.getId()!)) {
                            return {
                                notify: true,
                                tweaks: {
                                    highlight: true,
                                },
                            };
                        }
                        return null;
                    };

                    httpBackend!.when("GET", "/sync").respond(200, syncData);
                    client!.startClient({ threadSupport: true });

                    await Promise.all([httpBackend!.flushAllExpected(), awaitSyncEvent()]);

                    const room = client!.getRoom(roomId)!;
                    expect(room).toBeInstanceOf(Room);

                    // pretend that the client has decrypted an event to trigger it to compute
                    // local notifications
                    client?.emit(MatrixEventEvent.Decrypted, room.findEventById(firstEventId)!);

                    // the room should now have one highlight: the second thread message

                    expect(room.getThreadUnreadNotificationCount(firstEventId, NotificationCountType.Highlight)).toBe(
                        1,
                    );
                });
            });
        });
    });

    describe("of a room", () => {
        it.skip(
            "should sync when a join event (which changes state) for the user" +
                " arrives down the event stream (e.g. join from another device)",
            () => {},
        );

        it.skip("should sync when the user explicitly calls joinRoom", () => {});
    });

    describe("syncLeftRooms", () => {
        beforeEach(async () => {
            client!.startClient();

            await httpBackend!.flushAllExpected();
            // the /sync call from syncLeftRooms ends up in the request
            // queue behind the call from the running client; add a response
            // to flush the client's one out.
            await httpBackend!.when("GET", "/sync").respond(200, {});
        });

        it("should create and use an appropriate filter", () => {
            httpBackend!
                .when("POST", "/filter")
                .check((req) => {
                    expect(req.data).toEqual({
                        room: {
                            timeline: { limit: 1 },
                            include_leave: true,
                        },
                    });
                })
                .respond(200, { filter_id: "another_id" });

            const prom = new Promise<void>((resolve) => {
                httpBackend!
                    .when("GET", "/sync")
                    .check((req) => {
                        expect(req.queryParams!.filter).toEqual("another_id");
                        resolve();
                    })
                    .respond(200, {});
            });

            client!.syncLeftRooms();

            // first flush the filter request; this will make syncLeftRooms
            // make its /sync call
            return Promise.all([
                httpBackend!.flush("/filter").then(() => {
                    // flush the syncs
                    return httpBackend!.flushAllExpected();
                }),
                prom,
            ]);
        });

        it("should set the back-pagination token on left rooms", () => {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    leave: {
                        [roomTwo]: {
                            timeline: {
                                events: [
                                    utils.mkMessage({
                                        room: roomTwo,
                                        user: otherUserId,
                                        msg: "hello",
                                    }),
                                ],
                                prev_batch: "pagTok",
                            },
                        },
                    },
                },
            };

            httpBackend!.when("POST", "/filter").respond(200, {
                filter_id: "another_id",
            });

            httpBackend!.when("GET", "/sync").respond(200, syncData);

            return Promise.all([
                client!.syncLeftRooms().then(() => {
                    const room = client!.getRoom(roomTwo)!;
                    const tok = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);

                    expect(tok).toEqual("pagTok");
                }),

                // first flush the filter request; this will make syncLeftRooms make its /sync call
                httpBackend!.flush("/filter").then(() => {
                    return httpBackend!.flushAllExpected();
                }),
            ]);
        });
    });

    describe("peek", () => {
        beforeEach(() => {
            httpBackend!.expectedRequests = [];
        });

        it.each([undefined, 100])(
            "should return a room based on the room initialSync API with limit %s",
            async (limit) => {
                httpBackend!.when("GET", `/rooms/${encodeURIComponent(roomOne)}/initialSync`).respond(200, {
                    room_id: roomOne,
                    membership: KnownMembership.Leave,
                    messages: {
                        start: "start",
                        end: "end",
                        chunk: [
                            {
                                content: { body: "Message 1" },
                                type: "m.room.message",
                                event_id: "$eventId1",
                                sender: userA,
                                origin_server_ts: 12313525,
                                room_id: roomOne,
                            },
                            {
                                content: { body: "Message 2" },
                                type: "m.room.message",
                                event_id: "$eventId2",
                                sender: userB,
                                origin_server_ts: 12315625,
                                room_id: roomOne,
                            },
                        ],
                    },
                    state: [
                        {
                            content: { name: "Room Name" },
                            type: "m.room.name",
                            event_id: "$eventId",
                            sender: userA,
                            origin_server_ts: 12314525,
                            state_key: "",
                            room_id: roomOne,
                        },
                    ],
                    presence: [
                        {
                            content: {},
                            type: "m.presence",
                            sender: userA,
                        },
                    ],
                });
                httpBackend!.when("GET", "/events").respond(200, { chunk: [] });

                const prom = client!.peekInRoom(roomOne, limit);
                await httpBackend!.flushAllExpected();
                const room = await prom;

                expect(room.roomId).toBe(roomOne);
                expect(room.getMyMembership()).toBe(KnownMembership.Leave);
                expect(room.name).toBe("Room Name");
                expect(room.currentState.getStateEvents("m.room.name", "")?.getId()).toBe("$eventId");
                expect(room.timeline[0].getContent().body).toBe("Message 1");
                expect(room.timeline[1].getContent().body).toBe("Message 2");
                client?.stopPeeking();
                httpBackend!.when("GET", "/events").respond(200, { chunk: [] });
                await httpBackend!.flushAllExpected();
            },
        );
    });

    describe("user account data", () => {
        it("should include correct prevEv in the ClientEvent.AccountData emit", async () => {
            const eventA1 = new MatrixEvent({ type: "a", content: { body: "1" } });
            const eventA2 = new MatrixEvent({ type: "a", content: { body: "2" } });
            const eventB1 = new MatrixEvent({ type: "b", content: { body: "1" } });
            const eventB2 = new MatrixEvent({ type: "b", content: { body: "2" } });

            client!.store.storeAccountDataEvents([eventA1, eventB1]);
            const fn = jest.fn();
            client!.on(ClientEvent.AccountData, fn);

            httpBackend!.when("GET", "/sync").respond(200, {
                next_batch: "batch_token",
                rooms: {},
                presence: {},
                account_data: {
                    events: [eventA2.event, eventB2.event],
                },
            });

            await Promise.all([client!.startClient(), httpBackend!.flushAllExpected()]);

            const eventA = client?.getAccountData("a");
            expect(eventA).not.toBe(eventA1);
            const eventB = client?.getAccountData("b");
            expect(eventB).not.toBe(eventB1);

            expect(fn).toHaveBeenCalledWith(eventA, eventA1);
            expect(fn).toHaveBeenCalledWith(eventB, eventB1);

            expect(eventA?.getContent().body).toBe("2");
            expect(eventB?.getContent().body).toBe("2");

            client!.off(ClientEvent.AccountData, fn);
        });
    });

    /**
     * waits for the MatrixClient to emit one or more 'sync' events.
     *
     * @param numSyncs - number of syncs to wait for
     * @returns promise which resolves after the sync events have happened
     */
    function awaitSyncEvent(numSyncs?: number) {
        return utils.syncPromise(client!, numSyncs);
    }
});

describe("MatrixClient syncing (IndexedDB version)", () => {
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const syncData = {
        next_batch: "batch_token",
        rooms: {},
        presence: {},
    };

    it("should emit ClientEvent.Room when invited while using indexeddb crypto store", async () => {
        const idbTestClient = new TestClient(selfUserId, "DEVICE", selfAccessToken, undefined, {
            cryptoStore: new IndexedDBCryptoStore(global.indexedDB, "tests"),
        });
        const idbHttpBackend = idbTestClient.httpBackend;
        const idbClient = idbTestClient.client;
        idbHttpBackend.when("GET", "/versions").respond(200, {});
        idbHttpBackend.when("GET", "/pushrules/").respond(200, {});
        idbHttpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });

        await idbClient.initCrypto();

        const roomId = "!invite:example.org";

        // First sync: an invite
        const inviteSyncRoomSection = {
            invite: {
                [roomId]: {
                    invite_state: {
                        events: [
                            {
                                type: "m.room.member",
                                state_key: selfUserId,
                                content: {
                                    membership: KnownMembership.Invite,
                                },
                            },
                        ],
                    },
                },
            },
        };
        idbHttpBackend.when("GET", "/sync").respond(200, {
            ...syncData,
            rooms: inviteSyncRoomSection,
        });

        // First fire: an initial invite
        let fires = 0;
        idbClient.once(ClientEvent.Room, (room) => {
            fires++;
            expect(room.roomId).toBe(roomId);
        });

        // noinspection ES6MissingAwait
        idbClient.startClient();
        await idbHttpBackend.flushAllExpected();

        expect(fires).toBe(1);

        idbHttpBackend.verifyNoOutstandingExpectation();
        idbClient.stopClient();
        idbHttpBackend.stop();
    });

    it("should query server for which thread a 2nd order relation belongs to and stash in sync accumulator", async () => {
        const roomId = "!room:example.org";

        async function startClient(client: MatrixClient): Promise<void> {
            await Promise.all([
                idbClient.startClient({
                    // Without this all events just go into the main timeline
                    threadSupport: true,
                }),
                idbHttpBackend.flushAllExpected(),
                emitPromise(idbClient, ClientEvent.Room),
            ]);
        }

        function assertEventsExpected(client: MatrixClient): void {
            const room = client.getRoom(roomId);
            const mainTimelineEvents = room!.getLiveTimeline().getEvents();
            expect(mainTimelineEvents).toHaveLength(1);
            expect(mainTimelineEvents[0].getContent().body).toEqual("Test");

            const thread = room!.getThread("$someThreadId")!;
            expect(thread.replayEvents).toHaveLength(1);
            expect(thread.replayEvents![0].getRelation()!.key).toEqual("🪿");
        }

        let idbTestClient = new TestClient(selfUserId, "DEVICE", selfAccessToken, undefined, {
            store: new IndexedDBStore({
                indexedDB: global.indexedDB,
                dbName: "test",
            }),
        });
        let idbHttpBackend = idbTestClient.httpBackend;
        let idbClient = idbTestClient.client;
        await idbClient.store.startup();

        idbHttpBackend.when("GET", "/versions").respond(200, { versions: ["v1.4"] });
        idbHttpBackend.when("GET", "/pushrules/").respond(200, {});
        idbHttpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });

        const syncRoomSection = {
            join: {
                [roomId]: {
                    timeline: {
                        prev_batch: "foo",
                        events: [
                            mkMessage({
                                room: roomId,
                                user: selfUserId,
                                msg: "Test",
                            }),
                            mkEvent({
                                room: roomId,
                                user: selfUserId,
                                content: {
                                    "m.relates_to": {
                                        rel_type: RelationType.Annotation,
                                        event_id: "$someUnknownEvent",
                                        key: "🪿",
                                    },
                                },
                                type: "m.reaction",
                            }),
                        ],
                    },
                },
            },
        };
        idbHttpBackend.when("GET", "/sync").respond(200, {
            ...syncData,
            rooms: syncRoomSection,
        });
        idbHttpBackend.when("GET", `/rooms/${encodeURIComponent(roomId)}/event/%24someUnknownEvent`).respond(
            200,
            mkEvent({
                room: roomId,
                user: selfUserId,
                content: {
                    "body": "Thread response",
                    "m.relates_to": {
                        rel_type: THREAD_RELATION_TYPE.name,
                        event_id: "$someThreadId",
                    },
                },
                type: "m.room.message",
            }),
        );

        await startClient(idbClient);
        assertEventsExpected(idbClient);

        idbHttpBackend.verifyNoOutstandingExpectation();
        // Force sync accumulator to persist, reset client, assert it doesn't re-fetch event on next start-up
        await idbClient.store.save(true);
        await idbClient.stopClient();
        await idbClient.store.destroy();
        await idbHttpBackend.stop();

        idbTestClient = new TestClient(selfUserId, "DEVICE", selfAccessToken, undefined, {
            store: new IndexedDBStore({
                indexedDB: global.indexedDB,
                dbName: "test",
            }),
        });
        idbHttpBackend = idbTestClient.httpBackend;
        idbClient = idbTestClient.client;
        await idbClient.store.startup();

        idbHttpBackend.when("GET", "/versions").respond(200, { versions: ["v1.4"] });
        idbHttpBackend.when("GET", "/pushrules/").respond(200, {});
        idbHttpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
        idbHttpBackend.when("GET", "/sync").respond(200, syncData);

        await startClient(idbClient);
        assertEventsExpected(idbClient);

        idbHttpBackend.verifyNoOutstandingExpectation();
        await idbClient.stopClient();
        await idbHttpBackend.stop();
    });
});
