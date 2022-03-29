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

import { logger } from './logger';
import { IAbortablePromise } from "./@types/partials";
import { MatrixClient } from "./client";
import { IRoomEvent, IStateEvent } from "./sync-accumulator";
import { TypedEventEmitter } from "./models//typed-event-emitter";

const DEBUG = true;

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
const BUFFER_PERIOD_MS = 10 * 1000;

function debuglog(...params) {
    if (!DEBUG) {
        return;
    }
    logger.log(...params);
}

/**
 * Represents a subscription to a room or set of rooms. Controls which events are returned.
 */
export interface MSC3575RoomSubscription {
    required_state?: string[][];
    timeline_limit?: number;
}

/**
 * Controls which rooms are returned in a given list.
 */
export interface MSC3575Filter {
    is_dm?: boolean;
    is_encrypted?: boolean;
    is_invite?: boolean;
    is_tombstoned?: boolean;
    room_name_like?: string;
}

/**
 * Represents a list subscription.
 */
export interface MSC3575List extends MSC3575RoomSubscription {
    ranges: number[][];
    sort?: string[];
    filters?: MSC3575Filter;
}

/**
 * A complete Sliding Sync request.
 */
export interface MSC3575SlidingSyncRequest {
    // json body params
    lists?: MSC3575List[];
    unsubscribe_rooms?: string[];
    room_subscriptions?: Record<string, MSC3575RoomSubscription>;
    extensions?: object;

    // query params
    pos?: string;
    timeout?: number;
    clientTimeout?: number;
}

export interface MSC3575RoomData {
    name: string;
    required_state: IStateEvent[];
    timeline: (IRoomEvent | IStateEvent)[];
    notification_count?: number;
    highlight_count?: number;
    invite_state?: IStateEvent[];
    initial?: boolean;
    limited?: boolean;
    room_id: string;
}

/**
 * A complete Sliding Sync response
 */
export interface MSC3575SlidingSyncResponse {
    pos: string;
    ops: object[];
    counts: number[];
    room_subscriptions: Record<string, MSC3575RoomData>;
    extensions: object;
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
 * multiple sliding windows, and maintains the index->room_id mapping.
 */
class SlidingList {
    private list: MSC3575List;
    private isModified: boolean;

    // returned data
    roomIndexToRoomId: Record<number, string>;
    joinedCount: number;

    /**
     * Construct a new sliding list.
     * @param {MSC3575List} list The range, sort and filter values to use for this list.
     */
    constructor(list: MSC3575List) {
        this.replaceList(list);
    }

    /**
     * Mark this list as modified or not. Modified lists will return sticky params with calls to getList.
     * This is useful for the first time the list is sent, or if the list has changed in some way.
     * @param modified True to mark this list as modified so all sticky parameters will be re-sent.
     */
    setModified(modified: boolean) {
        this.isModified = modified;
    }

    /**
     * Update the list range for this list. Does not affect modified status as list ranges are non-sticky.
     * @param newRanges The new ranges for the list
     */
    updateListRange(newRanges: number[][]) {
        this.list.ranges = JSON.parse(JSON.stringify(newRanges));
    }

    /**
     * Replace list parameters. All fields will be replaced with the new list parameters.
     * @param list The new list parameters
     */
    replaceList(list: MSC3575List) {
        list.filters = list.filters || {};
        list.ranges = list.ranges || [];
        this.list = JSON.parse(JSON.stringify(list));
        this.isModified = true;

        // reset values as the join count may be very different (if filters changed) including the rooms
        // (e.g sort orders or sliding window ranges changed)

        // the constantly changing sliding window ranges. Not an array for performance reasons
        // E.g tracking ranges 0-99, 500-599, we don't want to have a 600 element array
        this.roomIndexToRoomId = {};
        // the total number of joined rooms according to the server, always >= len(roomIndexToRoomId)
        this.joinedCount = 0;
    }

    /**
     * Return a copy of the list suitable for a request body.
     * @param {boolean} forceIncludeAllParams True to forcibly include all params even if the list
     * hasn't been modified. Callers may want to do this if they are modifying the list prior to calling
     * updateList.
     */
    getList(forceIncludeAllParams: boolean): MSC3575List {
        let list = {
            ranges: JSON.parse(JSON.stringify(this.list.ranges)),
        };
        if (this.isModified || forceIncludeAllParams) {
            list = JSON.parse(JSON.stringify(this.list));
        }
        return list;
    }

    /**
     * Check if a given index is within the list range. This is required even though the /sync API
     * provides explicit updates with index positions because of the following situation:
     *   0 1 2 3 4 5 6 7 8   indexes
     *   a b c       d e f   COMMANDS: SYNC 0 2 a b c; SYNC 6 8 d e f;
     *   a b c       d _ f   COMMAND: DELETE 7;
     *   e a b c       d f   COMMAND: INSERT 0 e;
     *   c=3 is wrong as we are not tracking it, ergo we need to see if `i` is in range else drop it
     * @param i The index to check
     * @returns True if the index is within a sliding window
     */
    isIndexInRange(i: number): boolean {
        for (const r of this.list.ranges) {
            if (r[0] <= i && i <= r[1]) {
                return true;
            }
        }
        return false;
    }
}


/**
 * When onResponse extensions should be invoked: before or after processing the main response.
 */
 export enum ExtensionState {
    // Call onResponse before processing the response body. This is useful when your extension is
    // preparing the ground for the response body e.g processing to-device messages before the
    // encrypted event arrives.
    PreProcess = "ExtState.PreProcess",
    // Call onResponse after processing the response body. This is useful when your extension is
    // decorating data from the client and you rely on MatrixClient.getRoom returning the Room object
    // e.g room account data.
    PostProcess = "ExtState.PostProcess",
}

/**
 * An interface that must be satisfied to register extensions
 */
export interface Extension {
    /**
     * The extension name to go under 'extensions' in the request body.
     * @returns The JSON key.
     */
    name(): string
    /**
     * A function which is called when the request JSON is being formed.
     * Returns the data to insert under this key.
     * @param isInitial True when this is part of the initial request (send sticky params)
     * @returns The request JSON to send.
     */
    onRequest(isInitial: boolean): object
    /**
     * A function which is called when there is response JSON under this extension.
     * @param data The response JSON under the extension name.
     */
    onResponse(data: object)
    /**
     * Controls when onResponse should be called.
     * @returns The state when it should be called.
     */
    when(): ExtensionState
}

/**
 * Events which can be fired by the SlidingSync class. These are designed to provide different levels
 * of information when processing sync responses.
 *  - RoomData: concerns rooms, useful for SlidingSyncSdk to update its knowledge of rooms.
 *  - Lifecycle: concerns callbacks at various well-defined points in the sync process.
 *  - List: concerns lists, useful for UI layers to re-render room lists.
 * Specifically, the order of event invocation is:
 *  - Lifecycle (state=RequestFinished)
 *  - RoomData (N times)
 *  - Lifecycle (state=Complete)
 *  - List (at most once per list)
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
     *  - SlidingSyncState.Complete: Fires after all SlidingSyncEvent.RoomData have been fired but before
     * SlidingSyncEvent.List.
     */
    Lifecycle = "SlidingSync.Lifecycle",
    /**
     * This event fires whenever there has been a change to this list index. It fires exactly once
     * per list, even if there were multiple operations for the list.
     * It fires AFTER Lifecycle and RoomData events.
     */
    List = "SlidingSync.List",
}

export type SlidingSyncEventHandlerMap = {
    [SlidingSyncEvent.RoomData]: (roomId: string, roomData: MSC3575RoomData) => void;
    [SlidingSyncEvent.Lifecycle]: (state: SlidingSyncState, resp: MSC3575SlidingSyncResponse, err: Error) => void;
    [SlidingSyncEvent.List]: (
        listIndex: number, joinedCount: number, roomIndexToRoomId: Record<number, string>,
    ) => void;
};

/**
 * SlidingSync is a high-level data structure which controls the majority of sliding sync.
 * It has no hooks into JS SDK with the exception of needing a MatrixClient to perform the HTTP request.
 * This means this class (and everything it uses) can be used in isolation from JS SDK if needed.
 * To hook this up with the JS SDK, you need to use SlidingSyncSdk.
 */
export class SlidingSync extends TypedEventEmitter<SlidingSyncEvent, SlidingSyncEventHandlerMap> {
    private proxyBaseUrl: string;
    private lists: SlidingList[];
    private listModifiedCount: number;
    private client: MatrixClient;
    private timeoutMS: number;
    private terminated: boolean;
    // flag set when resend() is called because we cannot rely on detecting AbortError in JS SDK :(
    private needsResend: boolean;
    // map of extension name to req/resp handler
    private extensions: Record<string, Extension>;

    private roomSubscriptionInfo: MSC3575RoomSubscription;
    private desiredRoomSubscriptions: Set<string>; // the *desired* room subscriptions
    private confirmedRoomSubscriptions: Set<string>;

    private pendingReq?: IAbortablePromise<MSC3575SlidingSyncResponse>;

    /**
     * Create a new sliding sync instance
     * @param {string} proxyBaseUrl The base URL of the sliding sync proxy
     * @param {MSC3575List[]} lists The lists to use for sliding sync.
     * @param {MSC3575RoomSubscription} subInfo The params to use for room subscriptions.
     * @param {MatrixClient} client The client to use for /sync calls.
     * @param {number} timeoutMS The number of milliseconds to wait for a response.
     */
    constructor(
        proxyBaseUrl: string, lists: MSC3575List[], subInfo: MSC3575RoomSubscription,
        client: MatrixClient, timeoutMS: number,
    ) {
        super();
        this.proxyBaseUrl = proxyBaseUrl;
        this.timeoutMS = timeoutMS;
        this.lists = lists.map((l) => { return new SlidingList(l); });
        this.client = client;
        this.roomSubscriptionInfo = subInfo;
        this.terminated = false;
        this.desiredRoomSubscriptions = new Set();
        this.confirmedRoomSubscriptions = new Set();
        this.pendingReq = null;
        this.listModifiedCount = 0;
        this.needsResend = false;
        this.extensions = {};
    }

    /**
     * Get the length of the sliding lists.
     * @returns The number of lists in the sync request
     */
    listLength(): number {
        return this.lists.length;
    }

    /**
     * Get the room data for a list.
     * @param index The list index
     * @returns The list data which contains the rooms in this list
     */
    getListData(index: number): {joinedCount: number, roomIndexToRoomId: Record<number, string>} {
        if (!this.lists[index]) {
            return null;
        }
        return {
            joinedCount: this.lists[index].joinedCount,
            roomIndexToRoomId: Object.assign({}, this.lists[index].roomIndexToRoomId),
        }
    }

    /**
     * Get the full list parameters for a list index. This function is provided for callers to use
     * in conjunction with setList to update fields on an existing list.
     * @param index The list index to get the list for.
     * @returns A copy of the list or undefined.
     */
    getList(index: number): MSC3575List {
        if (!this.lists[index]) {
            return null;
        }
        return this.lists[index].getList(true);
    }

    /**
     * Set new ranges for an existing list. Calling this function when _only_ the ranges have changed
     * is more efficient than calling setList(index,list) as this function won't resend sticky params,
     * whereas setList always will.
     * @param index The list index to modify
     * @param ranges The new ranges to apply.
     */
    setListRanges(index: number, ranges: number[][]) {
        this.lists[index].updateListRange(ranges);
        this.resend();
    }

    /**
     * Add or replace a list. Calling this function will interrupt the /sync request to resend new
     * lists.
     * @param index The index to modify
     * @param list The new list parameters.
     */
    setList(index: number, list: MSC3575List) {
        if (this.lists[index]) {
            this.lists[index].replaceList(list);
        } else {
            this.lists[index] = new SlidingList(list);
        }
        this.listModifiedCount += 1;
        this.resend();
    }

    /**
     * Get the room subscriptions for the sync API.
     * @returns A copy of the desired room subscriptions.
     */
    getRoomSubscriptions(): Set<string> {
        return new Set(Array.from(this.desiredRoomSubscriptions));
    }

    /**
     * Modify the room subscriptions for the sync API. Calling this function will interrupt the
     * /sync request to resend new subscriptions. If the /sync stream has not started, this will
     * prepare the room subscriptions for when start() is called.
     * @param s The new desired room subscriptions.
     */
    modifyRoomSubscriptions(s: Set<string>) {
        this.desiredRoomSubscriptions = s;
        this.resend();
    }

    /**
     * Modify which events to retrieve for room subscriptions. Invalidates all room subscriptions
     * such that they will be sent up afresh.
     * @param rs The new room subscription fields to fetch.
     */
    modifyRoomSubscriptionInfo(rs: MSC3575RoomSubscription) {
        this.roomSubscriptionInfo = rs;
        this.confirmedRoomSubscriptions = new Set<string>();
        this.resend();
    }

    /**
     * Register an extension to send with the /sync request.
     * @param ext The extension to register.
     */
    registerExtension(ext: Extension) {
        if (this.extensions[ext.name()]) {
            throw new Error(`registerExtension: ${ext.name()} already exists as an extension`);
        }
        this.extensions[ext.name()] = ext;
    }

    private getExtensionRequest(isInitial: boolean): object {
        const ext = {};
        Object.keys(this.extensions).forEach((extName) => {
            ext[extName] = this.extensions[extName].onRequest(isInitial);
        });
        return ext;
    }

    private onPreExtensionsResponse(ext: object) {
        Object.keys(ext).forEach((extName) => {
            if (this.extensions[extName].when() == ExtensionState.PreProcess) {
                this.extensions[extName].onResponse(ext[extName]);
            }
        });
    }

    private onPostExtensionsResponse(ext: object) {
        Object.keys(ext).forEach((extName) => {
            if (this.extensions[extName].when() == ExtensionState.PostProcess) {
                this.extensions[extName].onResponse(ext[extName]);
            }
        });
    }

    /**
     * Invoke all attached room data listeners.
     * @param {string} roomId The room which received some data.
     * @param {object} roomData The raw sliding sync response JSON.
     */
    private invokeRoomDataListeners(roomId: string, roomData: MSC3575RoomData) {
        if (!roomData.required_state) { roomData.required_state = []; }
        if (!roomData.timeline) { roomData.timeline = []; }
        if (!roomData.room_id) { roomData.room_id = roomId; }
        this.emit(SlidingSyncEvent.RoomData, roomId, roomData);
    }

    /**
     * Invoke all attached lifecycle listeners.
     * @param {SlidingSyncState} state The Lifecycle state
     * @param {object} resp The raw sync response JSON
     * @param {Error?} err Any error that occurred when making the request e.g network errors.
     */
    private invokeLifecycleListeners(state: SlidingSyncState, resp: MSC3575SlidingSyncResponse, err?: Error) {
        this.emit(SlidingSyncEvent.Lifecycle, state, resp, err);
    }

    /**
     * Resend a Sliding Sync request. Used when something has changed in the request.
     */
    resend(): void {
        this.needsResend = true;
        if (this.pendingReq) {
            this.pendingReq.abort();
        }
    }

    /**
     * Stop syncing with the server.
     */
    stop(): void {
        this.terminated = true;
        if (this.pendingReq) {
            this.pendingReq.abort();
        }
        // remove all listeners so things can be GC'd
        this.removeAllListeners(SlidingSyncEvent.Lifecycle);
        this.removeAllListeners(SlidingSyncEvent.List);
        this.removeAllListeners(SlidingSyncEvent.RoomData);
    }

    /**
     * Start syncing with the server. Blocks until stopped.
     */
    async start() {
        let currentPos;
        while (!this.terminated) {
            this.needsResend = false;
            let doNotUpdateList = false;
            let resp;
            try {
                const listModifiedCount = this.listModifiedCount;
                const reqBody: MSC3575SlidingSyncRequest = {
                    lists: this.lists.map((l) => {
                        return l.getList(false);
                    }),
                    pos: currentPos,
                    timeout: this.timeoutMS,
                    clientTimeout: this.timeoutMS + BUFFER_PERIOD_MS,
                    extensions: this.getExtensionRequest(currentPos === undefined),
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
                        reqBody.room_subscriptions[roomId] = this.roomSubscriptionInfo;
                    }
                }
                this.pendingReq = this.client.slidingSync(reqBody, this.proxyBaseUrl);
                resp = await this.pendingReq;
                debuglog(resp);
                currentPos = resp.pos;
                // update what we think we're subscribed to.
                for (const roomId of newSubscriptions) {
                    this.confirmedRoomSubscriptions.add(roomId);
                }
                for (const roomId of unsubscriptions) {
                    this.confirmedRoomSubscriptions.delete(roomId);
                }
                if (listModifiedCount !== this.listModifiedCount) {
                    // the lists have been modified whilst we were waiting for 'await' to return, but the abort()
                    // call did nothing. It is NOT SAFE to modify the list array now. We'll process the response but
                    // not update list pointers.
                    debuglog("list modified during await call, not updating list");
                    doNotUpdateList = true;
                }
                // mark all these lists as having been sent as sticky so we don't keep sending sticky params
                this.lists.forEach((l) => {
                    l.setModified(false);
                });
                if (!resp.ops) {
                    resp.ops = [];
                }
                if (!resp.room_subscriptions) {
                    resp.room_subscriptions = {};
                }
                if (!resp.extensions) {
                    resp.extensions = {};
                }
                if (resp.counts) {
                    resp.counts.forEach((count, index) => {
                        this.lists[index].joinedCount = count;
                    });
                }
                this.invokeLifecycleListeners(
                    SlidingSyncState.RequestFinished,
                    resp,
                );
            } catch (err) {
                if (err.httpStatus) {
                    this.invokeLifecycleListeners(
                        SlidingSyncState.RequestFinished,
                        null,
                        err,
                    );
                    await sleep(3000);
                } else if (this.needsResend || err === "aborted") {
                    // don't sleep as we caused this error by abort()ing the request.
                    // we check for 'aborted' because that's the error Jest returns and without it
                    // we get warnings about not exiting fast enough.
                    continue;
                } else {
                    debuglog(err);
                    await sleep(3000);
                }
            }
            if (!resp) {
                continue;
            }
            this.onPreExtensionsResponse(resp.extensions);

            Object.keys(resp.room_subscriptions).forEach((roomId) => {
                this.invokeRoomDataListeners(
                    roomId,
                    resp.room_subscriptions[roomId],
                );
            });

            const listIndexesWithUpdates: Set<number> = new Set();
            // TODO: clear gapIndex immediately after next op to avoid a genuine DELETE shifting incorrectly e.g leaving a room
            const gapIndexes = {};
            resp.counts.forEach((count, index) => {
                gapIndexes[index] = -1;
            });
            if (!doNotUpdateList) {
                resp.ops.forEach((op) => {
                    if (op.list != null) {
                        listIndexesWithUpdates.add(op.list);
                    }
                    if (op.op === "DELETE") {
                        debuglog("DELETE", op.list, op.index, ";");
                        delete this.lists[op.list].roomIndexToRoomId[op.index];
                        gapIndexes[op.list] = op.index;
                    } else if (op.op === "INSERT") {
                        debuglog(
                            "INSERT",
                            op.list,
                            op.index,
                            op.room.room_id,
                            ";",
                        );
                        if (this.lists[op.list].roomIndexToRoomId[op.index]) {
                            const gapIndex = gapIndexes[op.list];
                            // something is in this space, shift items out of the way
                            if (gapIndex < 0) {
                                debuglog(
                                    "cannot work out where gap is, INSERT without previous DELETE! List: ",
                                    op.list,
                                );
                                return;
                            }
                            //  0,1,2,3  index
                            // [A,B,C,D]
                            //   DEL 3
                            // [A,B,C,_]
                            //   INSERT E 0
                            // [E,A,B,C]
                            // gapIndex=3, op.index=0
                            if (gapIndex > op.index) {
                                // the gap is further down the list, shift every element to the right
                                // starting at the gap so we can just shift each element in turn:
                                // [A,B,C,_] gapIndex=3, op.index=0
                                // [A,B,C,C] i=3
                                // [A,B,B,C] i=2
                                // [A,A,B,C] i=1
                                // Terminate. We'll assign into op.index next.
                                for (let i = gapIndex; i > op.index; i--) {
                                    if (this.lists[op.list].isIndexInRange(i)) {
                                        this.lists[op.list].roomIndexToRoomId[i] =
                                            this.lists[op.list].roomIndexToRoomId[
                                                i - 1
                                            ];
                                    }
                                }
                            } else if (gapIndex < op.index) {
                                // the gap is further up the list, shift every element to the left
                                // starting at the gap so we can just shift each element in turn
                                for (let i = gapIndex; i < op.index; i++) {
                                    if (this.lists[op.list].isIndexInRange(i)) {
                                        this.lists[op.list].roomIndexToRoomId[i] =
                                            this.lists[op.list].roomIndexToRoomId[
                                                i + 1
                                            ];
                                    }
                                }
                            }
                        }
                        this.lists[op.list].roomIndexToRoomId[op.index] =
                            op.room.room_id;
                        this.invokeRoomDataListeners(op.room.room_id, op.room);
                    } else if (op.op === "UPDATE") {
                        debuglog(
                            "UPDATE",
                            op.list,
                            op.index,
                            op.room.room_id,
                            ";",
                        );
                        this.invokeRoomDataListeners(op.room.room_id, op.room);
                    } else if (op.op === "SYNC") {
                        const syncRooms = [];
                        const startIndex = op.range[0];
                        for (let i = startIndex; i <= op.range[1]; i++) {
                            const r = op.rooms[i - startIndex];
                            if (!r) {
                                break; // we are at the end of list
                            }
                            this.lists[op.list].roomIndexToRoomId[i] = r.room_id;
                            syncRooms.push(r.room_id);
                            this.invokeRoomDataListeners(r.room_id, r);
                        }
                        debuglog(
                            "SYNC",
                            op.list,
                            op.range[0],
                            op.range[1],
                            syncRooms.join(" "),
                            ";",
                        );
                    } else if (op.op === "INVALIDATE") {
                        const invalidRooms = [];
                        const startIndex = op.range[0];
                        for (let i = startIndex; i <= op.range[1]; i++) {
                            invalidRooms.push(
                                this.lists[op.list].roomIndexToRoomId[i],
                            );
                            delete this.lists[op.list].roomIndexToRoomId[i];
                        }
                        debuglog(
                            "INVALIDATE",
                            op.list,
                            op.range[0],
                            op.range[1],
                            ";",
                        );
                    }
                });
            }
            this.invokeLifecycleListeners(SlidingSyncState.Complete, resp);
            this.onPostExtensionsResponse(resp.extensions);
            listIndexesWithUpdates.forEach((i) => {
                this.emit(
                    SlidingSyncEvent.List,
                    i, this.lists[i].joinedCount, Object.assign({}, this.lists[i].roomIndexToRoomId),
                );
            });
        }
    }
}

const difference = (setA: Set<string>, setB: Set<string>): Set<string> => {
    const _difference = new Set(setA);
    for (const elem of setB) {
        _difference.delete(elem);
    }
    return _difference;
};

const sleep = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};
