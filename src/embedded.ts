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
    MatrixCapabilities,
    IWidgetApiRequest,
    IWidgetApiAcknowledgeResponseData,
    ISendEventToWidgetActionRequest,
    ISendToDeviceToWidgetActionRequest,
} from "matrix-widget-api";

import { ISendEventResponse } from "./@types/requests";
import { logger } from "./logger";
import { MatrixClient, ClientEvent, IMatrixClientCreateOpts, IStartClientOpts } from "./client";
import { SyncApi, SyncState } from "./sync";
import { SlidingSyncSdk } from "./sliding-sync-sdk";
import { MatrixEvent } from "./models/event";
import { User } from "./models/user";
import { Room } from "./models/room";
import { DeviceInfo } from "./crypto/deviceinfo";
import { IOlmDevice } from "./crypto/algorithms/megolm";

interface IStateEventRequest {
    eventType: string;
    stateKey?: string;
}

export interface ICapabilities {
    // TODO: Add fields for messages and other non-state events

    sendState?: IStateEventRequest[];
    receiveState?: IStateEventRequest[];

    sendToDevice?: string[];
    receiveToDevice?: string[];

    turnServers?: boolean;
}

export class RoomWidgetClient extends MatrixClient {
    private room: Room;
    private widgetApiReady = new Promise<void>(resolve => this.widgetApi.once("ready", resolve));
    private lifecycle: AbortController;
    private syncState: SyncState | null = null;

    constructor(
        private readonly widgetApi: WidgetApi,
        private readonly capabilities: ICapabilities,
        private readonly roomId: string,
        opts: IMatrixClientCreateOpts,
    ) {
        super(opts);

        // Request capabilities for the functionality this client needs to support
        this.capabilities.sendState?.forEach(({ eventType, stateKey }) =>
            this.widgetApi.requestCapabilityToSendState(eventType, stateKey),
        );
        this.capabilities.receiveState?.forEach(({ eventType, stateKey }) =>
            this.widgetApi.requestCapabilityToReceiveState(eventType, stateKey),
        );
        this.capabilities.sendToDevice?.forEach(eventType =>
            this.widgetApi.requestCapabilityToSendToDevice(eventType),
        );
        this.capabilities.receiveToDevice?.forEach(eventType =>
            this.widgetApi.requestCapabilityToReceiveToDevice(eventType),
        );
        if (this.capabilities.turnServers) {
            this.widgetApi.requestCapability(MatrixCapabilities.MSC3846TurnServers);
        }

        this.widgetApi.on(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        this.widgetApi.on(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);

        // Open communication with the host
        this.widgetApi.start();
    }

    public async startClient(opts: IStartClientOpts = {}): Promise<void> {
        this.lifecycle = new AbortController();

        // Create our own user object artificially (instead of waiting for sync)
        // so it's always available, even if the user is not in any rooms etc.
        const userId = this.getUserId();
        if (userId) {
            this.store.storeUser(new User(userId));
        }

        // Even though we have no access token and cannot sync, the sync class
        // still has some valuable helper methods that we make use of, so we
        // instantiate it anyways
        if (opts.slidingSync) {
            this.syncApi = new SlidingSyncSdk(opts.slidingSync, this, opts);
        } else {
            this.syncApi = new SyncApi(this, opts);
        }

        this.room = this.syncApi.createRoom(this.roomId);
        this.store.storeRoom(this.room);

        await this.widgetApiReady;

        // Backfill the requested events
        // We only get the most recent event for every type + state key combo,
        // so it doesn't really matter what order we inject them in
        await Promise.all(
            this.capabilities.receiveState?.map(async ({ eventType, stateKey }) => {
                const rawEvents = await this.widgetApi.readStateEvents(eventType, undefined, stateKey);
                const events = rawEvents.map(rawEvent => new MatrixEvent(rawEvent));

                await this.syncApi.injectRoomEvents(this.room, [], events);
                events.forEach(event => {
                    this.emit(ClientEvent.Event, event);
                    logger.info(`Backfilled event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
                });
            }) ?? [],
        );
        this.setSyncState(SyncState.Prepared);
        logger.info("Finished backfilling events");

        // Watch for TURN servers, if requested
        if (this.capabilities.turnServers) this.watchTurnServers();
    }

    public stopClient() {
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);

        super.stopClient();
        this.lifecycle.abort(); // Signal to other async tasks that the client has stopped
    }

    public async sendStateEvent(
        roomId: string,
        eventType: string,
        content: any,
        stateKey = "",
    ): Promise<ISendEventResponse> {
        if (roomId !== this.roomId) throw new Error(`Can't send events to ${roomId}`);
        return await this.widgetApi.sendStateEvent(eventType, stateKey, content);
    }

    public async sendToDevice(
        eventType: string,
        contentMap: { [userId: string]: { [deviceId: string]: Record<string, any> } },
    ): Promise<{}> {
        await this.widgetApi.sendToDevice(eventType, false, contentMap);
        return {};
    }

    public async encryptAndSendToDevices(
        userDeviceInfoArr: IOlmDevice<DeviceInfo>[],
        payload: object,
    ): Promise<void> {
        const contentMap: { [userId: string]: { [deviceId: string]: object } } = {};
        for (const { userId, deviceInfo: { deviceId } } of userDeviceInfoArr) {
            if (!contentMap[userId]) contentMap[userId] = {};
            contentMap[userId][deviceId] = payload;
        }

        await this.widgetApi.sendToDevice((payload as { type: string }).type, true, contentMap);
    }

    // Overridden since we get TURN servers automatically over the widget API,
    // and this method would otherwise complain about missing an access token
    public async checkTurnServers(): Promise<boolean> {
        return this.turnServers.length > 0;
    }

    // Overridden since we 'sync' manually without the sync API
    public getSyncState(): SyncState {
        return this.syncState;
    }

    private setSyncState(state: SyncState) {
        const oldState = this.syncState;
        this.syncState = state;
        this.emit(ClientEvent.Sync, state, oldState);
    }

    private async ack(ev: CustomEvent<IWidgetApiRequest>): Promise<void> {
        await this.widgetApi.transport.reply<IWidgetApiAcknowledgeResponseData>(ev.detail, {});
    }

    private onEvent = async (ev: CustomEvent<ISendEventToWidgetActionRequest>) => {
        ev.preventDefault();
        const event = new MatrixEvent(ev.detail.data);
        await this.syncApi.injectRoomEvents(this.room, [], [event]);
        this.emit(ClientEvent.Event, event);
        this.setSyncState(SyncState.Syncing);
        logger.info(`Received event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
        await this.ack(ev);
    };

    private onToDevice = async (ev: CustomEvent<ISendToDeviceToWidgetActionRequest>) => {
        ev.preventDefault();
        // TODO: Mark the event as encrypted if it was!
        this.emit(ClientEvent.ToDeviceEvent, new MatrixEvent(ev.detail.data));
        this.setSyncState(SyncState.Syncing);
        await this.ack(ev);
    };

    private async watchTurnServers() {
        const servers = this.widgetApi.getTurnServers();
        const onClientStopped = () => servers.return(undefined);
        this.lifecycle.signal.addEventListener("abort", onClientStopped);

        try {
            for await (const server of servers) {
                this.turnServers = [{
                    urls: server.uris,
                    username: server.username,
                    credential: server.password,
                }];
                this.emit(ClientEvent.TurnServers, this.turnServers);
                logger.log(`Received TURN server: ${server.uris}`);
            }
        } catch (e) {
            logger.warn("Error watching TURN servers", e);
        } finally {
            this.lifecycle.signal.removeEventListener("abort", onClientStopped);
        }
    }
}
