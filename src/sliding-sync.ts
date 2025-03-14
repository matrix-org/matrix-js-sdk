/*
Copyright 2022-2024 The Matrix.org Foundation C.I.C.

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

import { logger } from "./logger.ts";
import { type MatrixClient } from "./client.ts";
import { type IRoomEvent, type IStateEvent } from "./sync-accumulator.ts";
import { TypedEventEmitter } from "./models/typed-event-emitter.ts";
import { sleep } from "./utils.ts";
import { type HTTPError } from "./http-api/index.ts";

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
const BUFFER_PERIOD_MS = 10 * 1000;

export const MSC3575_WILDCARD = "*";
export const MSC3575_STATE_KEY_ME = "$ME";
export const MSC3575_STATE_KEY_LAZY = "$LAZY";

/**
 * Represents a subscription to a room or set of rooms. Controls which events are returned.
 */
export interface MSC3575RoomSubscription {
    required_state?: string[][];
    timeline_limit?: number;
    include_old_rooms?: MSC3575RoomSubscription;
}

/**
 * Controls which rooms are returned in a given list.
 */
export interface MSC3575Filter {
    is_dm?: boolean;
    is_encrypted?: boolean;
    is_invite?: boolean;
    room_name_like?: string;
    room_types?: string[];
    not_room_types?: string[];
    spaces?: string[];
    tags?: string[];
    not_tags?: string[];
}

/**
 * Represents a list subscription.
 */
export interface MSC3575List extends MSC3575RoomSubscription {
    ranges: number[][];
    sort?: string[];
    filters?: MSC3575Filter;
    slow_get_all_rooms?: boolean;
}

/**
 * A complete Sliding Sync request.
 */
export interface MSC3575SlidingSyncRequest {
    // json body params
    lists?: Record<string, MSC3575List>;
    unsubscribe_rooms?: string[];
    room_subscriptions?: Record<string, MSC3575RoomSubscription>;
    extensions?: object;
    txn_id?: string;

    // query params
    pos?: string;
    timeout?: number;
    clientTimeout?: number;
}

/**
 * New format of hero introduced in MSC4186 with display name and avatar URL
 * in addition to just user_id (as it is on the wire, with underscores)
 * as opposed to Hero in room-summary.ts which has fields in camelCase
 * (and also a flag to note what format the hero came from).
 */
export interface MSC4186Hero {
    user_id: string;
    displayname?: string;
    avatar_url?: string;
}

export interface MSC3575RoomData {
    name: string;
    required_state: IStateEvent[];
    timeline: (IRoomEvent | IStateEvent)[];
    heroes?: MSC4186Hero[];
    notification_count?: number;
    highlight_count?: number;
    joined_count?: number;
    invited_count?: number;
    invite_state?: IStateEvent[];
    initial?: boolean;
    limited?: boolean;
    is_dm?: boolean;
    prev_batch?: string;
    num_live?: number;
    bump_stamp?: number;
}

interface ListResponse {
    count: number;
}

/**
 * A complete Sliding Sync response
 */
export interface MSC3575SlidingSyncResponse {
    pos: string;
    txn_id?: string;
    lists: Record<string, ListResponse>;
    rooms: Record<string, MSC3575RoomData>;
    extensions: Record<string, object>;
}

export enum SlidingSyncState {
    /**
     * Fired by SlidingSyncEvent.Lifecycle event immediately before processing the response.
     */
    RequestFinished = "FINISHED",
    /**
     * Fired by SlidingSyncEvent.Lifecycle event immediately after all room data listeners have been
     * invoked, but before list listeners.
     */
    Complete = "COMPLETE",
}

/**
 * Internal Class. SlidingList represents a single list in sliding sync. The list can have filters,
 * multiple sliding windows, and maintains the index-\>room_id mapping.
 */
class SlidingList {
    private list!: MSC3575List;
    private isModified?: boolean;

    // returned data
    public joinedCount = 0;

    /**
     * Construct a new sliding list.
     * @param list - The range, sort and filter values to use for this list.
     */
    public constructor(list: MSC3575List) {
        this.replaceList(list);
    }

    /**
     * Mark this list as modified or not. Modified lists will return sticky params with calls to getList.
     * This is useful for the first time the list is sent, or if the list has changed in some way.
     * @param modified - True to mark this list as modified so all sticky parameters will be re-sent.
     */
    public setModified(modified: boolean): void {
        this.isModified = modified;
    }

    /**
     * Update the list range for this list. Does not affect modified status as list ranges are non-sticky.
     * @param newRanges - The new ranges for the list
     */
    public updateListRange(newRanges: number[][]): void {
        this.list.ranges = JSON.parse(JSON.stringify(newRanges));
    }

    /**
     * Replace list parameters. All fields will be replaced with the new list parameters.
     * @param list - The new list parameters
     */
    public replaceList(list: MSC3575List): void {
        list.filters = list.filters ?? {};
        list.ranges = list.ranges ?? [];
        this.list = JSON.parse(JSON.stringify(list));
        this.isModified = true;

        // reset values as the join count may be very different (if filters changed) including the rooms
        // (e.g. sort orders or sliding window ranges changed)

        // the total number of joined rooms according to the server, always >= len(roomIndexToRoomId)
        this.joinedCount = 0;
    }

    /**
     * Return a copy of the list suitable for a request body.
     * @param forceIncludeAllParams - True to forcibly include all params even if the list
     * hasn't been modified. Callers may want to do this if they are modifying the list prior to calling
     * updateList.
     */
    public getList(forceIncludeAllParams: boolean): MSC3575List {
        let list = {
            ranges: JSON.parse(JSON.stringify(this.list.ranges)),
        };
        if (this.isModified || forceIncludeAllParams) {
            list = JSON.parse(JSON.stringify(this.list));
        }
        return list;
    }
}

/**
 * When onResponse extensions should be invoked: before or after processing the main response.
 */
export enum ExtensionState {
    // Call onResponse before processing the response body. This is useful when your extension is
    // preparing the ground for the response body e.g. processing to-device messages before the
    // encrypted event arrives.
    PreProcess = "ExtState.PreProcess",
    // Call onResponse after processing the response body. This is useful when your extension is
    // decorating data from the client, and you rely on MatrixClient.getRoom returning the Room object
    // e.g. room account data.
    PostProcess = "ExtState.PostProcess",
}

/**
 * An interface that must be satisfied to register extensions
 */
export interface Extension<Req extends object, Res extends object> {
    /**
     * The extension name to go under 'extensions' in the request body.
     * @returns The JSON key.
     */
    name(): string;
    /**
     * A function which is called when the request JSON is being formed.
     * Returns the data to insert under this key.
     * @param isInitial - True when this is part of the initial request.
     * @returns The request JSON to send.
     */
    onRequest(isInitial: boolean): Promise<Req>;
    /**
     * A function which is called when there is response JSON under this extension.
     * @param data - The response JSON under the extension name.
     */
    onResponse(data: Res): Promise<void>;
    /**
     * Controls when onResponse should be called.
     * @returns The state when it should be called.
     */
    when(): ExtensionState;
}

/**
 * Events which can be fired by the SlidingSync class. These are designed to provide different levels
 * of information when processing sync responses.
 *  - RoomData: concerns rooms, useful for SlidingSyncSdk to update its knowledge of rooms.
 *  - Lifecycle: concerns callbacks at various well-defined points in the sync process.
 * Specifically, the order of event invocation is:
 *  - Lifecycle (state=RequestFinished)
 *  - RoomData (N times)
 *  - Lifecycle (state=Complete)
 */
export enum SlidingSyncEvent {
    /**
     * This event fires when there are updates for a room. Fired as and when rooms are encountered
     * in the response.
     */
    RoomData = "SlidingSync.RoomData",
    /**
     * This event fires at various points in the /sync loop lifecycle.
     *  - SlidingSyncState.RequestFinished: Fires after we receive a valid response but before the
     * response has been processed. Perform any pre-process steps here. If there was a problem syncing,
     * `err` will be set (e.g network errors).
     *  - SlidingSyncState.Complete: Fires after the response has been processed.
     */
    Lifecycle = "SlidingSync.Lifecycle",
}

export type SlidingSyncEventHandlerMap = {
    [SlidingSyncEvent.RoomData]: (roomId: string, roomData: MSC3575RoomData) => Promise<void> | void;
    [SlidingSyncEvent.Lifecycle]: (
        state: SlidingSyncState,
        resp: MSC3575SlidingSyncResponse | null,
        err?: Error,
    ) => void;
};

/**
 * SlidingSync is a high-level data structure which controls the majority of sliding sync.
 * It has no hooks into JS SDK except for needing a MatrixClient to perform the HTTP request.
 * This means this class (and everything it uses) can be used in isolation from JS SDK if needed.
 * To hook this up with the JS SDK, you need to use SlidingSyncSdk.
 */
export class SlidingSync extends TypedEventEmitter<SlidingSyncEvent, SlidingSyncEventHandlerMap> {
    private lists: Map<string, SlidingList>;
    private listModifiedCount = 0;
    private terminated = false;
    // flag set when resend() is called because we cannot rely on detecting AbortError in JS SDK :(
    private needsResend = false;
    // map of extension name to req/resp handler
    private extensions: Record<string, Extension<any, any>> = {};

    private desiredRoomSubscriptions = new Set<string>(); // the *desired* room subscriptions
    private confirmedRoomSubscriptions = new Set<string>();

    // map of custom subscription name to the subscription
    private customSubscriptions: Map<string, MSC3575RoomSubscription> = new Map();
    // map of room ID to custom subscription name
    private roomIdToCustomSubscription: Map<string, string> = new Map();

    private pendingReq?: Promise<MSC3575SlidingSyncResponse>;
    private abortController?: AbortController;

    /**
     * Create a new sliding sync instance
     * @param proxyBaseUrl - The base URL of the sliding sync proxy
     * @param lists - The lists to use for sliding sync.
     * @param roomSubscriptionInfo - The params to use for room subscriptions.
     * @param client - The client to use for /sync calls.
     * @param timeoutMS - The number of milliseconds to wait for a response.
     */
    public constructor(
        private readonly proxyBaseUrl: string,
        lists: Map<string, MSC3575List>,
        private roomSubscriptionInfo: MSC3575RoomSubscription,
        private readonly client: MatrixClient,
        private readonly timeoutMS: number,
    ) {
        super();
        this.lists = new Map<string, SlidingList>();
        lists.forEach((list, key) => {
            this.lists.set(key, new SlidingList(list));
        });
    }

    /**
     * Add a custom room subscription, referred to by an arbitrary name. If a subscription with this
     * name already exists, it is replaced. No requests are sent by calling this method.
     * @param name - The name of the subscription. Only used to reference this subscription in
     * useCustomSubscription.
     * @param sub - The subscription information.
     */
    public addCustomSubscription(name: string, sub: MSC3575RoomSubscription): void {
        if (this.customSubscriptions.has(name)) {
            logger.warn(`addCustomSubscription: ${name} already exists as a custom subscription, ignoring.`);
            return;
        }
        this.customSubscriptions.set(name, sub);
    }

    /**
     * Use a custom subscription previously added via addCustomSubscription. No requests are sent
     * by calling this method. Use modifyRoomSubscriptions to resend subscription information.
     * @param roomId - The room to use the subscription in.
     * @param name - The name of the subscription. If this name is unknown, the default subscription
     * will be used.
     */
    public useCustomSubscription(roomId: string, name: string): void {
        // We already know about this custom subscription, as it is immutable,
        // we don't need to unconfirm the subscription.
        if (this.roomIdToCustomSubscription.get(roomId) === name) {
            return;
        }
        this.roomIdToCustomSubscription.set(roomId, name);
        // unconfirm this subscription so a resend() will send it up afresh.
        this.confirmedRoomSubscriptions.delete(roomId);
    }

    /**
     * Get the room index data for a list.
     * @param key - The list key
     * @returns The list data which contains the rooms in this list
     */
    public getListData(key: string): { joinedCount: number } | null {
        const data = this.lists.get(key);
        if (!data) {
            return null;
        }
        return {
            joinedCount: data.joinedCount,
        };
    }

    /**
     * Get the full request list parameters for a list index. This function is provided for callers to use
     * in conjunction with setList to update fields on an existing list.
     * @param key - The list key to get the params for.
     * @returns A copy of the list params or undefined.
     */
    public getListParams(key: string): MSC3575List | null {
        const params = this.lists.get(key);
        if (!params) {
            return null;
        }
        return params.getList(true);
    }

    /**
     * Set new ranges for an existing list. Calling this function when _only_ the ranges have changed
     * is more efficient than calling setList(index,list) as this function won't resend sticky params,
     * whereas setList always will.
     * @param key - The list key to modify
     * @param ranges - The new ranges to apply.
     * @returns A promise which resolves to the transaction ID when it has been received down sync
     * (or rejects with the transaction ID if the action was not applied e.g the request was cancelled
     * immediately after sending, in which case the action will be applied in the subsequent request)
     */
    public setListRanges(key: string, ranges: number[][]): void {
        const list = this.lists.get(key);
        if (!list) {
            throw new Error("no list with key " + key);
        }
        list.updateListRange(ranges);
        this.resend();
    }

    /**
     * Add or replace a list. Calling this function will interrupt the /sync request to resend new
     * lists.
     * @param key - The key to modify
     * @param list - The new list parameters.
     * @returns A promise which resolves to the transaction ID when it has been received down sync
     * (or rejects with the transaction ID if the action was not applied e.g the request was cancelled
     * immediately after sending, in which case the action will be applied in the subsequent request)
     */
    public setList(key: string, list: MSC3575List): void {
        const existingList = this.lists.get(key);
        if (existingList) {
            existingList.replaceList(list);
            this.lists.set(key, existingList);
        } else {
            this.lists.set(key, new SlidingList(list));
        }
        this.listModifiedCount += 1;
        this.resend();
    }

    /**
     * Get the room subscriptions for the sync API.
     * @returns A copy of the desired room subscriptions.
     */
    public getRoomSubscriptions(): Set<string> {
        return new Set(Array.from(this.desiredRoomSubscriptions));
    }

    /**
     * Modify the room subscriptions for the sync API. Calling this function will interrupt the
     * /sync request to resend new subscriptions. If the /sync stream has not started, this will
     * prepare the room subscriptions for when start() is called.
     * @param s - The new desired room subscriptions.
     */
    public modifyRoomSubscriptions(s: Set<string>): void {
        this.desiredRoomSubscriptions = s;
        this.resend();
    }

    /**
     * Modify which events to retrieve for room subscriptions. Invalidates all room subscriptions
     * such that they will be sent up afresh.
     * @param rs - The new room subscription fields to fetch.
     */
    public modifyRoomSubscriptionInfo(rs: MSC3575RoomSubscription): void {
        this.roomSubscriptionInfo = rs;
        this.confirmedRoomSubscriptions = new Set<string>();
        this.resend();
    }

    /**
     * Register an extension to send with the /sync request.
     * @param ext - The extension to register.
     */
    public registerExtension(ext: Extension<any, any>): void {
        if (this.extensions[ext.name()]) {
            throw new Error(`registerExtension: ${ext.name()} already exists as an extension`);
        }
        this.extensions[ext.name()] = ext;
    }

    private async getExtensionRequest(isInitial: boolean): Promise<Record<string, object | undefined>> {
        const ext: Record<string, object | undefined> = {};
        for (const extName in this.extensions) {
            ext[extName] = await this.extensions[extName].onRequest(isInitial);
        }
        return ext;
    }

    private async onPreExtensionsResponse(ext: Record<string, object>): Promise<void> {
        await Promise.all(
            Object.keys(ext).map(async (extName) => {
                if (this.extensions[extName].when() == ExtensionState.PreProcess) {
                    await this.extensions[extName].onResponse(ext[extName]);
                }
            }),
        );
    }

    private async onPostExtensionsResponse(ext: Record<string, object>): Promise<void> {
        await Promise.all(
            Object.keys(ext).map(async (extName) => {
                if (this.extensions[extName].when() == ExtensionState.PostProcess) {
                    await this.extensions[extName].onResponse(ext[extName]);
                }
            }),
        );
    }

    /**
     * Invoke all attached room data listeners.
     * @param roomId - The room which received some data.
     * @param roomData - The raw sliding sync response JSON.
     */
    private async invokeRoomDataListeners(roomId: string, roomData: MSC3575RoomData): Promise<void> {
        if (!roomData.required_state) {
            roomData.required_state = [];
        }
        if (!roomData.timeline) {
            roomData.timeline = [];
        }
        await this.emitPromised(SlidingSyncEvent.RoomData, roomId, roomData);
    }

    /**
     * Invoke all attached lifecycle listeners.
     * @param state - The Lifecycle state
     * @param resp - The raw sync response JSON
     * @param err - Any error that occurred when making the request e.g. network errors.
     */
    private invokeLifecycleListeners(
        state: SlidingSyncState,
        resp: MSC3575SlidingSyncResponse | null,
        err?: Error,
    ): void {
        this.emit(SlidingSyncEvent.Lifecycle, state, resp, err);
    }

    /**
     * Resend a Sliding Sync request. Used when something has changed in the request.
     */
    public resend(): void {
        this.needsResend = true;
        this.abortController?.abort();
        this.abortController = new AbortController();
    }

    /**
     * Stop syncing with the server.
     */
    public stop(): void {
        this.terminated = true;
        this.abortController?.abort();
        // remove all listeners so things can be GC'd
        this.removeAllListeners(SlidingSyncEvent.Lifecycle);
        this.removeAllListeners(SlidingSyncEvent.RoomData);
    }

    /**
     * Re-setup this connection e.g in the event of an expired session.
     */
    private resetup(): void {
        logger.warn("SlidingSync: resetting connection info");
        // resend sticky params and de-confirm all subscriptions
        this.lists.forEach((l) => {
            l.setModified(true);
        });
        this.confirmedRoomSubscriptions = new Set<string>(); // leave desired ones alone though!
        // reset the connection as we might be wedged
        this.resend();
    }

    /**
     * Start syncing with the server. Blocks until stopped.
     */
    public async start(): Promise<void> {
        this.abortController = new AbortController();

        let currentPos: string | undefined;
        while (!this.terminated) {
            this.needsResend = false;
            let resp: MSC3575SlidingSyncResponse | undefined;
            try {
                const reqLists: Record<string, MSC3575List> = {};
                this.lists.forEach((l: SlidingList, key: string) => {
                    reqLists[key] = l.getList(true);
                });
                const reqBody: MSC3575SlidingSyncRequest = {
                    lists: reqLists,
                    pos: currentPos,
                    timeout: this.timeoutMS,
                    clientTimeout: this.timeoutMS + BUFFER_PERIOD_MS,
                    extensions: await this.getExtensionRequest(currentPos === undefined),
                };
                // check if we are (un)subscribing to a room and modify request this one time for it
                const newSubscriptions = difference(this.desiredRoomSubscriptions, this.confirmedRoomSubscriptions);
                const unsubscriptions = difference(this.confirmedRoomSubscriptions, this.desiredRoomSubscriptions);
                if (unsubscriptions.size > 0) {
                    reqBody.unsubscribe_rooms = Array.from(unsubscriptions);
                }
                if (newSubscriptions.size > 0) {
                    reqBody.room_subscriptions = {};
                    for (const roomId of newSubscriptions) {
                        const customSubName = this.roomIdToCustomSubscription.get(roomId);
                        let sub = this.roomSubscriptionInfo;
                        if (customSubName && this.customSubscriptions.has(customSubName)) {
                            sub = this.customSubscriptions.get(customSubName)!;
                        }
                        reqBody.room_subscriptions[roomId] = sub;
                    }
                }
                this.pendingReq = this.client.slidingSync(reqBody, this.proxyBaseUrl, this.abortController.signal);
                resp = await this.pendingReq;
                currentPos = resp.pos;
                // update what we think we're subscribed to.
                for (const roomId of newSubscriptions) {
                    this.confirmedRoomSubscriptions.add(roomId);
                }
                for (const roomId of unsubscriptions) {
                    this.confirmedRoomSubscriptions.delete(roomId);
                }
                // mark all these lists as having been sent as sticky so we don't keep sending sticky params
                this.lists.forEach((l) => {
                    l.setModified(false);
                });
                // set default empty values so we don't need to null check
                resp.lists = resp.lists ?? {};
                resp.rooms = resp.rooms ?? {};
                resp.extensions = resp.extensions ?? {};
                Object.keys(resp.lists).forEach((key: string) => {
                    const list = this.lists.get(key);
                    if (!list || !resp) {
                        return;
                    }
                    list.joinedCount = resp.lists[key].count;
                });
                this.invokeLifecycleListeners(SlidingSyncState.RequestFinished, resp);
            } catch (err) {
                if ((<HTTPError>err).httpStatus) {
                    this.invokeLifecycleListeners(SlidingSyncState.RequestFinished, null, <Error>err);
                    if ((<HTTPError>err).httpStatus === 400) {
                        // session probably expired TODO: assign an errcode
                        // so drop state and re-request
                        this.resetup();
                        currentPos = undefined;
                        await sleep(50); // in case the 400 was for something else; don't tightloop
                        continue;
                    } // else fallthrough to generic error handling
                } else if (this.needsResend || (<Error>err).name === "AbortError") {
                    continue; // don't sleep as we caused this error by abort()ing the request.
                }
                logger.error(err);
                await sleep(5000);
            }
            if (!resp) {
                continue;
            }
            await this.onPreExtensionsResponse(resp.extensions);

            for (const roomId in resp.rooms) {
                await this.invokeRoomDataListeners(roomId, resp!.rooms[roomId]);
            }

            this.invokeLifecycleListeners(SlidingSyncState.Complete, resp);
            await this.onPostExtensionsResponse(resp.extensions);
        }
    }
}

const difference = (setA: Set<string>, setB: Set<string>): Set<string> => {
    const diff = new Set(setA);
    for (const elem of setB) {
        diff.delete(elem);
    }
    return diff;
};
