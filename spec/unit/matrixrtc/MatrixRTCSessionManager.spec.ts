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

import {
    ClientEvent,
    EventTimeline,
    MatrixClient,
    type Room,
    RoomStateEvent,
    RoomStickyEventsEvent,
    type StickyMatrixEvent,
} from "../../../src";
import { MatrixRTCSessionEvent, MatrixRTCSessionManager, MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc";
import {
    makeMockRoom,
    type MembershipData,
    sessionMembershipTemplate,
    mockRoomState,
    mockRTCEvent,
    mockSlotEvent,
    rtcMembershipTemplate,
} from "./mocks.ts";
import { logger } from "../../../src/logger";
import { flushPromises } from "../../test-utils/flushPromises";
import { type RtcMembershipData, type SessionMembershipData } from "../../../src/matrixrtc/membershipData";
import { type RtcSlotEventContent } from "../../../src/matrixrtc/types";
import { type Mock } from "vitest";

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

        /** A second membership in the same call, from another device. */
        function generateOtherDeviceMembership(): MembershipData {
            if (eventKind === "sticky") {
                return {
                    ...rtcMembershipTemplate,
                    member: { ...rtcMembershipTemplate.member, id: "OTHERID", device_id: "BBBBBBB" },
                    msc4354_sticky_key: "m.call#other",
                } satisfies RtcMembershipData & { user_id: string };
            }
            return { ...sessionMembershipTemplate, device_id: "BBBBBBB" } satisfies SessionMembershipData & {
                user_id: string;
            };
        }

        /**
         * Replaces the room's memberships with `liveMembershipData` and emits the event that makes the session recalculate.
         * @param liveMembershipData - the array the room was created with (`makeMockRoom`). In sticky mode the room
         *     reads its sticky events from this array, so it is updated in place.
         */
        async function setMemberships(
            room: Room,
            liveMembershipData: MembershipData[],
            newData: MembershipData[],
        ): Promise<void> {
            if (eventKind === "memberState") {
                mockRoomState(room, newData);
                const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
                const membEvent = roomState.getStateEvents("org.matrix.msc3401.call.member")[0];
                room.emit(RoomStateEvent.Events, membEvent, roomState, null);
            } else {
                liveMembershipData.splice(0, liveMembershipData.length, ...newData);
                room.emit(
                    RoomStickyEventsEvent.Update,
                    [mockRTCEvent(liveMembershipData[0], room.roomId, 10000) as StickyMatrixEvent],
                    [],
                    [],
                );
            }
            await flushPromises();
        }

        /** Makes the (single) member in the room leave the call. */
        async function sendLeaveMembership(room: Room, liveMembershipData: MembershipData[]): Promise<void> {
            await setMemberships(room, liveMembershipData, [{ user_id: sessionMembershipTemplate.user_id }]);
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

        describe("sessions whose memberships are already known at startup", () => {
            let manager: MatrixRTCSessionManager;
            let onStarted: Mock;
            let onEnded: Mock;

            beforeEach(() => {
                // A manager of our own, so we control when start() runs.
                manager = new MatrixRTCSessionManager(logger, client);
                onStarted = vi.fn();
                onEnded = vi.fn();
                manager.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
                manager.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
            });

            afterEach(() => {
                manager.stop();
            });

            it("Fires SessionStarted for a call already in the room state when start() runs", async () => {
                const room1 = makeMockRoom([generateMembership()], eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);

                manager.start();
                await manager.getRoomSession(room1).initialMembershipCalculated;
                await flushPromises();

                expect(onStarted).toHaveBeenCalledTimes(1);
                expect(onStarted).toHaveBeenCalledWith(room1.roomId, manager.getRoomSession(room1));
                expect(manager.getRoomSession(room1).memberships).toHaveLength(1);
            });

            it("Fires SessionStarted once for a session created by getRoomSession() before start()", async () => {
                const room1 = makeMockRoom([generateMembership()], eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);
                vi.spyOn(client, "getRoom").mockReturnValue(room1);

                // This is what Element Web's CallStore does as the cached sync adds rooms.
                const session = manager.getRoomSession(room1);
                expect(session.memberships).toHaveLength(0);
                manager.start();
                expect(manager.getRoomSession(room1)).toBe(session);
                await session.initialMembershipCalculated;
                await flushPromises();

                expect(onStarted).toHaveBeenCalledTimes(1);
                expect(onStarted).toHaveBeenCalledWith(room1.roomId, session);

                // Rooms being refreshed doesn't fire it again
                client.emit(ClientEvent.Room, room1);
                await flushPromises();
                expect(onStarted).toHaveBeenCalledTimes(1);
            });

            it("Fires SessionStarted once for a session created by getRoomSession() after start(), then SessionEnded", async () => {
                const membershipData: MembershipData[] = [generateMembership()];
                const room1 = makeMockRoom(membershipData, eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([]);
                vi.spyOn(client, "getRoom").mockReturnValue(room1);

                manager.start();
                const session = manager.getRoomSession(room1);
                await session.initialMembershipCalculated;
                await flushPromises();

                expect(onStarted).toHaveBeenCalledTimes(1);
                expect(onStarted).toHaveBeenCalledWith(room1.roomId, session);

                // Another device joins: not a new session
                await setMemberships(room1, membershipData, [generateMembership(), generateOtherDeviceMembership()]);
                await vi.waitFor(() => expect(session.memberships).toHaveLength(2));
                expect(onStarted).toHaveBeenCalledTimes(1);
                expect(onEnded).not.toHaveBeenCalled();

                // Everyone leaves
                await setMemberships(room1, membershipData, [
                    { user_id: sessionMembershipTemplate.user_id },
                    { user_id: sessionMembershipTemplate.user_id },
                ]);
                await vi.waitFor(() => expect(session.memberships).toHaveLength(0));
                expect(onEnded).toHaveBeenCalledTimes(1);
                expect(onEnded).toHaveBeenCalledWith(room1.roomId, session);
                expect(onStarted).toHaveBeenCalledTimes(1);
            });

            it("Fires SessionEnded and forgets the session when a room with a call is deleted", async () => {
                const membershipData: MembershipData[] = [generateMembership()];
                const room1 = makeMockRoom(membershipData, eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);

                manager.start();
                const session = manager.getRoomSession(room1);
                await session.initialMembershipCalculated;
                await flushPromises();
                expect(onStarted).toHaveBeenCalledTimes(1);

                const stopSpy = vi.spyOn(session, "stop");
                client.emit(ClientEvent.DeleteRoom, room1.roomId);
                expect(onEnded).toHaveBeenCalledTimes(1);
                expect(onEnded).toHaveBeenCalledWith(room1.roomId, session);
                expect(stopSpy).toHaveBeenCalled();
                expect(session.listenerCount(MatrixRTCSessionEvent.MembershipsChanged)).toBe(0);
                expect(manager.getActiveRoomSession(room1)).toBeUndefined();

                // The session no longer reaches the manager, so members leaving doesn't end it again
                await setMemberships(room1, membershipData, [{ user_id: sessionMembershipTemplate.user_id }]);
                expect(onEnded).toHaveBeenCalledTimes(1);

                // Asking for the room again gives a new session
                expect(manager.getRoomSession(room1)).not.toBe(session);
            });

            it("Doesn't fire SessionEnded when a room without a call is deleted", async () => {
                const room1 = makeMockRoom([], eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);

                manager.start();
                const session = manager.getRoomSession(room1);
                await session.initialMembershipCalculated;
                await flushPromises();

                client.emit(ClientEvent.DeleteRoom, room1.roomId);
                expect(onStarted).not.toHaveBeenCalled();
                expect(onEnded).not.toHaveBeenCalled();
                expect(manager.getActiveRoomSession(room1)).toBeUndefined();
            });

            it("Doesn't fire events after stop()", async () => {
                const room1 = makeMockRoom([generateMembership()], eventKind === "sticky");
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);

                manager.start();
                // Stop while the initial membership calculation is still in progress
                const session = manager.getRoomSession(room1);
                manager.stop();
                await session.initialMembershipCalculated;
                await flushPromises();

                expect(session.memberships).toHaveLength(1);
                expect(onStarted).not.toHaveBeenCalled();
                expect(onEnded).not.toHaveBeenCalled();
            });
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

describe("MatrixRTCSessionManager slots", () => {
    const defaultSlotDescription = { application: "m.call", id: "ROOM" };
    const openSlotContent: RtcSlotEventContent = { status: "open", application: { type: "m.call" } };
    const closedSlotContent: RtcSlotEventContent = { status: "closed" };

    let client: MatrixClient;

    beforeEach(() => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.matrixRTC.start();
    });

    afterEach(() => {
        client.stopClient();
        client.matrixRTC.stop();
        vi.resetAllMocks();
    });

    it("getRtcSlot/isSlotClosed delegate to the room's session", () => {
        const room = makeMockRoom([], false);
        const slotEvent = mockSlotEvent(defaultSlotDescription, openSlotContent, room.roomId);
        mockRoomState(room, [], slotEvent);

        expect(client.matrixRTC.getRtcSlot(room)).toEqual(openSlotContent);
        expect(client.matrixRTC.isSlotClosed(room)).toBe(false);
    });

    it("Fires session ended when an active sticky-only session's slot is closed", async () => {
        const membershipData: MembershipData[] = [rtcMembershipTemplate];
        const room1 = makeMockRoom(membershipData, true);
        vi.spyOn(client, "getRooms").mockReturnValue([room1]);
        vi.spyOn(client, "getRoom").mockReturnValue(room1);

        const sessionStartedPromise = new Promise((resolve) =>
            client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionStarted, resolve),
        );
        client.emit(ClientEvent.Room, room1);
        await sessionStartedPromise;

        const sessionEndedPromise = new Promise((resolve) =>
            client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionEnded, (...params) => resolve(params)),
        );

        const slotEvent = mockSlotEvent(defaultSlotDescription, closedSlotContent, room1.roomId);
        mockRoomState(room1, [], slotEvent);
        room1.emit(RoomStateEvent.Events, slotEvent, {} as any, null);

        await expect(sessionEndedPromise).resolves.toStrictEqual([
            room1.roomId,
            client.matrixRTC.getActiveRoomSession(room1),
        ]);
        expect(client.matrixRTC.getRtcSlot(room1)).toEqual(closedSlotContent);
        expect(client.matrixRTC.isSlotClosed(room1)).toBe(true);
    });

    it("Fires session started again when a closed slot is reopened", async () => {
        const membershipData: MembershipData[] = [rtcMembershipTemplate];
        const room1 = makeMockRoom(membershipData, true);
        vi.spyOn(client, "getRooms").mockReturnValue([room1]);
        vi.spyOn(client, "getRoom").mockReturnValue(room1);

        const sessionStartedPromise = new Promise((resolve) =>
            client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionStarted, resolve),
        );
        client.emit(ClientEvent.Room, room1);
        await sessionStartedPromise;

        // Close the slot.
        const sessionEndedPromise = new Promise((resolve) =>
            client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionEnded, resolve),
        );
        const closedSlotEvent = mockSlotEvent(defaultSlotDescription, closedSlotContent, room1.roomId);
        mockRoomState(room1, [], closedSlotEvent);
        room1.emit(RoomStateEvent.Events, closedSlotEvent, {} as any, null);
        await sessionEndedPromise;
        expect(client.matrixRTC.getRtcSlot(room1)).toEqual(closedSlotContent);
        expect(client.matrixRTC.isSlotClosed(room1)).toBe(true);

        // Reopen the slot.
        const reopenedSessionStartedPromise = new Promise((resolve) =>
            client.matrixRTC.once(MatrixRTCSessionManagerEvents.SessionStarted, (...params) => resolve(params)),
        );
        const openSlotEvent = mockSlotEvent(defaultSlotDescription, openSlotContent, room1.roomId);
        mockRoomState(room1, [], openSlotEvent);
        room1.emit(RoomStateEvent.Events, openSlotEvent, {} as any, null);

        await expect(reopenedSessionStartedPromise).resolves.toStrictEqual([
            room1.roomId,
            client.matrixRTC.getActiveRoomSession(room1),
        ]);
        expect(client.matrixRTC.getRtcSlot(room1)).toEqual(openSlotContent);
        expect(client.matrixRTC.isSlotClosed(room1)).toBe(false);
    });
});
