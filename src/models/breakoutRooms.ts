/*
Copyright 2023 Šimon Brandner <simon.bra.ag@gmail.com>

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

import { BreakoutEventContent, BreakoutRoomWithSummary } from "../@types/breakout";
import { EventType } from "../@types/event";
import { logger } from "../logger";
import { deepCompare } from "../utils";
import { MatrixEvent } from "./event";
import { Direction } from "./event-timeline";
import { Room, RoomEvent } from "./room";
import { TypedEventEmitter } from "./typed-event-emitter";

export enum BreakoutRoomsEvent {
    RoomsChanged = "rooms_changed",
}

export type BreakoutRoomsEventHandlerMap = {
    [BreakoutRoomsEvent.RoomsChanged]: (room: BreakoutRoomWithSummary[]) => void;
};

export class BreakoutRooms extends TypedEventEmitter<BreakoutRoomsEvent, BreakoutRoomsEventHandlerMap> {
    private currentBreakoutRooms?: BreakoutRoomWithSummary[];

    public constructor(private room: Room) {
        super();

        room.addListener(RoomEvent.Timeline, this.onEvent);

        const breakoutEvent = this.getBreakoutEvent();
        if (!breakoutEvent) return;
        this.parseBreakoutEvent(breakoutEvent).then((rooms) => {
            this.currentBreakoutRooms = rooms;
        });
    }

    public getCurrentBreakoutRooms(): BreakoutRoomWithSummary[] | null {
        return this.currentBreakoutRooms ? [...this.currentBreakoutRooms] : null;
    }

    private getBreakoutEvent(): MatrixEvent | null {
        const state = this.room.getLiveTimeline().getState(Direction.Forward);
        if (!state) return null;

        return state.getStateEvents(EventType.Breakout, "") ?? state?.getStateEvents(EventType.PrefixedBreakout, "");
    }

    private async parseBreakoutEvent(event: MatrixEvent): Promise<BreakoutRoomWithSummary[]> {
        const content = event.getContent() as BreakoutEventContent;
        if (!content["m.breakout"]) throw new Error("m.breakout is null or undefined");
        if (Array.isArray(content["m.breakout"])) throw new Error("m.breakout is an array");

        const breakoutRooms: BreakoutRoomWithSummary[] = [];
        for (const [roomId, room] of Object.entries(content["m.breakout"])) {
            if (!Array.isArray(room.users)) throw new Error("users is not an array");

            try {
                const summary = await this.room.client.getRoomSummary(roomId, room.via);

                breakoutRooms.push({ roomId, roomSummary: summary, users: room.users });
            } catch (error) {
                logger.error("Failed...", error);
            }
        }
        return breakoutRooms;
    }

    private onEvent = async (event: MatrixEvent): Promise<void> => {
        const type = event.getType() as EventType;
        if (![EventType.PrefixedBreakout, EventType.Breakout].includes(type)) return;

        const breakoutEvent = this.getBreakoutEvent();
        if (!breakoutEvent) return;
        const rooms = await this.parseBreakoutEvent(breakoutEvent);

        if (!deepCompare(rooms, this.currentBreakoutRooms)) {
            this.currentBreakoutRooms = rooms;
            this.emit(BreakoutRoomsEvent.RoomsChanged, this.currentBreakoutRooms);
        }
    };
}
