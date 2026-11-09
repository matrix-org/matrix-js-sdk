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
import { RoomStateEvent } from "../models/room-state.ts";
import { type MatrixEvent } from "../models/event.ts";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "./MatrixRTCSession.ts";
import { EventType } from "../@types/event.ts";
import { type RtcSlotEventContent, type SlotDescription } from "./types.ts";
import { computeSlotId } from "./utils.ts";

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

    // Rooms for which we have emitted SessionStarted (and not since emitted SessionEnded).
    private activeRoomIds = new Set<string>();

    // Our MembershipsChanged listener on each session in `roomSessions`, so that we can remove it again on stop.
    private sessionListeners = new Map<MatrixRTCSession, () => void>();

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
        // Sessions calculate their memberships asynchronously, so a session will only know whether it is active
        // once its initial calculation is done: we emit SessionStarted from the MembershipsChanged listener.
        for (const room of this.client.getRooms() ?? []) {
            this.getRoomSession(room);
        }

        this.client.on(ClientEvent.Room, this.onRoom);
    }

    public stop(): void {
        for (const sess of this.roomSessions.values()) {
            // Remove our listener first, so we don't emit anything for a calculation still in progress.
            const listener = this.sessionListeners.get(sess);
            if (listener) sess.off(MatrixRTCSessionEvent.MembershipsChanged, listener);
            void sess.stop();
        }
        this.roomSessions.clear();
        this.sessionListeners.clear();
        this.activeRoomIds.clear();

        this.client.off(ClientEvent.Room, this.onRoom);
        this.client.off(ClientEvent.Event, this.onEvent);
        this.client.off(RoomStateEvent.Events, this.onRoomState);
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
            // The session's initial membership calculation is still pending at this point. Listening
            // to MembershipsChanged means we will notice when it (or any later calculation) finds members.
            const listener = (): void => this.updateActiveState(room.roomId, session!);
            this.sessionListeners.set(session, listener);
            session.on(MatrixRTCSessionEvent.MembershipsChanged, listener);
        }

        return session;
    }

    private onRoom = (room: Room): void => {
        void this.refreshRoom(room);
    };

    };

        }
        const room = this.client.getRoom(event.getRoomId());
        if (!room) {
            this.logger.error(`Got room state event for unknown room ${event.getRoomId()}!`);
            return;
        }

        void this.refreshRoom(room);
    };

    private async refreshRoom(room: Room): Promise<void> {
        const session = this.getRoomSession(room);
        // Any resulting change to the session's activity is handled by our MembershipsChanged listener.
        await session.ensureRecalculateSessionMembers().catch((error) => {
            this.logger.error(`Error updating RTC session members for ${room.roomId}: ${error}`);
        });
    }

    /**
     * Emits SessionStarted or SessionEnded if the session's activity differs from what we last emitted for the room.
     */
    private updateActiveState(roomId: string, session: MatrixRTCSession): void {
        // Ignore sessions we no longer manage (e.g. a calculation that finished after stop()).
        if (this.roomSessions.get(roomId) !== session) return;

        const wasActive = this.activeRoomIds.has(roomId);
        const nowActive = session.memberships.length > 0;

        if (wasActive && !nowActive) {
            this.activeRoomIds.delete(roomId);
            this.logger.trace(`Session ended for ${roomId} (${session.memberships.length} members)`);
            this.emit(MatrixRTCSessionManagerEvents.SessionEnded, roomId, session);
        } else if (!wasActive && nowActive) {
            this.activeRoomIds.add(roomId);
            this.logger.trace(`Session started for ${roomId} (${session.memberships.length} members)`);
            this.emit(MatrixRTCSessionManagerEvents.SessionStarted, roomId, session);
        }
    }
}
