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
import { CONF_ROOM, GroupCall, IGroupCallDataChannelOptions } from "./groupCall";
import { RoomState } from "../models/room-state";
import { CallType } from "./call";
import { logger } from '../logger';

export class GroupCallEventHandler {
    public groupCalls = new Map<string, GroupCall>(); // roomId -> GroupCall

    constructor(private client: MatrixClient) { }

    public start(): void {
        this.client.on("RoomState.events", this.onRoomStateChanged);
    }

    public stop(): void {
        this.client.removeListener("RoomState.events", this.onRoomStateChanged);
    }

    public createGroupCallFromRoomStateEvent(event: MatrixEvent) {
        const roomId = event.getRoomId();
        const content = event.getContent();

        let callType: CallType;

        if (content.callType === "voice") {
            callType = CallType.Voice;
        } else {
            callType = CallType.Video;
        }

        const room = this.client.getRoom(event.getRoomId());

        if (!room) {
            logger.error(`Couldn't find room ${roomId} for GroupCall`);
            return;
        }

        let dataChannelOptions: IGroupCallDataChannelOptions | undefined;

        if (content?.dataChannelsEnabled && content?.dataChannelOptions) {
            // Pull out just the dataChannelOptions we want to support.
            const { ordered, maxPacketLifeTime, maxRetransmits, protocol } = content.dataChannelOptions;
            dataChannelOptions = { ordered, maxPacketLifeTime, maxRetransmits, protocol };
        }

        return new GroupCall(
            this.client,
            room,
            callType,
            content?.dataChannelsEnabled,
            dataChannelOptions,
        );
    }

    private onRoomStateChanged = (_event: MatrixEvent, state: RoomState): void => {
        const groupCall = this.groupCalls.get(state.roomId);
        const confEvents = state.getStateEvents(CONF_ROOM);
        const confEvent = confEvents.length > 0 ? confEvents[0] : null;
        const content = confEvent ? confEvent.getContent() : null;

        if (groupCall && content?.type !== groupCall.type) {
            // TODO: Handle the callType changing when the room state changes
            logger.warn(`The group call type changed for room: ${
                state.roomId}. Changing the group call type is currently unsupported.`);
        } if (groupCall && !content?.active) {
            groupCall.endCall(false);
        } else if (!groupCall && content?.active) {
            const groupCall = this.createGroupCallFromRoomStateEvent(confEvent);
            this.groupCalls.set(state.roomId, groupCall);
            this.client.emit("GroupCall.incoming", groupCall);
        }
    };
}
