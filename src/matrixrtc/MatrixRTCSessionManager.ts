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

import { type Logger } from "../logger.ts";
import { type MatrixClient, ClientEvent } from "../client.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { type Room } from "../models/room.ts";
import { type RoomState, RoomStateEvent } from "../models/room-state.ts";
import { type MatrixEvent } from "../models/event.ts";
import { MatrixRTCSession } from "./MatrixRTCSession.ts";
import { EventType } from "../@types/event.ts";

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

    private readonly logger: Logger;

    public constructor(
        rootLogger: Logger,
        private client: MatrixClient,
    ) {
        super();
        this.logger = rootLogger.getChild("[MatrixRTCSessionManager]");
    }

    public start(): void {
        // We shouldn't need to null-check here, but matrix-client.spec.ts mocks getRooms
        // returning nothing, and breaks tests if you change it to return an empty array :'(
        for (const room of this.client.getRooms() ?? []) {
            const session = MatrixRTCSession.roomSessionForRoom(this.client, room);
            if (session.memberships.length > 0) {
                this.roomSessions.set(room.roomId, session);
            }
        }

        this.client.on(ClientEvent.Room, this.onRoom);
        this.client.on(RoomStateEvent.Events, this.onRoomState);
    }

    public stop(): void {
        for (const sess of this.roomSessions.values()) {
            void sess.stop();
        }
        this.roomSessions.clear();

        this.client.off(ClientEvent.Room, this.onRoom);
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
     * Gets the main MatrixRTC session for a room, returning an empty session
     * if no members are currently participating
     */
    public getRoomSession(room: Room): MatrixRTCSession {
        if (!this.roomSessions.has(room.roomId)) {
            this.roomSessions.set(room.roomId, MatrixRTCSession.roomSessionForRoom(this.client, room));
        }

        return this.roomSessions.get(room.roomId)!;
    }

    private onRoom = (room: Room): void => {
        this.refreshRoom(room);
    };

    private onRoomState = (event: MatrixEvent, _state: RoomState): void => {
        const room = this.client.getRoom(event.getRoomId());
        if (!room) {
            this.logger.error(`Got room state event for unknown room ${event.getRoomId()}!`);
            return;
        }

        if (event.getType() == EventType.GroupCallMemberPrefix) {
            this.refreshRoom(room);
        }
    };

    private refreshRoom(room: Room): void {
        const isNewSession = !this.roomSessions.has(room.roomId);
        const session = this.getRoomSession(room);

        const wasActiveAndKnown = session.memberships.length > 0 && !isNewSession;
        // This needs to be here and the event listener cannot be setup in the MatrixRTCSession,
        // because we need the update to happen between:
        // wasActiveAndKnown = session.memberships.length > 0 and
        // nowActive = session.memberships.length
        // Alternatively we would need to setup some event emission when the RTC session ended.
        session.onRTCSessionMemberUpdate();

        const nowActive = session.memberships.length > 0;

        if (wasActiveAndKnown && !nowActive) {
            this.logger.trace(`Session ended for ${room.roomId} (${session.memberships.length} members)`);
            this.emit(MatrixRTCSessionManagerEvents.SessionEnded, room.roomId, this.roomSessions.get(room.roomId)!);
        } else if (!wasActiveAndKnown && nowActive) {
            this.logger.trace(`Session started for ${room.roomId} (${session.memberships.length} members)`);
            this.emit(MatrixRTCSessionManagerEvents.SessionStarted, room.roomId, this.roomSessions.get(room.roomId)!);
        }
    }
}
