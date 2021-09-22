/*
Copyright 2021 Šimon Brandner <simon.bra.ag@gmail.com>

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

import { MatrixEvent } from '../models/event';
import { MatrixClient } from '../client';
import { CONF_ROOM, GroupCall } from "./groupCall";
import { RoomState } from "../models/room-state";
import { CallType } from "./call";

export class GroupCallEventHandler {
    private groupCalls = new Map<string, GroupCall>(); // roomId -> GroupCall

    constructor(private client: MatrixClient) { }

    public start(): void {
        this.client.on("RoomState.events", this.onRoomStateChanged);
    }

    public stop(): void {
        this.client.removeListener("RoomState.events", this.onRoomStateChanged);
    }

    private onRoomStateChanged = (_event: MatrixEvent, state: RoomState): void => {
        const groupCall = this.groupCalls.get(state.roomId);
        const confEvents = state.getStateEvents(CONF_ROOM);
        let content;
        if (confEvents.length > 0) {
            content = confEvents[0].getContent();
        }

        if (groupCall && !content?.active) {
            groupCall.leave();
            this.groupCalls.delete(state.roomId);
        } else if (!groupCall && content?.active) {
            let callType: CallType;

            if (content.callType === "voice") {
                callType = CallType.Voice;
            } else {
                callType = CallType.Video;
            }

            const groupCall = this.client.createGroupCall(state.roomId, callType);
            this.groupCalls.set(state.roomId, groupCall);
            this.client.emit("GroupCall.incoming", groupCall);
        }
    };
}
