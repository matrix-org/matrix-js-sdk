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

import { logger } from "../logger";
import { ClientEvent, MatrixClient, MatrixEvent, Room, RoomState, RoomStateEvent } from "../matrix";
import { TypedEventEmitter } from "../models/typed-event-emitter";
import { MatrixRTCSession } from "./MatrixRTCSession";

enum MatrixRTCSessionManagerEvents {
    // A member has joined the MatrixRTC session, creating an active session in a room where there wasn't previously
    SessionStarted = "session_started",
    // All participants have left a given MatrixRTC session.
    SessionEnded = "session_ended",
}

type EventHandlerMap = {
    [MatrixRTCSessionManagerEvents.SessionStarted]: (roomId: string, session: MatrixRTCSession) => void;
    [MatrixRTCSessionManagerEvents.SessionEnded]: (roomId: string, session: MatrixRTCSession) => void;
};

export class MatrixRTCSessionManager extends TypedEventEmitter<MatrixRTCSessionManagerEvents, EventHandlerMap> {
    // All the room-scoped sessions we know about. This will include any where the app
    // has queried for the MatrixRTC sessions in a room, whether it's ever had any members
    // or not)
    private roomSessions = new Map<string, MatrixRTCSession>();

    public constructor(private client: MatrixClient) {
        super();
    }

    public start(): void {
        this.client.on(ClientEvent.Room, this.onRoom);
        this.client.on(RoomStateEvent.Events, this.onRoomState);
    }

    public stop(): void {
        this.client.removeListener(ClientEvent.Room, this.onRoom);
        this.client.removeListener(RoomStateEvent.Events, this.onRoomState);
    }

    /**
     * Get a list of all ongoing MatrixRTC sessions that have 1 or more active
     * members
     * (whether the client is joined to them or not)
     */
    public getActiveSessions(): MatrixRTCSession[] {
        return Array.from(this.roomSessions.values()).filter((m) => m.memberships.length > 0);
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
            logger.error(`Got room state event for unknown room ${event.getRoomId()}!`);
            return;
        }

        this.refreshRoom(room);
    };

    private refreshRoom(room: Room): void {
        const sess = this.getRoomSession(room);

        const wasActive = sess.memberships.length > 0;

        sess.onMembershipUpdate();

        const nowActive = sess.memberships.length > 0;

        if (wasActive && !nowActive) {
            this.emit(MatrixRTCSessionManagerEvents.SessionEnded, room.roomId, this.roomSessions.get(room.roomId)!);
        } else if (!wasActive && nowActive) {
            this.emit(MatrixRTCSessionManagerEvents.SessionStarted, room.roomId, this.roomSessions.get(room.roomId)!);
        }
    }
}
