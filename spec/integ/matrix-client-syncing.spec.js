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

import { EventTimeline, MatrixEvent, RoomEvent, RoomStateEvent, RoomMemberEvent } from "../../src";
import { UNSTABLE_MSC2716_MARKER } from "../../src/@types/event";
import * as utils from "../test-utils/test-utils";
import { TestClient } from "../TestClient";

describe("MatrixClient syncing", function() {
    let client = null;
    let httpBackend = null;
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const otherUserId = "@bob:localhost";
    const userA = "@alice:bar";
    const userB = "@bob:bar";
    const userC = "@claire:bar";
    const roomOne = "!foo:localhost";
    const roomTwo = "!bar:localhost";

    beforeEach(function() {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        client = testClient.client;
        httpBackend.when("GET", "/versions").respond(200, {});
        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
        return httpBackend.stop();
    });

    describe("startClient", function() {
        const syncData = {
            next_batch: "batch_token",
            rooms: {},
            presence: {},
        };

        it("should /sync after /pushrules and /filter.", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            httpBackend.flushAllExpected().then(function() {
                done();
            });
        });

        it("should pass the 'next_batch' token from /sync to the since= param " +
            " of the next /sync", function(done) {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").check(function(req) {
                expect(req.queryParams.since).toEqual(syncData.next_batch);
            }).respond(200, syncData);

            client.startClient();

            httpBackend.flushAllExpected().then(function() {
                done();
            });
        });

        it("should emit RoomEvent.MyMembership for invite->leave->invite cycles", async () => {
            const roomId = "!cycles:example.org";

            // First sync: an invite
            const inviteSyncRoomSection = {
                invite: {
                    [roomId]: {
                        invite_state: {
                            events: [{
                                type: "m.room.member",
                                state_key: selfUserId,
                                content: {
                                    membership: "invite",
                                },
                            }],
                        },
                    },
                },
            };
            httpBackend.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: inviteSyncRoomSection,
            });

            // Second sync: a leave (reject of some kind)
            httpBackend.when("POST", "/leave").respond(200, {});
            httpBackend.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: {
                    leave: {
                        [roomId]: {
                            account_data: { events: [] },
                            ephemeral: { events: [] },
                            state: {
                                events: [{
                                    type: "m.room.member",
                                    state_key: selfUserId,
                                    content: {
                                        membership: "leave",
                                    },
                                    prev_content: {
                                        membership: "invite",
                                    },
                                    // XXX: And other fields required on an event
                                }],
                            },
                            timeline: {
                                limited: false,
                                events: [{
                                    type: "m.room.member",
                                    state_key: selfUserId,
                                    content: {
                                        membership: "leave",
                                    },
                                    prev_content: {
                                        membership: "invite",
                                    },
                                    // XXX: And other fields required on an event
                                }],
                            },
                        },
                    },
                },
            });

            // Third sync: another invite
            httpBackend.when("GET", "/sync").respond(200, {
                ...syncData,
                rooms: inviteSyncRoomSection,
            });

            // First fire: an initial invite
            let fires = 0;
            client.once(RoomEvent.MyMembership, (room, membership, oldMembership) => { // Room, string, string
                fires++;
                expect(room.roomId).toBe(roomId);
                expect(membership).toBe("invite");
                expect(oldMembership).toBeFalsy();

                // Second fire: a leave
                client.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                    fires++;
                    expect(room.roomId).toBe(roomId);
                    expect(membership).toBe("leave");
                    expect(oldMembership).toBe("invite");

                    // Third/final fire: a second invite
                    client.once(RoomEvent.MyMembership, (room, membership, oldMembership) => {
                        fires++;
                        expect(room.roomId).toBe(roomId);
                        expect(membership).toBe("invite");
                        expect(oldMembership).toBe("leave");
                    });
                });

                // For maximum safety, "leave" the room after we register the handler
                client.leave(roomId);
            });

            // noinspection ES6MissingAwait
            client.startClient();
            await httpBackend.flushAllExpected();

            expect(fires).toBe(3);
        });
    });

    describe("resolving invites to profile info", function() {
        const syncData = {
            next_batch: "s_5_3",
            presence: {
                events: [],
            },
            rooms: {
                join: {

                },
            },
        };

        beforeEach(function() {
            syncData.presence.events = [];
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne, user: otherUserId, msg: "hello",
                        }),
                    ],
                },
                state: {
                    events: [
                        utils.mkMembership({
                            room: roomOne, mship: "join", user: otherUserId,
                        }),
                        utils.mkMembership({
                            room: roomOne, mship: "join", user: selfUserId,
                        }),
                        utils.mkEvent({
                            type: "m.room.create", room: roomOne, user: selfUserId,
                            content: {
                                creator: selfUserId,
                            },
                        }),
                    ],
                },
            };
        });

        it("should resolve incoming invites from /sync", function() {
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC,
                }),
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/profile/" + encodeURIComponent(userC)).respond(
                200, {
                    avatar_url: "mxc://flibble/wibble",
                    displayname: "The Boss",
                },
            );

            client.startClient({
                resolveInvitesToProfiles: true,
            });

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                const member = client.getRoom(roomOne).getMember(userC);
                expect(member.name).toEqual("The Boss");
                expect(
                    member.getAvatarUrl("home.server.url", null, null, null, false),
                ).toBeTruthy();
            });
        });

        it("should use cached values from m.presence wherever possible", function() {
            syncData.presence.events = [
                utils.mkPresence({
                    user: userC, presence: "online", name: "The Ghost",
                }),
            ];
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC,
                }),
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient({
                resolveInvitesToProfiles: true,
            });

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                const member = client.getRoom(roomOne).getMember(userC);
                expect(member.name).toEqual("The Ghost");
            });
        });

        it("should result in events on the room member firing", function() {
            syncData.presence.events = [
                utils.mkPresence({
                    user: userC, presence: "online", name: "The Ghost",
                }),
            ];
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC,
                }),
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);

            let latestFiredName = null;
            client.on(RoomMemberEvent.Name, function(event, m) {
                if (m.userId === userC && m.roomId === roomOne) {
                    latestFiredName = m.name;
                }
            });

            client.startClient({
                resolveInvitesToProfiles: true,
            });

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                expect(latestFiredName).toEqual("The Ghost");
            });
        });

        it("should no-op if resolveInvitesToProfiles is not set", function() {
            syncData.rooms.join[roomOne].state.events.push(
                utils.mkMembership({
                    room: roomOne, mship: "invite", user: userC,
                }),
            );

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                const member = client.getRoom(roomOne).getMember(userC);
                expect(member.name).toEqual(userC);
                expect(
                    member.getAvatarUrl("home.server.url", null, null, null, false),
                ).toBe(null);
            });
        });
    });

    describe("users", function() {
        const syncData = {
            next_batch: "nb",
            presence: {
                events: [
                    utils.mkPresence({
                        user: userA, presence: "online",
                    }),
                    utils.mkPresence({
                        user: userB, presence: "unavailable",
                    }),
                ],
            },
        };

        it("should create users for presence events from /sync",
        function() {
            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                expect(client.getUser(userA).presence).toEqual("online");
                expect(client.getUser(userB).presence).toEqual("unavailable");
            });
        });
    });

    describe("room state", function() {
        const msgText = "some text here";
        const otherDisplayName = "Bob Smith";

        const syncData = {
            rooms: {
                join: {

                },
            },
        };
        syncData.rooms.join[roomOne] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomOne, user: otherUserId, msg: "hello",
                    }),
                ],
            },
            state: {
                events: [
                    utils.mkEvent({
                        type: "m.room.name", room: roomOne, user: otherUserId,
                        content: {
                            name: "Old room name",
                        },
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: otherUserId,
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: selfUserId,
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: roomOne, user: selfUserId,
                        content: {
                            creator: selfUserId,
                        },
                    }),
                ],
            },
        };
        syncData.rooms.join[roomTwo] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomTwo, user: otherUserId, msg: "hiii",
                    }),
                ],
            },
            state: {
                events: [
                    utils.mkMembership({
                        room: roomTwo, mship: "join", user: otherUserId,
                        name: otherDisplayName,
                    }),
                    utils.mkMembership({
                        room: roomTwo, mship: "join", user: selfUserId,
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: roomTwo, user: selfUserId,
                        content: {
                            creator: selfUserId,
                        },
                    }),
                ],
            },
        };

        const nextSyncData = {
            rooms: {
                join: {

                },
            },
        };

        nextSyncData.rooms.join[roomOne] = {
            state: {
                events: [
                    utils.mkEvent({
                        type: "m.room.name", room: roomOne, user: selfUserId,
                        content: { name: "A new room name" },
                    }),
                ],
            },
        };

        nextSyncData.rooms.join[roomTwo] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomTwo, user: otherUserId, msg: msgText,
                    }),
                ],
            },
            ephemeral: {
                events: [
                    utils.mkEvent({
                        type: "m.typing", room: roomTwo,
                        content: { user_ids: [otherUserId] },
                    }),
                ],
            },
        };

        it("should continually recalculate the right room name.", function() {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(2),
            ]).then(function() {
                const room = client.getRoom(roomOne);
                // should have clobbered the name to the one from /events
                expect(room.name).toEqual(
                    nextSyncData.rooms.join[roomOne].state.events[0].content.name,
                );
            });
        });

        it("should store the right events in the timeline.", function() {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(2),
            ]).then(function() {
                const room = client.getRoom(roomTwo);
                // should have added the message from /events
                expect(room.timeline.length).toEqual(2);
                expect(room.timeline[1].getContent().body).toEqual(msgText);
            });
        });

        it("should set the right room name.", function() {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();
            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(2),
            ]).then(function() {
                const room = client.getRoom(roomTwo);
                // should use the display name of the other person.
                expect(room.name).toEqual(otherDisplayName);
            });
        });

        it("should set the right user's typing flag.", function() {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(2),
            ]).then(function() {
                const room = client.getRoom(roomTwo);
                let member = room.getMember(otherUserId);
                expect(member).toBeTruthy();
                expect(member.typing).toEqual(true);
                member = room.getMember(selfUserId);
                expect(member).toBeTruthy();
                expect(member.typing).toEqual(false);
            });
        });

        // XXX: This test asserts that the js-sdk obeys the spec and treats state
        // events that arrive in the incremental sync as if they preceeded the
        // timeline events, however this breaks peeking, so it's disabled
        // (see sync.js)
        xit("should correctly interpret state in incremental sync.", function() {
            httpBackend.when("GET", "/sync").respond(200, syncData);
            httpBackend.when("GET", "/sync").respond(200, nextSyncData);

            client.startClient();
            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(2),
            ]).then(function() {
                const room = client.getRoom(roomOne);
                const stateAtStart = room.getLiveTimeline().getState(
                    EventTimeline.BACKWARDS,
                );
                const startRoomNameEvent = stateAtStart.getStateEvents('m.room.name', '');
                expect(startRoomNameEvent.getContent().name).toEqual('Old room name');

                const stateAtEnd = room.getLiveTimeline().getState(
                    EventTimeline.FORWARDS,
                );
                const endRoomNameEvent = stateAtEnd.getStateEvents('m.room.name', '');
                expect(endRoomNameEvent.getContent().name).toEqual('A new room name');
            });
        });

        xit("should update power levels for users in a room", function() {

        });

        xit("should update the room topic", function() {

        });

        describe("onMarkerStateEvent", () => {
            const normalMessageEvent = utils.mkMessage({
                room: roomOne, user: otherUserId, msg: "hello",
            });

            it('new marker event *NOT* from the room creator in a subsequent syncs ' +
                'should *NOT* mark the timeline as needing a refresh', async () => {
                const roomCreateEvent = utils.mkEvent({
                    type: "m.room.create", room: roomOne, user: otherUserId,
                    content: {
                        creator: otherUserId,
                        room_version: '9',
                    },
                });
                const normalFirstSync = {
                    next_batch: "batch_token",
                    rooms: {
                        join: {},
                    },
                };
                normalFirstSync.rooms.join[roomOne] = {
                    timeline: {
                        events: [normalMessageEvent],
                        prev_batch: "pagTok",
                    },
                    state: {
                        events: [roomCreateEvent],
                    },
                };

                const nextSyncData = {
                    next_batch: "batch_token",
                    rooms: {
                        join: {},
                    },
                };
                nextSyncData.rooms.join[roomOne] = {
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
                };

                // Ensure the marker is being sent by someone who is not the room creator
                // because this is the main thing we're testing in this spec.
                const markerEvent = nextSyncData.rooms.join[roomOne].timeline.events[0];
                expect(markerEvent.sender).toBeDefined();
                expect(markerEvent.sender).not.toEqual(roomCreateEvent.sender);

                httpBackend.when("GET", "/sync").respond(200, normalFirstSync);
                httpBackend.when("GET", "/sync").respond(200, nextSyncData);

                client.startClient();
                await Promise.all([
                    httpBackend.flushAllExpected(),
                    awaitSyncEvent(2),
                ]);

                const room = client.getRoom(roomOne);
                expect(room.getTimelineNeedsRefresh()).toEqual(false);
            });

            [{
                label: 'In existing room versions (when the room creator sends the MSC2716 events)',
                roomVersion: '9',
            }, {
                label: 'In a MSC2716 supported room version',
                roomVersion: 'org.matrix.msc2716v3',
            }].forEach((testMeta) => {
                describe(testMeta.label, () => {
                    const roomCreateEvent = utils.mkEvent({
                        type: "m.room.create", room: roomOne, user: otherUserId,
                        content: {
                            creator: otherUserId,
                            room_version: testMeta.roomVersion,
                        },
                    });

                    const markerEventFromRoomCreator = utils.mkEvent({
                        type: UNSTABLE_MSC2716_MARKER.name, room: roomOne, user: otherUserId,
                        skey: "",
                        content: {
                            "m.insertion_id": "$abc",
                        },
                    });

                    const normalFirstSync = {
                        next_batch: "batch_token",
                        rooms: {
                            join: {},
                        },
                    };
                    normalFirstSync.rooms.join[roomOne] = {
                        timeline: {
                            events: [normalMessageEvent],
                            prev_batch: "pagTok",
                        },
                        state: {
                            events: [roomCreateEvent],
                        },
                    };

                    it('no marker event in sync response '+
                        'should *NOT* mark the timeline as needing a refresh (check for a sane default)', async () => {
                        const syncData = {
                            next_batch: "batch_token",
                            rooms: {
                                join: {},
                            },
                        };
                        syncData.rooms.join[roomOne] = {
                            timeline: {
                                events: [normalMessageEvent],
                                prev_batch: "pagTok",
                            },
                            state: {
                                events: [roomCreateEvent],
                            },
                        };

                        httpBackend.when("GET", "/sync").respond(200, syncData);

                        client.startClient();
                        await Promise.all([
                            httpBackend.flushAllExpected(),
                            awaitSyncEvent(),
                        ]);

                        const room = client.getRoom(roomOne);
                        expect(room.getTimelineNeedsRefresh()).toEqual(false);
                    });

                    it('marker event already sent within timeline range when you join ' +
                        'should *NOT* mark the timeline as needing a refresh (timelineWasEmpty)', async () => {
                        const syncData = {
                            next_batch: "batch_token",
                            rooms: {
                                join: {},
                            },
                        };
                        syncData.rooms.join[roomOne] = {
                            timeline: {
                                events: [markerEventFromRoomCreator],
                                prev_batch: "pagTok",
                            },
                            state: {
                                events: [roomCreateEvent],
                            },
                        };

                        httpBackend.when("GET", "/sync").respond(200, syncData);

                        client.startClient();
                        await Promise.all([
                            httpBackend.flushAllExpected(),
                            awaitSyncEvent(),
                        ]);

                        const room = client.getRoom(roomOne);
                        expect(room.getTimelineNeedsRefresh()).toEqual(false);
                    });

                    it('marker event already sent before joining (in state) ' +
                        'should *NOT* mark the timeline as needing a refresh (timelineWasEmpty)', async () => {
                        const syncData = {
                            next_batch: "batch_token",
                            rooms: {
                                join: {},
                            },
                        };
                        syncData.rooms.join[roomOne] = {
                            timeline: {
                                events: [normalMessageEvent],
                                prev_batch: "pagTok",
                            },
                            state: {
                                events: [
                                    roomCreateEvent,
                                    markerEventFromRoomCreator,
                                ],
                            },
                        };

                        httpBackend.when("GET", "/sync").respond(200, syncData);

                        client.startClient();
                        await Promise.all([
                            httpBackend.flushAllExpected(),
                            awaitSyncEvent(),
                        ]);

                        const room = client.getRoom(roomOne);
                        expect(room.getTimelineNeedsRefresh()).toEqual(false);
                    });

                    it('new marker event in a subsequent syncs timeline range ' +
                        'should mark the timeline as needing a refresh', async () => {
                        const nextSyncData = {
                            next_batch: "batch_token",
                            rooms: {
                                join: {},
                            },
                        };
                        nextSyncData.rooms.join[roomOne] = {
                            timeline: {
                                events: [
                                    // In subsequent syncs, a marker event in timeline
                                    // range should trigger `timelineNeedsRefresh=true`
                                    markerEventFromRoomCreator,
                                ],
                                prev_batch: "pagTok",
                            },
                        };

                        const markerEventId = nextSyncData.rooms.join[roomOne].timeline.events[0].event_id;

                        // Only do the first sync
                        httpBackend.when("GET", "/sync").respond(200, normalFirstSync);
                        client.startClient();
                        await Promise.all([
                            httpBackend.flushAllExpected(),
                            awaitSyncEvent(),
                        ]);

                        // Get the room after the first sync so the room is created
                        const room = client.getRoom(roomOne);

                        let emitCount = 0;
                        room.on(RoomEvent.HistoryImportedWithinTimeline, function(markerEvent, room) {
                            expect(markerEvent.getId()).toEqual(markerEventId);
                            expect(room.roomId).toEqual(roomOne);
                            emitCount += 1;
                        });

                        // Now do a subsequent sync with the marker event
                        httpBackend.when("GET", "/sync").respond(200, nextSyncData);
                        await Promise.all([
                            httpBackend.flushAllExpected(),
                            awaitSyncEvent(),
                        ]);

                        expect(room.getTimelineNeedsRefresh()).toEqual(true);
                        // Make sure `RoomEvent.HistoryImportedWithinTimeline` was emitted
                        expect(emitCount).toEqual(1);
                    });

                    // Mimic a marker event being sent far back in the scroll back but since our last sync
                    it('new marker event in sync state should mark the timeline as needing a refresh', async () => {
                        const nextSyncData = {
                            next_batch: "batch_token",
                            rooms: {
                                join: {},
                            },
                        };
                        nextSyncData.rooms.join[roomOne] = {
                            timeline: {
                                events: [
                                    utils.mkMessage({
                                        room: roomOne, user: otherUserId, msg: "hello again",
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
                        };

                        httpBackend.when("GET", "/sync").respond(200, normalFirstSync);
                        httpBackend.when("GET", "/sync").respond(200, nextSyncData);

                        client.startClient();
                        await Promise.all([
                            httpBackend.flushAllExpected(),
                            awaitSyncEvent(2),
                        ]);

                        const room = client.getRoom(roomOne);
                        expect(room.getTimelineNeedsRefresh()).toEqual(true);
                    });
                });
            });
        });

        // Make sure the state listeners work and events are re-emitted properly from
        // the client regardless if we reset and refresh the timeline.
        describe('state listeners and re-registered when RoomEvent.CurrentStateUpdated is fired', () => {
            const EVENTS = [
                utils.mkMessage({
                    room: roomOne, user: userA, msg: "we",
                }),
                utils.mkMessage({
                    room: roomOne, user: userA, msg: "could",
                }),
                utils.mkMessage({
                    room: roomOne, user: userA, msg: "be",
                }),
                utils.mkMessage({
                    room: roomOne, user: userA, msg: "heroes",
                }),
            ];

            const SOME_STATE_EVENT = utils.mkEvent({
                event: true,
                type: 'org.matrix.test_state',
                room: roomOne,
                user: userA,
                skey: "",
                content: {
                    "foo": "bar",
                },
            });

            const USER_MEMBERSHIP_EVENT = utils.mkMembership({
                room: roomOne, mship: "join", user: userA,
            });

            // This appears to work even if we comment out
            // `RoomEvent.CurrentStateUpdated` part which triggers everything to
            // re-listen after the `room.currentState` reference changes. I'm
            // not sure how it's getting re-emitted.
            it("should be able to listen to state events even after " +
               "the timeline is reset during `limited` sync response", async () => {
                // Create a room from the sync
                httpBackend.when("GET", "/sync").respond(200, syncData);
                client.startClient();
                await Promise.all([
                    httpBackend.flushAllExpected(),
                    awaitSyncEvent(),
                ]);

                // Get the room after the first sync so the room is created
                const room = client.getRoom(roomOne);
                expect(room).toBeTruthy();

                let stateEventEmitCount = 0;
                client.on(RoomStateEvent.Update, () => {
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
                        join: {},
                    },
                };
                limitedSyncData.rooms.join[roomOne] = {
                    timeline: {
                        events: [
                            utils.mkMessage({
                                room: roomOne, user: otherUserId, msg: "world",
                            }),
                        ],
                        // The important part, make the sync `limited`
                        limited: true,
                        prev_batch: "newerTok",
                    },
                };
                httpBackend.when("GET", "/sync").respond(200, limitedSyncData);

                await Promise.all([
                    httpBackend.flushAllExpected(),
                    awaitSyncEvent(),
                ]);

                // This got incremented again from processing the sync response
                expect(stateEventEmitCount).toEqual(2);

                // Cause `RoomStateEvent.Update` to be fired
                room.currentState.setStateEvents([SOME_STATE_EVENT]);
                // Make sure we can still listen to the room state events after the reset
                expect(stateEventEmitCount).toEqual(3);
            });

            // Make sure it re-registers the state listeners after the
            // `room.currentState` reference changes
            it("should be able to listen to state events even after " +
               "refreshing the timeline", async () => {
                const testClientWithTimelineSupport = new TestClient(
                    selfUserId,
                    "DEVICE",
                    selfAccessToken,
                    undefined,
                    { timelineSupport: true },
                );
                httpBackend = testClientWithTimelineSupport.httpBackend;
                httpBackend.when("GET", "/versions").respond(200, {});
                httpBackend.when("GET", "/pushrules").respond(200, {});
                httpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });
                client = testClientWithTimelineSupport.client;

                // Create a room from the sync
                httpBackend.when("GET", "/sync").respond(200, syncData);
                client.startClient();
                await Promise.all([
                    httpBackend.flushAllExpected(),
                    awaitSyncEvent(),
                ]);

                // Get the room after the first sync so the room is created
                const room = client.getRoom(roomOne);
                expect(room).toBeTruthy();

                let stateEventEmitCount = 0;
                client.on(RoomStateEvent.Update, () => {
                    stateEventEmitCount += 1;
                });

                // Cause `RoomStateEvent.Update` to be fired
                room.currentState.setStateEvents([SOME_STATE_EVENT]);
                // Make sure we can listen to the room state events before the reset
                expect(stateEventEmitCount).toEqual(1);

                const eventsInRoom = syncData.rooms.join[roomOne].timeline.events;
                const contextUrl = `/rooms/${encodeURIComponent(roomOne)}/context/` +
                    `${encodeURIComponent(eventsInRoom[0].event_id)}`;
                httpBackend.when("GET", contextUrl)
                    .respond(200, function() {
                        return {
                            start: "start_token",
                            events_before: [EVENTS[1], EVENTS[0]],
                            event: EVENTS[2],
                            events_after: [EVENTS[3]],
                            state: [
                                USER_MEMBERSHIP_EVENT,
                            ],
                            end: "end_token",
                        };
                    });

                // Refresh the timeline. This will cause the `room.currentState`
                // reference to change
                await Promise.all([
                    room.refreshLiveTimeline(),
                    httpBackend.flushAllExpected(),
                ]);

                // Cause `RoomStateEvent.Update` to be fired
                room.currentState.setStateEvents([SOME_STATE_EVENT]);
                // Make sure we can still listen to the room state events after the reset
                expect(stateEventEmitCount).toEqual(2);
            });
        });
    });

    describe("timeline", function() {
        beforeEach(function() {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {},
                },
            };
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne, user: otherUserId, msg: "hello",
                        }),
                    ],
                    prev_batch: "pagTok",
                },
            };

            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();
            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]);
        });

        it("should set the back-pagination token on new rooms", function() {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {},
                },
            };
            syncData.rooms.join[roomTwo] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomTwo, user: otherUserId, msg: "roomtwo",
                        }),
                    ],
                    prev_batch: "roomtwotok",
                },
            };

            httpBackend.when("GET", "/sync").respond(200, syncData);

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                const room = client.getRoom(roomTwo);
                expect(room).toBeTruthy();
                const tok = room.getLiveTimeline()
                    .getPaginationToken(EventTimeline.BACKWARDS);
                expect(tok).toEqual("roomtwotok");
            });
        });

        it("should set the back-pagination token on gappy syncs", function() {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    join: {},
                },
            };
            syncData.rooms.join[roomOne] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomOne, user: otherUserId, msg: "world",
                        }),
                    ],
                    limited: true,
                    prev_batch: "newerTok",
                },
            };
            httpBackend.when("GET", "/sync").respond(200, syncData);

            let resetCallCount = 0;
            // the token should be set *before* timelineReset is emitted
            client.on(RoomEvent.TimelineReset, function(room) {
                resetCallCount++;

                const tl = room.getLiveTimeline();
                expect(tl.getEvents().length).toEqual(0);
                const tok = tl.getPaginationToken(EventTimeline.BACKWARDS);
                expect(tok).toEqual("newerTok");
            });

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                const room = client.getRoom(roomOne);
                const tl = room.getLiveTimeline();
                expect(tl.getEvents().length).toEqual(1);
                expect(resetCallCount).toEqual(1);
            });
        });
    });

    describe("receipts", function() {
        const syncData = {
            rooms: {
                join: {

                },
            },
        };
        syncData.rooms.join[roomOne] = {
            timeline: {
                events: [
                    utils.mkMessage({
                        room: roomOne, user: otherUserId, msg: "hello",
                    }),
                    utils.mkMessage({
                        room: roomOne, user: otherUserId, msg: "world",
                    }),
                ],
            },
            state: {
                events: [
                    utils.mkEvent({
                        type: "m.room.name", room: roomOne, user: otherUserId,
                        content: {
                            name: "Old room name",
                        },
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: otherUserId,
                    }),
                    utils.mkMembership({
                        room: roomOne, mship: "join", user: selfUserId,
                    }),
                    utils.mkEvent({
                        type: "m.room.create", room: roomOne, user: selfUserId,
                        content: {
                            creator: selfUserId,
                        },
                    }),
                ],
            },
        };

        beforeEach(function() {
            syncData.rooms.join[roomOne].ephemeral = {
                events: [],
            };
        });

        it("should sync receipts from /sync.", function() {
            const ackEvent = syncData.rooms.join[roomOne].timeline.events[0];
            const receipt = {};
            receipt[ackEvent.event_id] = {
                "m.read": {},
            };
            receipt[ackEvent.event_id]["m.read"][userC] = {
                ts: 176592842636,
            };
            syncData.rooms.join[roomOne].ephemeral.events = [{
                content: receipt,
                room_id: roomOne,
                type: "m.receipt",
            }];
            httpBackend.when("GET", "/sync").respond(200, syncData);

            client.startClient();

            return Promise.all([
                httpBackend.flushAllExpected(),
                awaitSyncEvent(),
            ]).then(function() {
                const room = client.getRoom(roomOne);
                expect(room.getReceiptsForEvent(new MatrixEvent(ackEvent))).toEqual([{
                    type: "m.read",
                    userId: userC,
                    data: {
                        ts: 176592842636,
                    },
                }]);
            });
        });
    });

    describe("of a room", function() {
        xit("should sync when a join event (which changes state) for the user" +
        " arrives down the event stream (e.g. join from another device)", function() {

        });

        xit("should sync when the user explicitly calls joinRoom", function() {

        });
    });

    describe("syncLeftRooms", function() {
        beforeEach(function(done) {
            client.startClient();

            httpBackend.flushAllExpected().then(function() {
                // the /sync call from syncLeftRooms ends up in the request
                // queue behind the call from the running client; add a response
                // to flush the client's one out.
                httpBackend.when("GET", "/sync").respond(200, {});

                done();
            });
        });

        it("should create and use an appropriate filter", function() {
            httpBackend.when("POST", "/filter").check(function(req) {
                expect(req.data).toEqual({
                    room: { timeline: { limit: 1 },
                            include_leave: true } });
            }).respond(200, { filter_id: "another_id" });

            const prom = new Promise((resolve) => {
                httpBackend.when("GET", "/sync").check(function(req) {
                    expect(req.queryParams.filter).toEqual("another_id");
                    resolve();
                }).respond(200, {});
            });

            client.syncLeftRooms();

            // first flush the filter request; this will make syncLeftRooms
            // make its /sync call
            return Promise.all([
                httpBackend.flush("/filter").then(function() {
                    // flush the syncs
                    return httpBackend.flushAllExpected();
                }),
                prom,
            ]);
        });

        it("should set the back-pagination token on left rooms", function() {
            const syncData = {
                next_batch: "batch_token",
                rooms: {
                    leave: {},
                },
            };

            syncData.rooms.leave[roomTwo] = {
                timeline: {
                    events: [
                        utils.mkMessage({
                            room: roomTwo, user: otherUserId, msg: "hello",
                        }),
                    ],
                    prev_batch: "pagTok",
                },
            };

            httpBackend.when("POST", "/filter").respond(200, {
                filter_id: "another_id",
            });

            httpBackend.when("GET", "/sync").respond(200, syncData);

            return Promise.all([
                client.syncLeftRooms().then(function() {
                    const room = client.getRoom(roomTwo);
                    const tok = room.getLiveTimeline().getPaginationToken(
                        EventTimeline.BACKWARDS);

                    expect(tok).toEqual("pagTok");
                }),

                // first flush the filter request; this will make syncLeftRooms make its /sync call
                httpBackend.flush("/filter").then(function() {
                    return httpBackend.flushAllExpected();
                }),
            ]);
        });
    });

    /**
     * waits for the MatrixClient to emit one or more 'sync' events.
     *
     * @param {Number?} numSyncs number of syncs to wait for
     * @returns {Promise} promise which resolves after the sync events have happened
     */
    function awaitSyncEvent(numSyncs) {
        return utils.syncPromise(client, numSyncs);
    }
});
