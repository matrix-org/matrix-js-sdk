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
    // Room-scoped sessions that have active members
    private activeRoomSessions = new Map<string, MatrixRTCSession>();

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
     * Get a list of all ongoing MatrixRTC sessions the client knows about
     * (whether the client is joined to them or not)
     */
    public getAllSessions(): MatrixRTCSession[] {
        const sessions: MatrixRTCSession[] = [];

        for (const room of this.client.getRooms()) {
            const session = this.getRoomSession(room);
            if (session) sessions.push(session);
        }

        return sessions;
    }

    /**
     * Gets the main MatrixRTC session for a room, or undefined if there is
     * no current session
     */
    public getActiveRoomSession(room: Room): MatrixRTCSession | undefined {
        return MatrixRTCSession.activeRoomSessionForRoom(this.client, room);
    }

    /**
     * Gets the main MatrixRTC session for a room, returning an empty session
     * if no members are currently participating
     */
    public getRoomSession(room: Room): MatrixRTCSession {
        return MatrixRTCSession.roomSessionForRoom(this.client, room);
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
        const sess = this.getActiveRoomSession(room);
        if (sess == undefined && this.activeRoomSessions.has(room.roomId)) {
            this.emit(
                MatrixRTCSessionManagerEvents.SessionEnded,
                room.roomId,
                this.activeRoomSessions.get(room.roomId)!,
            );
            this.activeRoomSessions.delete(room.roomId);
        } else if (sess !== undefined && !this.activeRoomSessions.has(room.roomId)) {
            this.activeRoomSessions.set(room.roomId, sess);
            this.emit(
                MatrixRTCSessionManagerEvents.SessionStarted,
                room.roomId,
                this.activeRoomSessions.get(room.roomId)!,
            );
        } else if (sess) {
            sess.onMembershipUpdate();
        }
    }
}
