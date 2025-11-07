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
    type WidgetApi,
    WidgetApiToWidgetAction,
    WidgetApiResponseError,
    MatrixCapabilities,
    type IWidgetApiRequest,
    type IWidgetApiAcknowledgeResponseData,
    type ISendEventToWidgetActionRequest,
    type ISendToDeviceToWidgetActionRequest,
    type ISendEventFromWidgetResponseData,
    type IWidgetApiRequestData,
    type WidgetApiAction,
    type IWidgetApiResponse,
    type IWidgetApiResponseData,
    type IUpdateStateToWidgetActionRequest,
    UnstableApiVersion,
} from "matrix-widget-api";

import { MatrixEvent, type IEvent, type IContent, EventStatus } from "./models/event.ts";
import {
    type ISendEventResponse,
    type SendDelayedEventRequestOpts,
    type SendDelayedEventResponse,
    UpdateDelayedEventAction,
} from "./@types/requests.ts";
import { EventType, type StateEvents } from "./@types/event.ts";
import { logger } from "./logger.ts";
import {
    MatrixClient,
    ClientEvent,
    type IMatrixClientCreateOpts,
    type IStartClientOpts,
    type SendToDeviceContentMap,
    type IOpenIDToken,
    UNSTABLE_MSC4140_DELAYED_EVENTS,
} from "./client.ts";
import { SyncApi, SyncState } from "./sync.ts";
import { SlidingSyncSdk } from "./sliding-sync-sdk.ts";
import { ConnectionError, MatrixError } from "./http-api/errors.ts";
import { User } from "./models/user.ts";
import { type Room } from "./models/room.ts";
import { type ToDeviceBatch, type ToDevicePayload } from "./models/ToDeviceMessage.ts";
import { MapWithDefault, recursiveMapToObject } from "./utils.ts";
import { type EmptyObject, TypedEventEmitter, UnsupportedDelayedEventsEndpointError } from "./matrix.ts";

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

export enum RoomWidgetClientEvent {
    PendingEventsChanged = "PendingEvent.pendingEventsChanged",
}
export type EventHandlerMap = { [RoomWidgetClientEvent.PendingEventsChanged]: () => void };

/**
 * A MatrixClient that routes its requests through the widget API instead of the
 * real CS API.
 * @experimental This class is considered unstable!
 */
export class RoomWidgetClient extends MatrixClient {
    private room?: Room;
    private readonly widgetApiReady: Promise<void>;
    private readonly roomStateSynced: Promise<void>;
    private lifecycle?: AbortController;
    private syncState: SyncState | null = null;

    private pendingSendingEventsTxId: { type: string; id: string | undefined; txId: string }[] = [];
    private eventEmitter = new TypedEventEmitter<keyof EventHandlerMap, EventHandlerMap>();

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

        const transportSend = this.widgetApi.transport.send.bind(this.widgetApi.transport);
        this.widgetApi.transport.send = async <
            T extends IWidgetApiRequestData,
            R extends IWidgetApiResponseData = IWidgetApiAcknowledgeResponseData,
        >(
            action: WidgetApiAction,
            data: T,
        ): Promise<R> => {
            try {
                return await transportSend(action, data);
            } catch (error) {
                processAndThrow(error);
            }
        };

        const transportSendComplete = this.widgetApi.transport.sendComplete.bind(this.widgetApi.transport);
        this.widgetApi.transport.sendComplete = async <T extends IWidgetApiRequestData, R extends IWidgetApiResponse>(
            action: WidgetApiAction,
            data: T,
        ): Promise<R> => {
            try {
                return await transportSendComplete(action, data);
            } catch (error) {
                processAndThrow(error);
            }
        };

        this.widgetApiReady = new Promise<void>((resolve) => this.widgetApi.once("ready", resolve));
        this.roomStateSynced = capabilities.receiveState?.length
            ? new Promise<void>((resolve) =>
                  this.widgetApi.once(`action:${WidgetApiToWidgetAction.UpdateState}`, resolve),
              )
            : Promise.resolve();

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
        widgetApi.on(`action:${WidgetApiToWidgetAction.UpdateState}`, this.onStateUpdate);

        // Open communication with the host
        widgetApi.start();
        // Send a content loaded event now we've started the widget API
        // Note that element-web currently does not use waitForIFrameLoad=false and so
        // does *not* (yes, that is the right way around) wait for this event. Let's
        // start sending this, then once this has rolled out, we can change element-web to
        // use waitForIFrameLoad=false and have a widget API that's less racy.
        if (sendContentLoaded) widgetApi.sendContentLoaded();
    }

    public async supportUpdateState(): Promise<boolean> {
        return (await this.widgetApi.getClientVersions()).includes(UnstableApiVersion.MSC2762_UPDATE_STATE);
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

        // sync room state:
        if (await this.supportUpdateState()) {
            // This will resolve once the client driver has sent us all the allowed room state.
            await this.roomStateSynced;
        } else {
            // Backfill the requested events
            // We only get the most recent event for every type + state key combo,
            // so it doesn't really matter what order we inject them in
            await Promise.all(
                this.capabilities.receiveState?.map(async ({ eventType, stateKey }) => {
                    const rawEvents = await this.widgetApi.readStateEvents(eventType, undefined, stateKey, [
                        this.roomId,
                    ]);
                    const events = rawEvents.map((rawEvent) => new MatrixEvent(rawEvent as Partial<IEvent>));

                    if (this.syncApi instanceof SyncApi) {
                        // Passing events as `stateAfterEventList` will update the state.
                        await this.syncApi.injectRoomEvents(this.room!, undefined, events);
                    } else {
                        await this.syncApi!.injectRoomEvents(this.room!, events); // Sliding Sync
                    }
                    events.forEach((event) => {
                        this.emit(ClientEvent.Event, event);
                        logger.info(`Backfilled event ${event.getId()} ${event.getType()} ${event.getStateKey()}`);
                    });
                }) ?? [],
            );
        }

        if (opts.clientWellKnownPollPeriod !== undefined) {
            this.clientWellKnownIntervalID = setInterval(() => {
                this.fetchClientWellKnown();
            }, 1000 * opts.clientWellKnownPollPeriod);
            this.fetchClientWellKnown();
        }
        this.setSyncState(SyncState.Syncing);
        logger.info("Finished initial sync");

        this.matrixRTC.start();

        // Watch for TURN servers, if requested
        if (this.capabilities.turnServers) this.watchTurnServers();
    }

    public stopClient(): void {
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendEvent}`, this.onEvent);
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.SendToDevice}`, this.onToDevice);
        this.widgetApi.off(`action:${WidgetApiToWidgetAction.UpdateState}`, this.onStateUpdate);

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
        // We need to extend the content with the redacts parameter
        // The js sdk uses event.redacts but the widget api uses event.content.redacts
        // This will be converted back to event.redacts in the widget driver.
        const content = event.event.redacts
            ? { ...event.getContent(), redacts: event.event.redacts }
            : event.getContent();

        // Delayed event special case.
        if (delayOpts) {
            // TODO: updatePendingEvent for delayed events?
            const response = await this.widgetApi
                .sendRoomEvent(
                    event.getType(),
                    content,
                    room.roomId,
                    "delay" in delayOpts ? delayOpts.delay : undefined,
                    "parent_delay_id" in delayOpts ? delayOpts.parent_delay_id : undefined,
                )
                .catch(timeoutToConnectionError);
            return this.validateSendDelayedEventResponse(response);
        }

        const txId = event.getTxnId();
        // Add the txnId to the pending list (still with unknown evID)
        if (txId) this.pendingSendingEventsTxId.push({ type: event.getType(), id: undefined, txId });

        let response: ISendEventFromWidgetResponseData;
        try {
            response = await this.widgetApi
                .sendRoomEvent(event.getType(), content, room.roomId)
                .catch(timeoutToConnectionError);
        } catch (e) {
            this.updatePendingEventStatus(room, event, EventStatus.NOT_SENT);
            throw e;
        }
        // This also checks for an event id on the response
        room.updatePendingEvent(event, EventStatus.SENT, response.event_id);

        // Update the pending events list with the eventId
        this.pendingSendingEventsTxId.forEach((p) => {
            if (p.txId === txId) p.id = response.event_id;
        });
        this.eventEmitter.emit(RoomWidgetClientEvent.PendingEventsChanged);

        return { event_id: response.event_id! };
    }

    public async sendStateEvent(
        roomId: string,
        eventType: string,
        content: any,
        stateKey = "",
    ): Promise<ISendEventResponse> {
        const response = await this.widgetApi
            .sendStateEvent(eventType, stateKey, content, roomId)
            .catch(timeoutToConnectionError);
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
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "sendDelayedStateEvent",
            );
        }

        const response = await this.widgetApi
            .sendStateEvent(
                eventType,
                stateKey,
                content,
                roomId,
                "delay" in delayOpts ? delayOpts.delay : undefined,
                "parent_delay_id" in delayOpts ? delayOpts.parent_delay_id : undefined,
            )
            .catch(timeoutToConnectionError);
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
     * @deprecated Instead use one of:
     * - {@link _unstable_cancelScheduledDelayedEvent}
     * - {@link _unstable_restartScheduledDelayedEvent}
     * - {@link _unstable_sendScheduledDelayedEvent}
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_updateDelayedEvent(delayId: string, action: UpdateDelayedEventAction): Promise<EmptyObject> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "updateDelayedEvent",
            );
        }

        let updateDelayedEvent: (delayId: string) => Promise<unknown>;
        switch (action) {
            case UpdateDelayedEventAction.Cancel:
                updateDelayedEvent = this.widgetApi.cancelScheduledDelayedEvent;
                break;
            case UpdateDelayedEventAction.Restart:
                updateDelayedEvent = this.widgetApi.cancelScheduledDelayedEvent;
                break;
            case UpdateDelayedEventAction.Send:
                updateDelayedEvent = this.widgetApi.sendScheduledDelayedEvent;
                break;
        }
        await updateDelayedEvent.call(this.widgetApi, delayId).catch(timeoutToConnectionError);
        return {};
    }

    /**
     * @experimental This currently relies on an unstable MSC (MSC4140).
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_cancelScheduledDelayedEvent(delayId: string): Promise<EmptyObject> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "cancelScheduledDelayedEvent",
            );
        }

        await this.widgetApi.cancelScheduledDelayedEvent(delayId).catch(timeoutToConnectionError);
        return {};
    }

    /**
     * @experimental This currently relies on an unstable MSC (MSC4140).
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_restartScheduledDelayedEvent(delayId: string): Promise<EmptyObject> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "restartScheduledDelayedEvent",
            );
        }

        await this.widgetApi.restartScheduledDelayedEvent(delayId).catch(timeoutToConnectionError);
        return {};
    }

    /**
     * @experimental This currently relies on an unstable MSC (MSC4140).
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async _unstable_sendScheduledDelayedEvent(delayId: string): Promise<EmptyObject> {
        if (!(await this.doesServerSupportUnstableFeature(UNSTABLE_MSC4140_DELAYED_EVENTS))) {
            throw new UnsupportedDelayedEventsEndpointError(
                "Server does not support the delayed events API",
                "sendScheduledDelayedEvent",
            );
        }

        await this.widgetApi.sendScheduledDelayedEvent(delayId).catch(timeoutToConnectionError);
        return {};
    }

    /**
     * by {@link MatrixClient.encryptAndSendToDevice}.
     */
    public async encryptAndSendToDevice(
        eventType: string,
        devices: { userId: string; deviceId: string }[],
        payload: ToDevicePayload,
    ): Promise<void> {
        // map: user Id → device Id → payload
        const contentMap: MapWithDefault<string, Map<string, ToDevicePayload>> = new MapWithDefault(() => new Map());
        for (const { userId, deviceId } of devices) {
            contentMap.getOrCreate(userId).set(deviceId, payload);
        }

        await this.widgetApi
            .sendToDevice(eventType, true, recursiveMapToObject(contentMap))
            .catch(timeoutToConnectionError);
    }

    public async sendToDevice(eventType: string, contentMap: SendToDeviceContentMap): Promise<EmptyObject> {
        await this.widgetApi
            .sendToDevice(eventType, false, recursiveMapToObject(contentMap))
            .catch(timeoutToConnectionError);
        return {};
    }

    public async getOpenIdToken(): Promise<IOpenIDToken> {
        const token = await this.widgetApi.requestOpenIDConnectToken().catch(timeoutToConnectionError);
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

        await this.widgetApi
            .sendToDevice(eventType, false, recursiveMapToObject(contentMap))
            .catch(timeoutToConnectionError);
    }

    /**
     * Send an event to a specific list of devices via the widget API. Optionally encrypts the event.
     *
     * If you are using a full MatrixClient you would be calling {@link MatrixClient.getCrypto().encryptToDeviceMessages()} followed
     * by {@link MatrixClient.queueToDevice}.
     *
     * However, this is combined into a single step when running as an embedded widget client. So, we expose this method for those
     * that need it.
     *
     * @param eventType - Type of the event to send.
     * @param encrypted - Whether the event should be encrypted.
     * @param contentMap - The content to send. Map from user_id to device_id to content object.
     */
    public async sendToDeviceViaWidgetApi(
        eventType: string,
        encrypted: boolean,
        contentMap: SendToDeviceContentMap,
    ): Promise<void> {
        await this.widgetApi
            .sendToDevice(eventType, encrypted, recursiveMapToObject(contentMap))
            .catch(timeoutToConnectionError);
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

    private updateTxId = async (event: MatrixEvent): Promise<void> => {
        // We update the txId for remote echos that originate from this client.
        // This happens with the help of `pendingSendingEventsTxId` where we store all events that are currently sending
        // with their widget txId and once ready the final evId.
        if (
            // This could theoretically be an event send by this device
            // In that case we need to update the txId of the event because the embedded client/widget
            // knows this event with a different transaction Id than what was used by the host client.
            event.getSender() === this.getUserId() &&
            // We optimize by not blocking events from types that we have not send
            // with this client.
            this.pendingSendingEventsTxId.some((p) => event.getType() === p.type)
        ) {
            // Compare by event Id if we have a matching pending event where we know the txId.
            let matchingTxId = this.pendingSendingEventsTxId.find((p) => p.id === event.getId())?.txId;
            // Block any further processing of this event until we have received the sending response.
            // -> until we know the event id.
            // -> until we have not pending events anymore.
            while (!matchingTxId && this.pendingSendingEventsTxId.length > 0) {
                // Recheck whenever the PendingEventsChanged
                await new Promise<void>((resolve) =>
                    this.eventEmitter.once(RoomWidgetClientEvent.PendingEventsChanged, () => resolve()),
                );
                matchingTxId = this.pendingSendingEventsTxId.find((p) => p.id === event.getId())?.txId;
            }

            // We found the correct txId: we update the event and delete the entry of the pending events.
            if (matchingTxId) {
                event.setTxnId(matchingTxId);
                event.setUnsigned({ ...event.getUnsigned(), transaction_id: matchingTxId });
            }
            this.pendingSendingEventsTxId = this.pendingSendingEventsTxId.filter((p) => p.id !== event.getId());

            // Emit once there are no pending events anymore to release all other events that got
            // awaited in the `while (!matchingTxId && this.pendingSendingEventsTxId.length > 0)` loop
            // but are not send by this client.
            if (this.pendingSendingEventsTxId.length === 0) {
                this.eventEmitter.emit(RoomWidgetClientEvent.PendingEventsChanged);
            }
        }
    };

    private onEvent = async (ev: CustomEvent<ISendEventToWidgetActionRequest>): Promise<void> => {
        ev.preventDefault();

        // Verify the room ID matches, since it's possible for the client to
        // send us events from other rooms if this widget is always on screen
        if (ev.detail.data.room_id === this.roomId) {
            const event = new MatrixEvent(ev.detail.data as Partial<IEvent>);

            // Only inject once we have update the txId
            await this.updateTxId(event);

            if (this.syncApi instanceof SyncApi) {
                if (await this.supportUpdateState()) {
                    await this.syncApi.injectRoomEvents(this.room!, undefined, [], [event]);
                } else {
                    // Passing undefined for `stateAfterEventList` will make `injectRoomEvents` run in legacy mode
                    // -> state events in `timelineEventList` will update the state.
                    await this.syncApi.injectRoomEvents(this.room!, [], undefined, [event]);
                }
            } else {
                // Sliding Sync
                if (await this.supportUpdateState()) {
                    await this.syncApi!.injectRoomEvents(this.room!, [], [event]);
                } else {
                    logger.error(
                        "slididng sync cannot be used in widget mode if the client widget driver does not support the version: 'org.matrix.msc2762_update_state'",
                    );
                }
            }

            this.emit(ClientEvent.Event, event);
            this.setSyncState(SyncState.Syncing);
            logger.info(`Received event ${event.getId()} ${event.getType()}`);
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

    private onStateUpdate = async (ev: CustomEvent<IUpdateStateToWidgetActionRequest>): Promise<void> => {
        ev.preventDefault();
        if (!(await this.supportUpdateState())) {
            logger.warn(
                "received update_state widget action but the widget driver did not claim to support 'org.matrix.msc2762_update_state'",
            );
        }
        for (const rawEvent of ev.detail.data.state) {
            // Verify the room ID matches, since it's possible for the client to
            // send us state updates from other rooms if this widget is always
            // on screen
            if (rawEvent.room_id === this.roomId) {
                const event = new MatrixEvent(rawEvent as Partial<IEvent>);

                if (this.syncApi instanceof SyncApi) {
                    await this.syncApi.injectRoomEvents(this.room!, undefined, [event]);
                } else {
                    // Sliding Sync
                    await this.syncApi!.injectRoomEvents(this.room!, [event]);
                }
                logger.info(`Updated state entry ${event.getType()} ${event.getStateKey()} to ${event.getId()}`);
            } else {
                const { event_id: eventId, room_id: roomId } = ev.detail.data;
                logger.info(`Received state entry ${eventId} for a different room ${roomId}; discarding`);
            }
        }

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

function processAndThrow(error: unknown): never {
    if (error instanceof WidgetApiResponseError && error.data.matrix_api_error) {
        throw MatrixError.fromWidgetApiErrorData(error.data.matrix_api_error);
    } else {
        throw error;
    }
}

/**
 * This converts an "Request timed out" error from the PostmessageTransport into a ConnectionError.
 * It either throws the original error or a new ConnectionError.
 **/
function timeoutToConnectionError(error: unknown): never {
    // TODO: this should not check on error.message but instead it should be a specific type
    // error instanceof WidgetTimeoutError
    if (error instanceof Error && error.message === "Request timed out") {
        throw new ConnectionError("widget api timeout");
    }
    throw error;
}
