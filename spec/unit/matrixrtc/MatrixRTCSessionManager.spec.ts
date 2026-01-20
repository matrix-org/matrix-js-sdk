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

import { ClientEvent, EventTimeline, MatrixClient, type Room, RoomStateEvent } from "../../../src";
import { MatrixRTCSessionManager, MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc";
import {
    makeMockRoom,
    type MembershipData,
    sessionMembershipTemplate,
    mockRoomState,
    mockRTCEvent,
    rtcMembershipTemplate,
} from "./mocks.ts";
import { logger } from "../../../src/logger";
import { flushPromises } from "../../test-utils/flushPromises";
import { type RtcMembershipData, type SessionMembershipData } from "src/matrixrtc/membership";

describe.each([{ eventKind: "sticky" }, { eventKind: "memberState" }])(
    "MatrixRTCSessionManager ($eventKind)",
    ({ eventKind }) => {
        let client: MatrixClient;

        function generateMembership(opts: { type: string; callId?: string } = { type: "m.call" }): MembershipData {
            if (eventKind === "sticky") {
                return {
                    ...rtcMembershipTemplate,
                    slot_id: opts.callId ? `${opts.type}#${opts.callId}` : rtcMembershipTemplate.slot_id,
                    application: {
                        ...rtcMembershipTemplate.application,
                        type: opts.type,
                    },
                } satisfies RtcMembershipData & { user_id: string };
            }

            return {
                ...sessionMembershipTemplate,
                application: opts.type,
                call_id: opts.callId ?? sessionMembershipTemplate.call_id, // approximate version.
            } satisfies SessionMembershipData & { user_id: string };
        }

        async function sendLeaveMembership(room: Room, membershipData: MembershipData[]): Promise<void> {
            if (eventKind === "memberState") {
                mockRoomState(room, [{ user_id: sessionMembershipTemplate.user_id }]);
                const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
                const membEvent = roomState.getStateEvents("org.matrix.msc3401.call.member")[0];
                client.emit(RoomStateEvent.Events, membEvent, roomState, null);
            } else {
                membershipData.splice(0, 1, { user_id: sessionMembershipTemplate.user_id });
                client.emit(ClientEvent.Event, mockRTCEvent(membershipData[0], room.roomId, 10000));
            }
            await flushPromises();
        }

        beforeEach(() => {
            client = new MatrixClient({ baseUrl: "base_url" });
            client.matrixRTC.start();
        });

        afterEach(() => {
            client.stopClient();
            client.matrixRTC.stop();
            vi.resetAllMocks();
        });

        it("Fires event when session starts", async () => {
            const room1 = makeMockRoom([generateMembership({ type: "m.call" })], eventKind === "sticky");
            vi.spyOn(client, "getRooms").mockReturnValue([room1]);
            const sessionStartedPromise = new Promise((resolve) =>
                client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionStarted, resolve),
            );
            client.emit(ClientEvent.Room, room1);
            await expect(sessionStartedPromise).resolves.toBeTruthy();
        });

        it("Doesn't fire event if unrelated sessions starts", () => {
            const onStarted = vi.fn();
            client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

            try {
                const room1 = makeMockRoom([generateMembership({ type: "m.other" })], eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);

                client.emit(ClientEvent.Room, room1);
                expect(onStarted).not.toHaveBeenCalled();
            } finally {
                client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
            }
        });

        it("Fires event when session ends", async () => {
            const sessionStartedPromise = new Promise((resolve) =>
                client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionStarted, resolve),
            );
            const sessionEndedPromise = new Promise((resolve) =>
                client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionEnded, (...params) => resolve(params)),
            );
            const membershipData: MembershipData[] = [generateMembership()];
            const room1 = makeMockRoom(membershipData, eventKind === "sticky");
            vi.spyOn(client, "getRooms").mockReturnValue([room1]);
            vi.spyOn(client, "getRoom").mockReturnValue(room1);
            client.emit(ClientEvent.Room, room1);
            await sessionStartedPromise;
            await sendLeaveMembership(room1, membershipData);

            await expect(sessionEndedPromise).resolves.toStrictEqual([
                room1.roomId,
                client.matrixRTC.getActiveRoomSession(room1),
            ]);
        });

        it("Fires correctly with custom sessionDescription", async () => {
            const onStarted = vi.fn();
            const onEnded = vi.fn();
            // create a session manager with a custom session description
            const sessionManager = new MatrixRTCSessionManager(logger, client, {
                id: "test",
                application: "m.notCall",
            });

            // manually start the session manager (its not the default one started by the client)
            sessionManager.start();
            sessionManager.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
            sessionManager.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
            const sessionStartedPromise = new Promise((resolve) =>
                sessionManager.once(MatrixRTCSessionManagerEvents.SessionStarted, resolve),
            );
            const sessionEndedPromise = new Promise((resolve) =>
                sessionManager.once(MatrixRTCSessionManagerEvents.SessionEnded, (...params) => resolve(params)),
            );

            // Create a session for applicaation m.other, we ignore this session because it lacks a call_id
            const room1MembershipData: MembershipData[] = [generateMembership({ type: "m.other" })];
            const room1 = makeMockRoom(room1MembershipData, eventKind === "sticky");
            vi.spyOn(client, "getRooms").mockReturnValue([room1]);
            client.emit(ClientEvent.Room, room1);
            await flushPromises();
            expect(onStarted).not.toHaveBeenCalled();

            // Create a session for applicaation m.notCall. We expect this call to be tracked because it has matching call_id
            const room2MembershipData: MembershipData[] = [generateMembership({ type: "m.notCall", callId: "test" })];
            const room2 = makeMockRoom(room2MembershipData, eventKind === "sticky");
            vi.spyOn(client, "getRooms").mockReturnValue([room2]);
            client.emit(ClientEvent.Room, room2);
            await flushPromises();
            await sessionStartedPromise;

            // Stop room1's RTC session. Not tracked.
            vi.spyOn(client, "getRoom").mockReturnValue(room1);
            await sendLeaveMembership(room1, room1MembershipData);
            expect(onEnded).not.toHaveBeenCalled();

            // Stop room2's RTC session. Tracked.
            vi.spyOn(client, "getRoom").mockReturnValue(room2);
            await sendLeaveMembership(room2, room2MembershipData);
            await sessionEndedPromise;
        });

        it("Doesn't fire event if unrelated sessions ends", async () => {
            const onEnded = vi.fn();
            client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
            const membership: MembershipData[] = [generateMembership({ type: "m.other_app" })];
            const room1 = makeMockRoom(membership, eventKind === "sticky");
            vi.spyOn(client, "getRooms").mockReturnValue([room1]);
            vi.spyOn(client, "getRoom").mockReturnValue(room1);

            client.emit(ClientEvent.Room, room1);

            await sendLeaveMembership(room1, membership);

            expect(onEnded).not.toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
        });
    },
);
