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

import type HttpBackend from "matrix-mock-request";
import {
    ClientEvent,
    HttpApiEvent,
    type IEvent,
    type MatrixClient,
    RoomEvent,
    RoomMemberEvent,
    RoomStateEvent,
    UserEvent,
} from "../../src";
import * as utils from "../test-utils/test-utils";
import { TestClient } from "../TestClient";
import { KnownMembership } from "../../src/@types/membership";

describe("MatrixClient events", function () {
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    let client: MatrixClient | undefined;
    let httpBackend: HttpBackend | undefined;

    const setupTests = (): [MatrixClient, HttpBackend] => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        const client = testClient.client;
        const httpBackend = testClient.httpBackend;
        httpBackend.when("GET", "/versions").respond(200, {});
        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "a filter id" });

        return [client, httpBackend];
    };

    beforeEach(function () {
        [client!, httpBackend] = setupTests();
    });

    afterEach(function () {
        httpBackend?.verifyNoOutstandingExpectation();
        client?.stopClient();
        return httpBackend?.stop();
    });

    const presenceEvents = [
        utils.mkPresence({
            user: "@foo:bar",
            name: "Foo Bar",
            presence: "online",
        }),
    ];

    const roomTimelineEvents = [
        utils.mkMessage({
            room: "!erufh:bar",
            user: "@foo:bar",
            msg: "hmmm",
        }),
    ];

    const roomStateEvents = [
        utils.mkMembership({
            room: "!erufh:bar",
            mship: KnownMembership.Join,
            user: "@foo:bar",
        }),
        utils.mkEvent({
            type: "m.room.create",
            room: "!erufh:bar",
            user: "@foo:bar",
            content: {},
        }),
    ];

    describe("emissions", function () {
        const SYNC_DATA = mockSyncResponse({
            presenceEvents,
            timelineEvents: roomTimelineEvents,
            stateEvents: roomStateEvents,
        });
        const stateMember1Event = utils.mkMembership({
            room: "!erufh:bar",
            mship: KnownMembership.Join,
            user: "@foo1:bar",
        });
        const stateMember2Event = utils.mkMembership({
            room: "!erufh:bar",
            mship: KnownMembership.Join,
            user: "@foo2:bar",
        });
        const stateMember3Event = utils.mkMembership({
            room: "!erufh:bar",
            mship: KnownMembership.Join,
            user: "@foo3:bar",
        });
        // Sync data but with state event in timeline
        const SYNC_DATA_1 = mockSyncResponse({
            presenceEvents,
            timelineEvents: [...roomTimelineEvents, stateMember2Event],
            stateEvents: roomStateEvents,
        });
        // MSC4222 state_after sync data, contains state events in timeline, state and same state event in both
        const SYNC_DATA_STATE_AFTER = mockSyncResponse({
            presenceEvents,
            timelineEvents: [...roomTimelineEvents, stateMember2Event, stateMember3Event],
            msc4222StateEvents: [...roomStateEvents, stateMember1Event, stateMember2Event],
        });
        // MSC4222 state_after "outdated" state sync data
        const SYNC_DATA_STATE_AFTER_OUTDATED = mockSyncResponse({
            presenceEvents,
            timelineEvents: [...roomTimelineEvents, stateMember2Event],
            msc4222StateEvents: [],
        });
        const nextRoomTimelineEvents = [
            utils.mkMessage({
                room: "!erufh:bar",
                user: "@foo:bar",
                msg: "ello ello",
            }),
            utils.mkMessage({
                room: "!erufh:bar",
                user: "@foo:bar",
                msg: ":D",
            }),
        ];
        const ephemeralEvents = [
            utils.mkEvent({
                type: "m.typing",
                room: "!erufh:bar",
                content: {
                    user_ids: ["@foo:bar"],
                },
            }),
        ];
        const NEXT_SYNC_DATA = mockSyncResponse({
            next_batch: "e_6_7",
            timelineEvents: nextRoomTimelineEvents,
            ephemeralEvents,
        });

        it.each([
            ["sync data", SYNC_DATA, roomStateEvents],
            ["sync data with state in timeline", SYNC_DATA_1, [...roomStateEvents, stateMember2Event]],
            [
                "msc4222 state_after sync data",
                SYNC_DATA_STATE_AFTER,
                [...roomStateEvents, stateMember1Event, stateMember2Event],
            ],
            ["msc4222 state_after with 'outdated' state sync data", SYNC_DATA_STATE_AFTER_OUTDATED, []],
        ])(
            "should emit events from both the first and subsequent /sync calls for %s",
            async (_name: string, syncData: any, extraEventsExpected: Partial<IEvent>[]) => {
                httpBackend!.when("GET", "/sync").respond(200, syncData);
                httpBackend!.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);

                const expectedEvents: Partial<IEvent>[] = [
                    ...presenceEvents,
                    ...roomTimelineEvents,
                    ...nextRoomTimelineEvents,
                    ...ephemeralEvents,
                    ...extraEventsExpected,
                ];

                const emittedEvents: Partial<IEvent>[] = [];

                client!.on(ClientEvent.Event, function (event) {
                    emittedEvents.push(event.getEffectiveEvent());
                });

                client!.startClient();

                const compareEvent = (a: Partial<IEvent>, b: Partial<IEvent>): number => {
                    const aEventId = a.event_id ?? "";
                    const bEventId = b.event_id ?? "";
                    return aEventId.localeCompare(bEventId);
                };

                return Promise.all([
                    // wait for two SYNCING events
                    utils.syncPromise(client!).then(() => {
                        return utils.syncPromise(client!);
                    }),
                    httpBackend!.flushAllExpected(),
                ]).then(() => {
                    expect(emittedEvents.sort(compareEvent)).toEqual(expectedEvents.sort(compareEvent));
                });
            },
        );

        it("should emit User events", async () => {
            httpBackend!.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend!.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);
            let fired = false;
            client!.on(UserEvent.Presence, function (event, user) {
                fired = true;
                expect(user).toBeTruthy();
                expect(event).toBeTruthy();
                if (!user || !event) {
                    return;
                }

                expect(event.event).toEqual(SYNC_DATA.presence.events[0]);
                expect(user.presence).toEqual(SYNC_DATA.presence.events[0]?.content?.presence);
            });
            client!.startClient();

            await httpBackend!.flushAllExpected();
            expect(fired).toBe(true);
        });

        it("should emit User events when presence data is absent in first sync", async () => {
            const MODIFIED_SYNC_DATA: any = structuredClone(SYNC_DATA);
            delete MODIFIED_SYNC_DATA["presence"];
            const MODIFIED_NEXT_SYNC_DATA: any = structuredClone(NEXT_SYNC_DATA);
            MODIFIED_NEXT_SYNC_DATA.presence = {
                events: [
                    utils.mkPresence({
                        user: "@foo:bar",
                        name: "Foo Bar",
                        presence: "online",
                    }),
                ],
            };
            httpBackend!.when("GET", "/sync").respond(200, MODIFIED_SYNC_DATA);
            httpBackend!.when("GET", "/sync").respond(200, MODIFIED_NEXT_SYNC_DATA);
            let fired = false;
            client!.on(UserEvent.Presence, function (event, user) {
                fired = true;
                expect(user).toBeTruthy();
                expect(event).toBeTruthy();
                if (!user || !event) {
                    return;
                }
                expect(event.event).toEqual(MODIFIED_NEXT_SYNC_DATA.presence.events[0]);
                expect(user.presence).toEqual(MODIFIED_NEXT_SYNC_DATA.presence.events[0]?.content?.presence);
            });
            client!.startClient();
            await httpBackend!.flushAllExpected();
            expect(fired).toBe(true);
        });

        it("should emit Room events", function () {
            httpBackend!.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend!.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);
            let roomInvokeCount = 0;
            let roomNameInvokeCount = 0;
            let timelineFireCount = 0;
            client!.on(ClientEvent.Room, function (room) {
                roomInvokeCount++;
                expect(room.roomId).toEqual("!erufh:bar");
            });
            client!.on(RoomEvent.Timeline, function (event, room) {
                timelineFireCount++;
                expect(room?.roomId).toEqual("!erufh:bar");
            });
            client!.on(RoomEvent.Name, function (room) {
                roomNameInvokeCount++;
            });

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), utils.syncPromise(client!, 2)]).then(function () {
                expect(roomInvokeCount).toEqual(1);
                expect(roomNameInvokeCount).toEqual(1);
                expect(timelineFireCount).toEqual(3);
            });
        });

        it("should emit RoomState events", function () {
            httpBackend!.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend!.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);

            const roomStateEventTypes = ["m.room.member", "m.room.create"];
            let eventsInvokeCount = 0;
            let membersInvokeCount = 0;
            let newMemberInvokeCount = 0;
            client!.on(RoomStateEvent.Events, function (event, state) {
                eventsInvokeCount++;
                const index = roomStateEventTypes.indexOf(event.getType());
                expect(index).not.toEqual(-1);
                if (index >= 0) {
                    roomStateEventTypes.splice(index, 1);
                }
            });
            client!.on(RoomStateEvent.Members, function (event, state, member) {
                membersInvokeCount++;
                expect(member.roomId).toEqual("!erufh:bar");
                expect(member.userId).toEqual("@foo:bar");
                expect(member.membership).toEqual(KnownMembership.Join);
            });
            client!.on(RoomStateEvent.NewMember, function (event, state, member) {
                newMemberInvokeCount++;
                expect(member.roomId).toEqual("!erufh:bar");
                expect(member.userId).toEqual("@foo:bar");
                expect(member.membership).toBeFalsy();
            });

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), utils.syncPromise(client!, 2)]).then(function () {
                expect(membersInvokeCount).toEqual(1);
                expect(newMemberInvokeCount).toEqual(1);
                expect(eventsInvokeCount).toEqual(2);
            });
        });

        it("should emit RoomMember events", function () {
            httpBackend!.when("GET", "/sync").respond(200, SYNC_DATA);
            httpBackend!.when("GET", "/sync").respond(200, NEXT_SYNC_DATA);

            let typingInvokeCount = 0;
            let powerLevelInvokeCount = 0;
            let nameInvokeCount = 0;
            let membershipInvokeCount = 0;
            client!.on(RoomMemberEvent.Name, function (event, member) {
                nameInvokeCount++;
            });
            client!.on(RoomMemberEvent.Typing, function (event, member) {
                typingInvokeCount++;
                expect(member.typing).toBe(true);
            });
            client!.on(RoomMemberEvent.PowerLevel, function (event, member) {
                powerLevelInvokeCount++;
            });
            client!.on(RoomMemberEvent.Membership, function (event, member) {
                membershipInvokeCount++;
                expect(member.membership).toEqual(KnownMembership.Join);
            });

            client!.startClient();

            return Promise.all([httpBackend!.flushAllExpected(), utils.syncPromise(client!, 2)]).then(function () {
                expect(typingInvokeCount).toEqual(1);
                expect(powerLevelInvokeCount).toEqual(0);
                expect(nameInvokeCount).toEqual(0);
                expect(membershipInvokeCount).toEqual(1);
            });
        });

        it("should emit Session.logged_out on M_UNKNOWN_TOKEN", function () {
            const error = { errcode: "M_UNKNOWN_TOKEN" };
            httpBackend!.when("GET", "/sync").respond(401, error);

            let sessionLoggedOutCount = 0;
            client!.on(HttpApiEvent.SessionLoggedOut, function (errObj) {
                sessionLoggedOutCount++;
                expect(errObj.data).toEqual(error);
            });

            client!.startClient();

            return httpBackend!.flushAllExpected().then(function () {
                expect(sessionLoggedOutCount).toEqual(1);
            });
        });

        it("should emit Session.logged_out on M_UNKNOWN_TOKEN (soft logout)", function () {
            const error = { errcode: "M_UNKNOWN_TOKEN", soft_logout: true };
            httpBackend!.when("GET", "/sync").respond(401, error);

            let sessionLoggedOutCount = 0;
            client!.on(HttpApiEvent.SessionLoggedOut, function (errObj) {
                sessionLoggedOutCount++;
                expect(errObj.data).toEqual(error);
            });

            client!.startClient();

            return httpBackend!.flushAllExpected().then(function () {
                expect(sessionLoggedOutCount).toEqual(1);
            });
        });
    });
});

function mockSyncResponse({
    next_batch = "s_5_3",
    roomId = "!erufh:bar",
    presenceEvents = [],
    timelineEvents = [],
    stateEvents,
    msc4222StateEvents,
    ephemeralEvents = [],
}: {
    next_batch?: string;
    roomId?: string;
    presenceEvents?: Partial<IEvent>[];
    timelineEvents?: Partial<IEvent>[];
    stateEvents?: Partial<IEvent>[];
    msc4222StateEvents?: Partial<IEvent>[];
    ephemeralEvents?: Partial<IEvent>[];
} = {}): any {
    return {
        next_batch,
        presence: {
            events: presenceEvents,
        },
        rooms: {
            join: {
                [roomId]: {
                    timeline: {
                        events: timelineEvents,
                        prev_batch: "s",
                    },
                    ...(stateEvents ? { state: { events: stateEvents } } : undefined),
                    ...(msc4222StateEvents
                        ? { "org.matrix.msc4222.state_after": { events: msc4222StateEvents } }
                        : undefined),
                    ephemeral: {
                        events: ephemeralEvents,
                    },
                },
            },
        },
    };
}
