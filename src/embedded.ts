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
    ISendEventFromWidgetResponseData,
} from "matrix-widget-api";

import { MatrixEvent, IEvent, IContent, EventStatus } from "./models/event";
import {
    ISendEventResponse,
    SendDelayedEventRequestOpts,
    SendDelayedEventResponse,
    UpdateDelayedEventAction,
} from "./@types/requests";
import { EventType, StateEvents } from "./@types/event";
import { logger } from "./logger";
import {
    MatrixClient,
    ClientEvent,
    IMatrixClientCreateOpts,
    IStartClientOpts,
    SendToDeviceContentMap,
    IOpenIDToken,
    UNSTABLE_MSC4140_DELAYED_EVENTS,
} from "./client";
import { SyncApi, SyncState } from "./sync";
import { SlidingSyncSdk } from "./sliding-sync-sdk";
import { User } from "./models/user";
import { Room } from "./models/room";
import { ToDeviceBatch, ToDevicePayload } from "./models/ToDeviceMessage";
import { DeviceInfo } from "./crypto/deviceinfo";
import { IOlmDevice } from "./crypto/algorithms/megolm";
import { MapWithDefault, recursiveMapToObject } from "./utils";

interface IStateEventRequest {
    eventType: string;
    stateKey?: string;
}

export interface ICapabilities {
    /**
     * Event types that this client expects to send.
     */
    sendEvent?: string[];
    /**
     * Event types that this client expects to receive.
     */
    receiveEvent?: string[];

    /**
     * Message types that this client expects to send, or true for all message
     * types.
     */
    sendMessage?: string[] | true;
    /**
     * Message types that this client expects to receive, or true for all
     * message types.
     */
    receiveMessage?: string[] | true;

    /**
     * Types of state events that this client expects to send.
     */
    sendState?: IStateEventRequest[];
    /**
     * Types of state events that this client expects to receive.
     */
    receiveState?: IStateEventRequest[];

    /**
     * To-device event types that this client expects to send.
     */
    sendToDevice?: string[];
    /**
     * To-device event types that this client expects to receive.
     */
    receiveToDevice?: string[];

    /**
     * Whether this client needs access to TURN servers.
     * @defaultValue false
     */
    turnServers?: boolean;

    /**
     * Whether this client needs to be able to send delayed events.
     * @experimental Part of MSC4140 & MSC4157
     * @defaultValue false
     */
    sendDelayedEvents?: boolean;

    /**
     * Whether this client needs to be able to update delayed events.
     * @experimental Part of MSC4140 & MSC4157
     * @defaultValue false
     */
    updateDelayedEvents?: boolean;
}

/**
 * A MatrixClient that routes its requests through the widget API instead of the
 * real CS API.
 * @experimental This class is considered unstable!
 */
export class RoomWidgetClient extends MatrixClient {
    private room?: Room;
    private readonly widgetApiReady: Promise<void>;
    private lifecycle?: AbortController;
    private syncState: SyncState | null = null;

    /**
     *
     * @param widgetApi - The widget api to use for communication.
     * @param capabilities - The capabilities the widget client will request.
     * @param roomId - The room id the widget is associated with.
     * @param opts - The configuration options for this client.
     * @param sendContentLoaded - Whether to send a content loaded widget action immediately after initial setup.
     *   Set to `false` if the widget uses `waitForIFrameLoad=true` (in this case the client does not expect a content loaded action at all),
     *   or if the the widget wants to send the `ContentLoaded` action at a later point in time after the initial setup.
     */
    public constructor(
        private readonly widgetApi: WidgetApi,
        private readonly capabilities: ICapabilities,
        private readonly roomId: string,
        opts: IMatrixClientCreateOpts,
        sendContentLoaded: boolean,
    ) {
        super(opts);

        this.widgetApiReady = new Promise<void>((resolve) => this.widgetApi.once("ready", resolve));

        // Request capabilities for the functionality this client needs to support
        if (
            capabilities.sendEvent?.length ||
            capabilities.receiveEvent?.length ||
            capabilities.sendMessage === true ||
            (Array.isArray(capabilities.sendMessage) && capabilities.sendMessage.length) ||
            capabilities.receiveMessage === true ||
            (Array.isArray(capabilities.receiveMessage) && capabilities.receiveMessage.length) ||
            capabilities.sendState?.length ||
            capabilities.receiveState?.length
        ) {
            widgetApi.requestCapabilityForRoomTimeline(roomId);
        }
        capabilities.sendEvent?.forEach((eventType) => widgetApi.requestCapabilityToSendEvent(eventType));
        capabilities.receiveEvent?.forEach((eventType) => widgetApi.requestCapabilityToReceiveEvent(eventType));
        if (capabilities.sendMessage === true) {
            widgetApi.requestCapabilityToSendMessage();
        } else if (Array.isArray(capabilities.sendMessage)) {
            capabilities.sendMessage.forEach((msgType) => widgetApi.requestCapabilityToSendMessage(msgType));
        }
        if (capabilities.receiveMessage === true) {
            widgetApi.requestCapabilityToReceiveMessage();
        } else if (Array.isArray(capabilities.receiveMessage)) {
            capabilities.receiveMessage.forEach((msgType) => widgetApi.requestCapabilityToReceiveMessage(msgType));
        }
        capabilities.sendState?.forEach(({ eventType, stateKey }) =>
            widgetApi.requestCapabilityToSendState(eventType, stateKey),
        );
        capabilities.receiveState?.forEach(({ eventType, stateKey }) =>
            widgetApi.requestCapabilityToReceiveState(eventType, stateKey),
        );
        capabilities.sendToDevice?.forEach((eventType) => widgetApi.requestCapabilityToSendToDevice(eventType));
        capabilities.receiveToDevice?.forEach((eventType) => widgetApi.requestCapabilityToReceiveToDevice(eventType));
        if (
            capabilities.sendDelayedEvents &&
            (capabilities.sendEvent?.length ||
                capabilities.sendMessage === true ||
                (Array.isArray(capabilities.sendMessage) && capabilities.sendMessage.length) ||
                capabilities.sendState?.length)
        ) {
            widgetApi.requestCapability(MatrixCapabilities.MSC4157SendDelayedEvent);
        }
        if (capabilities.updateDelayedEvents) {
            widgetApi.requestCapability(MatrixCapabilities.MSC4157UpdateDelayedEvent);
        }
        if (capabilities.turnServers) {
            widgetApi.requestCapability(MatrixCapabilities.MSC3846TurnServers);
        }

        widgetApi.on(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        widgetApi.on(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);

        // Open communication with the host
        widgetApi.start();
        // Send a content loaded event now we've started the widget API
        // Note that element-web currently does not use waitForIFrameLoad=false and so
        // does *not* (yes, that is the right way around) wait for this event. Let's
        // start sending this, then once this has rolled out, we can change element-web to
        // use waitForIFrameLoad=false and have a widget API that's less racy.
        if (sendContentLoaded) widgetApi.sendContentLoaded();
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
            this.syncApi = new SlidingSyncSdk(opts.slidingSync, this, opts, this.buildSyncApiOptions());
        } else {
            this.syncApi = new SyncApi(this, opts, this.buildSyncApiOptions());
        }

        this.room = this.syncApi.createRoom(this.roomId);
        this.store.storeRoom(this.room);

        await this.widgetApiReady;

        // Backfill the requested events
        // We only get the most recent event for every type + state key combo,
        // so it doesn't really matter what order we inject them in
        await Promise.all(
            this.capabilities.receiveState?.map(async ({ eventType, stateKey }) => {
                const rawEvents = await this.widgetApi.readStateEvents(eventType, undefined, stateKey, [this.roomId]);
                const events = rawEvents.map((rawEvent) => new MatrixEvent(rawEvent as Partial<IEvent>));

                await this.syncApi!.injectRoomEvents(this.room!, [], events);
                events.forEach((event) => {
                    this.emit(ClientEvent.Event, event);
                    logger.info(`Backfilled event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
                });
            }) ?? [],
        );

        if (opts.clientWellKnownPollPeriod !== undefined) {
            this.clientWellKnownIntervalID = setInterval(() => {
                this.fetchClientWellKnown();
            }, 1000 * opts.clientWellKnownPollPeriod);
            this.fetchClientWellKnown();
        }

        this.setSyncState(SyncState.Syncing);
        logger.info("Finished backfilling events");

        this.matrixRTC.start();

        // Watch for TURN servers, if requested
        if (this.capabilities.turnServers) this.watchTurnServers();
    }

    public stopClient(): void {
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);

        super.stopClient();
        this.lifecycle!.abort(); // Signal to other async tasks that the client has stopped
    }

    public async joinRoom(roomIdOrAlias: string): Promise<Room> {
        if (roomIdOrAlias === this.roomId) return this.room!;
        throw new Error(`Unknown room: ${roomIdOrAlias}`);
    }

    protected async encryptAndSendEvent(room: Room, event: MatrixEvent): Promise<ISendEventResponse>;
    protected async encryptAndSendEvent(
        room: Room,
        event: MatrixEvent,
        delayOpts: SendDelayedEventRequestOpts,
    ): Promise<SendDelayedEventResponse>;
    protected async encryptAndSendEvent(
        room: Room,
        event: MatrixEvent,
        delayOpts?: SendDelayedEventRequestOpts,
    ): Promise<ISendEventResponse | SendDelayedEventResponse> {
        if (delayOpts) {
            // TODO: updatePendingEvent for delayed events?
            const response = await this.widgetApi.sendRoomEvent(
                event.getType(),
                event.getContent(),
                room.roomId,
                "delay" in delayOpts ? delayOpts.delay : undefined,
                "parent_delay_id" in delayOpts ? delayOpts.parent_delay_id : undefined,
            );
            return this.validateSendDelayedEventResponse(response);
        }

        let response: ISendEventFromWidgetResponseData;
        try {
            response = await this.widgetApi.sendRoomEvent(event.getType(), event.getContent(), room.roomId);
        } catch (e) {
            this.updatePendingEventStatus(room, event, EventStatus.NOT_SENT);
            throw e;
        }

        // This also checks for an event id on the response
        room.updatePendingEvent(event, EventStatus.SENT, response.event_id);
        return { event_id: response.event_id! };
    }

    public async sendStateEvent(
        roomId: string,
        eventType: string,
        content: any,
        stateKey = "",
    ): Promise<ISendEventResponse> {
        const response = await this.widgetApi.sendStateEvent(eventType, stateKey, content, roomId);
        if (response.event_id === undefined) {
            throw new Error("'event_id' absent from response to an event request");
        }
        return { event_id: response.event_id };
    }

    /**
     * @experimental This currently relies on an unstable MSC (MSC4140).
     */
    // eslint-disable-next-line
    public async _unstable_sendDelayedStateEvent<K extends keyof StateEvents>(
        roomId: string,
        delayOpts: SendDelayedEventRequestOpts,
        eventType: K,
        content: StateEvents[K],
        stateKey = "",
    ): Promise<SendDelayedEventResponse> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw Error("Server does not support the delayed events API");
        }

        const response = await this.widgetApi.sendStateEvent(
            eventType,
            stateKey,
            content,
            roomId,
            "delay" in delayOpts ? delayOpts.delay : undefined,
            "parent_delay_id" in delayOpts ? delayOpts.parent_delay_id : undefined,
        );
        return this.validateSendDelayedEventResponse(response);
    }

    private validateSendDelayedEventResponse(response: ISendEventFromWidgetResponseData): SendDelayedEventResponse {
        if (response.delay_id === undefined) {
            throw new Error("'delay_id' absent from response to a delayed event request");
        }
        return { delay_id: response.delay_id };
    }

    /**
     * @experimental This currently relies on an unstable MSC (MSC4140).
     */
    // eslint-disable-next-line
    public async _unstable_updateDelayedEvent(delayId: string, action: UpdateDelayedEventAction): Promise<{}> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw Error("Server does not support the delayed events API");
        }

        return await this.widgetApi.updateDelayedEvent(delayId, action);
    }

    public async sendToDevice(eventType: string, contentMap: SendToDeviceContentMap): Promise<{}> {
        await this.widgetApi.sendToDevice(eventType, false, recursiveMapToObject(contentMap));
        return {};
    }

    public async getOpenIdToken(): Promise<IOpenIDToken> {
        const token = await this.widgetApi.requestOpenIDConnectToken();
        // the IOpenIDCredentials from the widget-api and IOpenIDToken form the matrix-js-sdk are compatible.
        // we still recreate the token to make this transparent and catch'able by the linter in case the types change in the future.
        return <IOpenIDToken>{
            access_token: token.access_token,
            expires_in: token.expires_in,
            matrix_server_name: token.matrix_server_name,
            token_type: token.token_type,
        };
    }

    public async queueToDevice({ eventType, batch }: ToDeviceBatch): Promise<void> {
        // map: user Id → device Id → payload
        const contentMap: MapWithDefault<string, Map<string, ToDevicePayload>> = new MapWithDefault(() => new Map());
        for (const { userId, deviceId, payload } of batch) {
            contentMap.getOrCreate(userId).set(deviceId, payload);
        }

        await this.widgetApi.sendToDevice(eventType, false, recursiveMapToObject(contentMap));
    }

    public async encryptAndSendToDevices(userDeviceInfoArr: IOlmDevice<DeviceInfo>[], payload: object): Promise<void> {
        // map: user Id → device Id → payload
        const contentMap: MapWithDefault<string, Map<string, object>> = new MapWithDefault(() => new Map());
        for (const {
            userId,
            deviceInfo: { deviceId },
        } of userDeviceInfoArr) {
            contentMap.getOrCreate(userId).set(deviceId, payload);
        }

        await this.widgetApi.sendToDevice((payload as { type: string }).type, true, recursiveMapToObject(contentMap));
    }

    // Overridden since we get TURN servers automatically over the widget API,
    // and this method would otherwise complain about missing an access token
    public async checkTurnServers(): Promise<boolean> {
        return this.turnServers.length > 0;
    }

    // Overridden since we 'sync' manually without the sync API
    public getSyncState(): SyncState | null {
        return this.syncState;
    }

    private setSyncState(state: SyncState): void {
        const oldState = this.syncState;
        this.syncState = state;
        this.emit(ClientEvent.Sync, state, oldState);
    }

    private async ack(ev: CustomEvent<IWidgetApiRequest>): Promise<void> {
        await this.widgetApi.transport.reply<IWidgetApiAcknowledgeResponseData>(ev.detail, {});
    }

    private onEvent = async (ev: CustomEvent<ISendEventToWidgetActionRequest>): Promise<void> => {
        ev.preventDefault();

        // Verify the room ID matches, since it's possible for the client to
        // send us events from other rooms if this widget is always on screen
        if (ev.detail.data.room_id === this.roomId) {
            const event = new MatrixEvent(ev.detail.data as Partial<IEvent>);
            await this.syncApi!.injectRoomEvents(this.room!, [], [event]);
            this.emit(ClientEvent.Event, event);
            this.setSyncState(SyncState.Syncing);
            logger.info(`Received event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
        } else {
            const { event_id: eventId, room_id: roomId } = ev.detail.data;
            logger.info(`Received event ${eventId} for a different room ${roomId}; discarding`);
        }

        await this.ack(ev);
    };

    private onToDevice = async (ev: CustomEvent<ISendToDeviceToWidgetActionRequest>): Promise<void> => {
        ev.preventDefault();

        const event = new MatrixEvent({
            type: ev.detail.data.type,
            sender: ev.detail.data.sender,
            content: ev.detail.data.content as IContent,
        });
        // Mark the event as encrypted if it was, using fake contents and keys since those are unknown to us
        if (ev.detail.data.encrypted) event.makeEncrypted(EventType.RoomMessageEncrypted, {}, "", "");

        this.emit(ClientEvent.ToDeviceEvent, event);
        this.setSyncState(SyncState.Syncing);
        await this.ack(ev);
    };

    private async watchTurnServers(): Promise<void> {
        const servers = this.widgetApi.getTurnServers();
        const onClientStopped = (): void => {
            servers.return(undefined);
        };
        this.lifecycle!.signal.addEventListener("abort", onClientStopped);

        try {
            for await (const server of servers) {
                this.turnServers = [
                    {
                        urls: server.uris,
                        username: server.username,
                        credential: server.password,
                    },
                ];
                this.emit(ClientEvent.TurnServers, this.turnServers);
                logger.log(`Received TURN server: ${server.uris}`);
            }
        } catch (e) {
            logger.warn("Error watching TURN servers", e);
        } finally {
            this.lifecycle!.signal.removeEventListener("abort", onClientStopped);
        }
    }
}
