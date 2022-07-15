/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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
    WidgetApi,
    WidgetApiToWidgetAction,
    ISendEventToWidgetActionRequest,
    ISendToDeviceToWidgetActionRequest,
} from "matrix-widget-api";

import { ISendEventResponse } from "./@types/requests";
import { logger } from "./logger";
import { MatrixClient, ClientEvent, IMatrixClientCreateOpts, IStartClientOpts } from "./client";
import { MatrixEvent } from "./models/event";
import { Room } from "./models/room";

interface IStateEventRequest {
    eventType: string;
    stateKey?: string;
}

export interface IEventRequests {
    // TODO: Add fields for requesting event types and message types

    sendState?: IStateEventRequest[];
    receiveState?: IStateEventRequest[];

    sendToDevice?: string[];
    receiveToDevice?: string[];
}

export class RoomWidgetClient extends MatrixClient {
    private room: Room;
    private widgetApiReady = new Promise<void>(resolve => this.widgetApi.once("ready", resolve));

    constructor(
        private readonly widgetApi: WidgetApi,
        private readonly eventRequests: IEventRequests,
        private readonly roomId: string,
        opts: IMatrixClientCreateOpts,
    ) {
        super(opts);

        // Request capabilities for the events we want to send/receive
        this.eventRequests.sendState?.forEach(({ eventType, stateKey }) =>
            this.widgetApi.requestCapabilityToSendState(eventType, stateKey),
        );
        this.eventRequests.receiveState?.forEach(({ eventType, stateKey }) =>
            this.widgetApi.requestCapabilityToReceiveState(eventType, stateKey),
        );
        this.eventRequests.sendToDevice?.forEach(eventType =>
            this.widgetApi.requestCapabilityToSendToDevice(eventType),
        );
        this.eventRequests.receiveToDevice?.forEach(eventType =>
            this.widgetApi.requestCapabilityToReceiveToDevice(eventType),
        );

        this.widgetApi.on(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        this.widgetApi.on(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);

        // Open communication with the host
        this.widgetApi.start();
    }

    public async startClient(opts?: IStartClientOpts): Promise<void> {
        await super.startClient(opts);

        this.room = this.syncApi.createRoom(this.roomId);
        this.store.storeRoom(this.room);

        await this.widgetApiReady;

        // Backfill the requested events
        // We only get the most recent event for every type + state key combo,
        // so it doesn't really matter what order we inject them in
        await Promise.all(
            this.eventRequests.receiveState?.map(async ({ eventType, stateKey }) => {
                const rawEvents = await this.widgetApi.readStateEvents(eventType, undefined, stateKey);
                const events = rawEvents.map(rawEvent => new MatrixEvent(rawEvent));

                await this.syncApi.injectRoomEvents(this.room, [], events);
                events.forEach(event => {
                    this.emit(ClientEvent.Event, event);
                    logger.info(`Backfilled event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
                });
            }) ?? [],
        );
        logger.info("Finished backfilling events");
    }

    public stopClient() {
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);

        super.stopClient();
    }

    public async sendStateEvent(
        roomId: string,
        eventType: string,
        content: any,
        stateKey = "",
    ): Promise<ISendEventResponse> {
        return await this.widgetApi.sendStateEvent(eventType, stateKey, content, roomId);
    }

    public async sendToDevice(
        eventType: string,
        contentMap: { [userId: string]: { [deviceId: string]: Record<string, any> } },
    ): Promise<{}> {
        await this.widgetApi.sendToDevice(eventType, contentMap);
        return {};
    }

    private onEvent = async (ev: CustomEvent<ISendEventToWidgetActionRequest>) => {
        const event = new MatrixEvent(ev.detail.data);
        await this.syncApi.injectRoomEvents(this.room, [], [event]);
        this.emit(ClientEvent.Event, event);
        logger.info(`Received event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
    };

    private onToDevice = (ev: CustomEvent<ISendToDeviceToWidgetActionRequest>) =>
        this.emit(ClientEvent.ToDeviceEvent, new MatrixEvent(ev.detail.data));
}
