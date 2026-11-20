/*
Copyright 2023-2026 The Matrix.org Foundation C.I.C.

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

import { type Logger } from "../logger.ts";
import { type MatrixClient, ClientEvent } from "../client.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { type Room } from "../models/room.ts";
import { MatrixRTCSession, MatrixRTCSessionEvent, type MatrixRTCSessionEventHandlerMap } from "./MatrixRTCSession.ts";
import { type RtcSlotEventContent, type SlotDescription } from "./types.ts";
import { computeSlotId } from "./utils.ts";
import { type CallMembership } from "./CallMembership.ts";

export enum MatrixRTCSessionManagerEvents {
    // A member has joined the MatrixRTC session, creating an active session in a room where there wasn't previously
    SessionStarted = "session_started",
    // All participants have left a given MatrixRTC session.
    SessionEnded = "session_ended",
}

type EventHandlerMap = {
    [MatrixRTCSessionManagerEvents.SessionStarted]: (roomId: string, session: MatrixRTCSession) => void;
    [MatrixRTCSessionManagerEvents.SessionEnded]: (roomId: string, session: MatrixRTCSession) => void;
};

/**
 * Holds all active MatrixRTC session objects and creates new ones as events arrive.
 * One `MatrixRTCSessionManager` is required for each MatrixRTC sessionDescription (application, session id) that the client wants to support.
 * If no application type is specified in the constructor, the default is "m.call".
 *
 * This interface is UNSTABLE and may change without warning.
 */
export class MatrixRTCSessionManager extends TypedEventEmitter<MatrixRTCSessionManagerEvents, EventHandlerMap> {
    // All the room-scoped sessions we know about. This will include any where the app
    // has queried for the MatrixRTC sessions in a room, whether it's ever had any members
    // or not). We keep a (lazily created) session object for every room to ensure that there
    // is only ever one single room session object for any given room for the lifetime of the
    // client: that way there can never be any code holding onto a stale object that is no
    // longer the correct session object for the room.
    private roomSessions = new Map<string, MatrixRTCSession>();

    // Our MembershipsChanged listener on each session in `roomSessions`, so that we can remove it again.
    private sessionListeners = new Map<
        MatrixRTCSession,
        MatrixRTCSessionEventHandlerMap[MatrixRTCSessionEvent.MembershipsChanged]
    >();

    private readonly logger: Logger;

    public constructor(
        rootLogger: Logger,
        private client: MatrixClient,
        private readonly slotDescription: SlotDescription = { application: "m.call", id: "ROOM" }, // Default to the Matrix Call application
    ) {
        super();
        this.logger = rootLogger.getChild(`[MatrixRTCSessionManager ${computeSlotId(slotDescription)}]`);
    }

    public start(): void {
        // We shouldn't need to null-check here, but matrix-client.spec.ts mocks getRooms
        // returning nothing, and breaks tests if you change it to return an empty array :'(
        for (const room of this.client.getRooms() ?? []) {
            this.getRoomSession(room);
        }

        this.client.on(ClientEvent.Room, this.onRoom);
        this.client.on(ClientEvent.DeleteRoom, this.onDeleteRoom);
    }

    public stop(): void {
        for (const roomId of this.roomSessions.keys()) {
            this.removeRoomSession(roomId);
        }

        this.client.off(ClientEvent.Room, this.onRoom);
        this.client.off(ClientEvent.DeleteRoom, this.onDeleteRoom);
    }

    /**
     * Gets the main MatrixRTC session for a room, or undefined if there is
     * no current session
     */
    public getActiveRoomSession(room: Room): MatrixRTCSession | undefined {
        return this.roomSessions.get(room.roomId)!;
    }

    /**
     * Reads the current slot state event's content for the given room's session.
     *
     * @returns The slot event's content, or `undefined` if no slot event exists for the session.
     */
    public getRtcSlot(room: Room): RtcSlotEventContent | undefined {
        return this.getRoomSession(room).getRtcSlot();
    }

    /**
     * Whether the given room's slot is closed.
     *
     * @returns `true` if the slot is closed, `false` if the slot is open or `undefined`
     * if no slot exists.
     */
    public isSlotClosed(room: Room): boolean | undefined {
        return this.getRoomSession(room).isSlotClosed();
    }

    /**
     * Gets the main MatrixRTC session for a room, returning an empty session
     * if no members are currently participating
     */
    public getRoomSession(room: Room): MatrixRTCSession {
        let session = this.roomSessions.get(room.roomId);
        if (!session) {
            session = MatrixRTCSession.sessionForSlot(this.client, room, this.slotDescription);
            this.roomSessions.set(room.roomId, session);
            // A session starts with no memberships and keeps them up to date itself (its first calculation is
            // still pending at this point), so every 0 <-> N change in its memberships reaches this listener.
            const listener = this.onMembershipsChanged.bind(this, room.roomId, session);
            this.sessionListeners.set(session, listener);
            session.on(MatrixRTCSessionEvent.MembershipsChanged, listener);
        }

        return session;
    }

    private readonly onRoom = (room: Room): void => {
        this.getRoomSession(room);
    };

    private readonly onDeleteRoom = (roomId: string): void => {
        const session = this.roomSessions.get(roomId);
        if (!session) return;
        this.removeRoomSession(roomId);
        // We emit SessionStarted exactly when a session's memberships go from empty to non-empty,
        // so a session with members is one we have reported as started: tell consumers it's over.
        if (session.memberships.length > 0) {
            this.logger.trace(`Session ended for ${roomId} (room deleted)`);
            this.emit(MatrixRTCSessionManagerEvents.SessionEnded, roomId, session);
        }
    };

    private removeRoomSession(roomId: string): void {
        const session = this.roomSessions.get(roomId);
        if (!session) return;
        // Remove our listener first, so we don't emit anything for a calculation still in progress.
        const listener = this.sessionListeners.get(session);
        if (listener) session.off(MatrixRTCSessionEvent.MembershipsChanged, listener);
        this.sessionListeners.delete(session);
        this.roomSessions.delete(roomId);
        void session.stop();
    }

    private onMembershipsChanged(
        roomId: string,
        session: MatrixRTCSession,
        oldMemberships: CallMembership[],
        newMemberships: CallMembership[],
    ): void {
        if (oldMemberships.length > 0 && newMemberships.length === 0) {
            this.logger.trace(`Session ended for ${roomId}`);
            this.emit(MatrixRTCSessionManagerEvents.SessionEnded, roomId, session);
        } else if (oldMemberships.length === 0 && newMemberships.length > 0) {
            this.logger.trace(`Session started for ${roomId} (${newMemberships.length} members)`);
            this.emit(MatrixRTCSessionManagerEvents.SessionStarted, roomId, session);
        }
    }
}
