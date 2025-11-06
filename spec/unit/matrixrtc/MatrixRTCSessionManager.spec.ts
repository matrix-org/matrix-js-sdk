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

import { ClientEvent, EventTimeline, MatrixClient, type Room } from "../../../src";
import { RoomStateEvent } from "../../../src/models/room-state";
import { MatrixRTCSessionManager, MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc/MatrixRTCSessionManager";
import {
    makeMockRoom,
    type MembershipData,
    sessionMembershipTemplate,
    mockRoomState,
    mockRTCEvent,
    rtcMembershipTemplate,
} from "./mocks";
import { logger } from "../../../src/logger";
import { slotDescriptionToId } from "../../../src/matrixrtc";

describe.each([{ eventKind: "sticky" }, { eventKind: "memberState" }])(
    "MatrixRTCSessionManager ($eventKind)",
    ({ eventKind }) => {
        let client: MatrixClient;
        let membershipTemplate: MembershipData;

        function sendLeaveMembership(room: Room, membershipData: MembershipData[]): void {
            if (eventKind === "memberState") {
                mockRoomState(room, [{ user_id: membershipTemplate.user_id }]);
                const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
                const membEvent = roomState.getStateEvents("org.matrix.msc3401.call.member")[0];
                client.emit(RoomStateEvent.Events, membEvent, roomState, null);
            } else {
                membershipData.splice(0, 1, { user_id: membershipTemplate.user_id });
                client.emit(ClientEvent.Event, mockRTCEvent(membershipData[0], room.roomId, 10000));
            }
        }

        beforeEach(() => {
            client = new MatrixClient({ baseUrl: "base_url" });
            client.matrixRTC.start();
            membershipTemplate = eventKind === "sticky" ? rtcMembershipTemplate : sessionMembershipTemplate;
        });

        afterEach(() => {
            client.stopClient();
            client.matrixRTC.stop();
        });

        it("Fires event when session starts", () => {
            const onStarted = jest.fn();
            client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

            try {
                const room1 = makeMockRoom([membershipTemplate], eventKind === "sticky");
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
                const room1 = makeMockRoom([{ ...membershipTemplate, application: "m.other" }], eventKind === "sticky");
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
            const membershipData: MembershipData[] = [membershipTemplate];
            const room1 = makeMockRoom(membershipData, eventKind === "sticky");
            jest.spyOn(client, "getRooms").mockReturnValue([room1]);
            jest.spyOn(client, "getRoom").mockReturnValue(room1);
            client.emit(ClientEvent.Room, room1);

            sendLeaveMembership(room1, membershipData);

            expect(onEnded).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
        });

        it("Fires correctly with custom slotDescription", () => {
            const onStarted = jest.fn();
            const onEnded = jest.fn();
            const slotDescription = {
                id: "test",
                application: "m.notCall",
            };
            // create a session manager with a custom session description
            const sessionManager = new MatrixRTCSessionManager(logger, client, slotDescription);

            // manually start the session manager (its not the default one started by the client)
            sessionManager.start();
            sessionManager.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
            sessionManager.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

            try {
                // Create a session for applicaation m.other, we ignore this session because it has the wrong application type.
                const room1MembershipData: MembershipData[] =
                    eventKind === "sticky"
                        ? [
                              {
                                  ...membershipTemplate,
                                  application: {
                                      ...rtcMembershipTemplate.application,
                                      type: "m.call",
                                  },
                              },
                          ]
                        : [{ ...membershipTemplate, application: "m.call" }];
                const room1 = makeMockRoom(room1MembershipData, eventKind === "sticky", {
                    application: "m.call",
                    id: "",
                });
                jest.spyOn(client, "getRooms").mockReturnValue([room1]);
                client.emit(ClientEvent.Room, room1);
                expect(onStarted).not.toHaveBeenCalled();
                onStarted.mockClear();

                // Create a session for applicaation m.notCall. We expect this call to be tracked because it has a call_id
                const room2MembershipData: MembershipData[] =
                    eventKind === "sticky"
                        ? [
                              {
                                  ...membershipTemplate,
                                  application: {
                                      ...rtcMembershipTemplate.application,
                                      type: slotDescription.application,
                                  },
                                  slot_id: slotDescriptionToId(slotDescription),
                              },
                          ]
                        : [
                              {
                                  ...membershipTemplate,
                                  application: slotDescription.application,
                                  call_id: slotDescription.id,
                              },
                          ];
                const room2 = makeMockRoom(room2MembershipData, eventKind === "sticky", slotDescription);
                console.log({ room2: room2.roomId });
                jest.spyOn(client, "getRooms").mockReturnValue([room1, room2]);
                client.emit(ClientEvent.Room, room2);
                expect(onStarted).toHaveBeenCalled();
                onStarted.mockClear();

                // Stop room1's RTC session. Tracked.
                jest.spyOn(client, "getRoom").mockReturnValue(room2);
                sendLeaveMembership(room2, room2MembershipData);
                expect(onEnded).toHaveBeenCalled();
                onEnded.mockClear();

                // Stop room1's RTC session. Not tracked.
                jest.spyOn(client, "getRoom").mockReturnValue(room1);
                sendLeaveMembership(room1, room1MembershipData);
                expect(onEnded).not.toHaveBeenCalled();
            } finally {
                client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
                client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
            }
        });

        it("Doesn't fire event if unrelated sessions ends", () => {
            const onEnded = jest.fn();
            client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
            const membership: MembershipData[] =
                eventKind === "sticky"
                    ? [
                          {
                              ...membershipTemplate,
                              application: {
                                  ...rtcMembershipTemplate.application,
                                  type: "m.other_app",
                              },
                          },
                      ]
                    : [{ ...membershipTemplate, application: "m.other_app" }];
            const room1 = makeMockRoom(membership, eventKind === "sticky");
            jest.spyOn(client, "getRooms").mockReturnValue([room1]);
            jest.spyOn(client, "getRoom").mockReturnValue(room1);

            client.emit(ClientEvent.Room, room1);

            sendLeaveMembership(room1, membership);

            expect(onEnded).not.toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
        });
    },
);
