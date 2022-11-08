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
import { MatrixClient, ClientEvent } from '../client';
import {
    GroupCall,
    GroupCallIntent,
    GroupCallType,
    IGroupCallDataChannelOptions,
} from "./groupCall";
import { Room } from "../models/room";
import { RoomState, RoomStateEvent } from "../models/room-state";
import { RoomMember } from "../models/room-member";
import { logger } from '../logger';
import { EventType } from "../@types/event";
import { SyncState } from '../sync';

export enum GroupCallEventHandlerEvent {
    Incoming = "GroupCall.incoming",
    Ended = "GroupCall.ended",
    Participants = "GroupCall.participants",
}

export type GroupCallEventHandlerEventHandlerMap = {
    [GroupCallEventHandlerEvent.Incoming]: (call: GroupCall) => void;
    [GroupCallEventHandlerEvent.Ended]: (call: GroupCall) => void;
    [GroupCallEventHandlerEvent.Participants]: (participants: RoomMember[], call: GroupCall) => void;
};

interface RoomDeferred {
    prom: Promise<void>;
    resolve?: () => void;
}

export class GroupCallEventHandler {
    public groupCalls = new Map<string, GroupCall>(); // roomId -> GroupCall

    // All rooms we know about and whether we've seen a 'Room' event
    // for them. The promise will be fulfilled once we've processed that
    // event which means we're "up to date" on what calls are in a room
    // and get
    private roomDeferreds = new Map<string, RoomDeferred>();

    constructor(private client: MatrixClient) { }

    public async start(): Promise<void> {
        // We wait until the client has started syncing for real.
        // This is because we only support one call at a time, and want
        // the latest. We therefore want the latest state of the room before
        // we create a group call for the room so we can be fairly sure that
        // the group call we create is really the latest one.
        if (this.client.getSyncState() !== SyncState.Syncing) {
            logger.debug("Waiting for client to start syncing...");
            await new Promise<void>(resolve => {
                const onSync = () => {
                    if (this.client.getSyncState() === SyncState.Syncing) {
                        this.client.off(ClientEvent.Sync, onSync);
                        return resolve();
                    }
                };
                this.client.on(ClientEvent.Sync, onSync);
            });
        }

        const rooms = this.client.getRooms();

        for (const room of rooms) {
            this.createGroupCallForRoom(room);
        }

        this.client.on(ClientEvent.Room, this.onRoomsChanged);
        this.client.on(RoomStateEvent.Events, this.onRoomStateChanged);
    }

    public stop(): void {
        this.client.removeListener(RoomStateEvent.Events, this.onRoomStateChanged);
    }

    private getRoomDeferred(roomId: string): RoomDeferred {
        let deferred = this.roomDeferreds.get(roomId);
        if (deferred === undefined) {
            let resolveFunc: () => void;
            deferred = {
                prom: new Promise<void>(resolve => {
                    resolveFunc = resolve;
                }),
            };
            deferred.resolve = resolveFunc!;
            this.roomDeferreds.set(roomId, deferred);
        }

        return deferred;
    }

    public waitUntilRoomReadyForGroupCalls(roomId: string): Promise<void> {
        return this.getRoomDeferred(roomId).prom;
    }

    public getGroupCallById(groupCallId: string): GroupCall | undefined {
        return [...this.groupCalls.values()].find((groupCall) => groupCall.groupCallId === groupCallId);
    }

    private createGroupCallForRoom(room: Room): void {
        const callEvents = room.currentState.getStateEvents(EventType.GroupCallPrefix);
        const sortedCallEvents = callEvents.sort((a, b) => b.getTs() - a.getTs());

        for (const callEvent of sortedCallEvents) {
            const content = callEvent.getContent();

            if (content["m.terminated"]) {
                continue;
            }

            logger.debug(
                `Choosing group call ${callEvent.getStateKey()} with TS ` +
                `${callEvent.getTs()} for room ${room.roomId} from ${callEvents.length} possible calls.`,
            );

            this.createGroupCallFromRoomStateEvent(callEvent);
            break;
        }

        logger.info("Group call event handler processed room", room.roomId);
        this.getRoomDeferred(room.roomId).resolve!();
    }

    private createGroupCallFromRoomStateEvent(event: MatrixEvent): GroupCall | undefined {
        const roomId = event.getRoomId();
        const content = event.getContent();

        const room = this.client.getRoom(roomId);

        if (!room) {
            logger.warn(`Couldn't find room ${roomId} for GroupCall`);
            return;
        }

        const groupCallId = event.getStateKey();

        const callType = content["m.type"];

        if (!Object.values(GroupCallType).includes(callType)) {
            logger.warn(`Received invalid group call type ${callType} for room ${roomId}.`);
            return;
        }

        const callIntent = content["m.intent"];

        if (!Object.values(GroupCallIntent).includes(callIntent)) {
            logger.warn(`Received invalid group call intent ${callType} for room ${roomId}.`);
            return;
        }

        const isPtt = Boolean(content["io.element.ptt"]);

        let dataChannelOptions: IGroupCallDataChannelOptions | undefined;

        if (content?.dataChannelsEnabled && content?.dataChannelOptions) {
            // Pull out just the dataChannelOptions we want to support.
            const { ordered, maxPacketLifeTime, maxRetransmits, protocol } = content.dataChannelOptions;
            dataChannelOptions = { ordered, maxPacketLifeTime, maxRetransmits, protocol };
        }

        const groupCall = new GroupCall(
            this.client,
            room,
            callType,
            isPtt,
            callIntent,
            groupCallId,
            content?.dataChannelsEnabled,
            dataChannelOptions,
        );

        this.groupCalls.set(room.roomId, groupCall);
        this.client.emit(GroupCallEventHandlerEvent.Incoming, groupCall);

        return groupCall;
    }

    private onRoomsChanged = (room: Room) => {
        this.createGroupCallForRoom(room);
    };

    private onRoomStateChanged = (event: MatrixEvent, state: RoomState): void => {
        const eventType = event.getType();

        if (eventType === EventType.GroupCallPrefix) {
            const groupCallId = event.getStateKey();
            const content = event.getContent();

            const currentGroupCall = this.groupCalls.get(state.roomId);

            if (!currentGroupCall && !content["m.terminated"]) {
                this.createGroupCallFromRoomStateEvent(event);
            } else if (currentGroupCall && currentGroupCall.groupCallId === groupCallId) {
                if (content["m.terminated"]) {
                    currentGroupCall.terminate(false);
                } else if (content["m.type"] !== currentGroupCall.type) {
                    // TODO: Handle the callType changing when the room state changes
                    logger.warn(`The group call type changed for room: ${
                        state.roomId}. Changing the group call type is currently unsupported.`);
                }
            } else if (currentGroupCall && currentGroupCall.groupCallId !== groupCallId) {
                // TODO: Handle new group calls and multiple group calls
                logger.warn(`Multiple group calls detected for room: ${
                    state.roomId}. Multiple group calls are currently unsupported.`);
            }
        } else if (eventType === EventType.GroupCallMemberPrefix) {
            const groupCall = this.groupCalls.get(state.roomId);

            if (!groupCall) {
                return;
            }

            groupCall.onMemberStateChanged(event);
        }
    };
}
