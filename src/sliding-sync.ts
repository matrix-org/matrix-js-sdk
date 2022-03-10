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

const DEBUG = true;

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
const BUFFER_PERIOD_MS = 10 * 1000;

// Number of consecutive failed syncs that will lead to a syncState of ERROR as opposed
// to RECONNECTING. This is needed to inform the client of server issues when the
// keepAlive is successful but the server /sync fails.
const FAILED_SYNC_ERROR_THRESHOLD = 3;

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
};

/**
 * Controls which rooms are returned in a given list.
 */
export interface MSC3575Filter {
    is_dm?: boolean;
    is_encrypted?: boolean;
    is_invite?: boolean;
    room_name_like?: string;
};

/**
 * Represents a list subscription.
 */
export interface MSC3575List extends MSC3575RoomSubscription {
    ranges: number[][];
    sort?: string[];
    filters?: MSC3575Filter;
};

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
};

/**
 * A complete Sliding Sync response
 */
export interface MSC3575SlidingSyncResponse {
    pos: string;
    ops: object[];
    counts: number[];
    room_subscriptions: Record<string, object>;
    extensions: object;
};

export enum SlidingSyncState {
    RequestFinished = "FINISHED",
    Complete = "COMPLETE",
}

/**
 * SlidingList represents a single list in sliding sync. The list can have filters, multiple sliding
 * windows, and maintains the index->room_id mapping.
 */
 export class SlidingList {
    list: MSC3575List;
    defaultListRange: number[][];

    roomIndexToRoomId: Record<number,string>;
    joinedCount: number;

    /**
     * Construct a new sliding list.
     * @param {MSC3575List} list The default list values to apply for this list, including default
     * ranges, required_state, timeline_limit, etc.
     */
    constructor(list: MSC3575List, defaultListRange: number[][]) {
        defaultListRange = defaultListRange || [[0,20]];
        list.filters = list.filters || {};
        list.ranges = list.ranges || defaultListRange;
        this.list = list;
        this.defaultListRange = defaultListRange;
        
        // the constantly changing sliding window ranges. Not an array for performance reasons
        // E.g tracking ranges 0-99, 500-599, we don't want to have a 600 element array
        this.roomIndexToRoomId = {};
        // the total number of joined rooms according to the server, always >= len(roomIndexToRoomId)
        this.joinedCount = 0;
    }

    /**
     * Return a copy of the list.
     * @param {boolean} includeSticky If true, includes sticky params. Else skips them.
     */
    getList(includeSticky: boolean): MSC3575List {
        if (!includeSticky) {
            // only the ranges are non-sticky
            return {
                ranges: JSON.parse(JSON.stringify(this.list.ranges)),
            };
        }
        return JSON.parse(JSON.stringify(this.list));
    }

    /**
     * Modify the filters on this list. The filters provided are copied.
     * @param {object} filters The sliding sync filters to apply e.g { is_dm: true }.
     */
    setFilters(filters: object) {
        this.list.filters = Object.assign({}, filters);
        // if we are viewing a window at 100-120 and then we filter down to 5 total rooms,
        // we'll end up showing nothing. Therefore, if the filters change (e.g room name filter)
        // reset the range back to 0-20.
        this.list.ranges = JSON.parse(JSON.stringify(this.defaultListRange));
        // Wipe the index to room ID map as the filters have changed which will invalidate these.
        this.roomIndexToRoomId = {};
    }
}

/**
 * SlidingSync is a high-level data structure which controls the majority of sliding sync.
 * It has no hooks into JS SDK with the exception of needing a MatrixClient to perform the HTTP request.
 * This means this class (and everything it uses) can be yanked somewhere else if need be.
 */
export class SlidingSync {
    proxyBaseUrl: string;
    lists: SlidingList[];
    client: MatrixClient;
    timeoutMS: number;
    terminated: boolean;
    roomSubscriptions: Set<string>;
    roomSubscriptionInfo: MSC3575RoomSubscription;
    roomDataCallbacks: Function[];
    lifecycleCallbacks: Function[];

    pendingReq?: IAbortablePromise<MSC3575SlidingSyncResponse>;

    /**
     * Create a new sliding sync instance
     * @param {string} proxyBaseUrl The base URL of the sliding sync proxy
     * @param {SlidingList[]} lists The lists to use for sliding sync.
     * @param {MSC3575RoomSubscription} subInfo The params to use for room subscriptions.
     * @param {MatrixClient} client The client to use for /sync calls.
     * @param {number} timeoutMS The number of milliseconds to wait for a response.
     */
    constructor(proxyBaseUrl: string, lists: SlidingList[], subInfo: MSC3575RoomSubscription, client: MatrixClient, timeoutMS: number) {
        this.proxyBaseUrl = proxyBaseUrl;
        this.timeoutMS = timeoutMS;
        this.lists = lists;
        this.client = client;
        this.roomSubscriptionInfo = subInfo;
        this.terminated = false;
        this.roomSubscriptions = new Set(); // the *desired* room subscriptions
        this.roomDataCallbacks = [];
        this.lifecycleCallbacks = [];
        this.pendingReq = null;
    }

    /**
     * Listen for high-level room events on the sync connection
     * @param {function} callback The callback to invoke.
     */
    addRoomDataListener(callback) {
        this.roomDataCallbacks.push(callback);
    }

    /**
     * Listen for high-level lifecycle events on the sync connection
     * @param {function} callback The callback to invoke.
     */
    addLifecycleListener(callback) {
        this.lifecycleCallbacks.push(callback);
    }

    /**
     * Invoke all attached room data listeners.
     * @param {string} roomId The room which received some data.
     * @param {object} roomData The raw sliding sync response JSON.
     */
    private _invokeRoomDataListeners(roomId: string, roomData: object) {
        this.roomDataCallbacks.forEach((callback) => {
            callback(roomId, roomData);
        });
    }

    /**
     * Invoke all attached lifecycle listeners.
     * @param {SlidingSyncState} state The Lifecycle state
     * @param {object} resp The raw sync response JSON
     * @param {Error?} err Any error that occurred when making the request e.g network errors.
     */
    private _invokeLifecycleListeners(state: SlidingSyncState, resp: object, err?: Error) {
        this.lifecycleCallbacks.forEach((callback) => {
            callback(state, resp, err);
        });
    }

    /**
     * Resend a Sliding Sync request. Used when something has changed in the request.
     */
    resend() {
        if (this.pendingReq) {
            this.pendingReq.abort();
        }
    }

    /**
     * Stop syncing with the server.
     */
    stop() {
        this.terminated = true;
        if (this.pendingReq) {
            this.pendingReq.abort();
        }
    }

    /**
     * Start syncing with the server. Blocks until stopped.
     */
    async start() {
        let currentPos;
        let confirmedSubscriptions: Set<string> = new Set(); // subs we've confirmed we're tracking from the server
        while (!this.terminated) {
            let resp;
            try {
                // these fields are always required
                let reqBody: MSC3575SlidingSyncRequest = {
                    lists: this.lists.map((l) => {
                        // include sticky params if there is no current pos (first request)
                        return l.getList(!currentPos);
                    }),
                    pos: currentPos,
                    timeout: this.timeoutMS,
                    clientTimeout: this.timeoutMS + BUFFER_PERIOD_MS,
                };
                // check if we are (un)subscribing to a room and modify request this one time for it
                const newSubscriptions = difference(this.roomSubscriptions, confirmedSubscriptions);
                const unsubscriptions = difference(confirmedSubscriptions, this.roomSubscriptions);
                if (unsubscriptions.size > 0) {
                    reqBody.unsubscribe_rooms = Array.from(unsubscriptions);
                }
                if (newSubscriptions.size > 0) {
                    reqBody.room_subscriptions = {};
                    for (let roomId of newSubscriptions) {
                        reqBody.room_subscriptions[roomId] = this.roomSubscriptionInfo;
                    }
                }
                this.pendingReq = this.client.slidingSync(reqBody, this.proxyBaseUrl);
                let resp = await this.pendingReq;
                currentPos = resp.pos;
                // update what we think we're subscribed to.
                for (let roomId of newSubscriptions) {
                    confirmedSubscriptions.add(roomId);
                }
                for (let roomId of unsubscriptions) {
                    confirmedSubscriptions.delete(roomId);
                }
                if (!resp.ops) {
                    resp.ops = [];
                }
                if (resp.counts) {
                    resp.counts.forEach((count, index) => {
                        this.lists[index].joinedCount = count;
                    });
                }
                this._invokeLifecycleListeners(
                    SlidingSyncState.RequestFinished,
                    resp
                );
            } catch (err) {
                if (err.httpStatus) {
                    this._invokeLifecycleListeners(
                        SlidingSyncState.RequestFinished,
                        null,
                        err
                    );
                    await sleep(3000);
                }
            }
            if (!resp) {
                continue;
            }

            Object.keys(resp.room_subscriptions).forEach((roomId) => {
                this._invokeRoomDataListeners(
                    roomId,
                    resp.room_subscriptions[roomId]
                );
            });

            // TODO: clear gapIndex immediately after next op to avoid a genuine DELETE shifting incorrectly e.g leaving a room
            let gapIndexes = {};
            resp.counts.forEach((count, index) => {
                gapIndexes[index] = -1;
            });
            resp.ops.forEach((op) => {
                if (op.op === "DELETE") {
                    console.log("DELETE", op.list, op.index, ";");
                    delete this.lists[op.list].roomIndexToRoomId[op.index];
                    gapIndexes[op.list] = op.index;
                } else if (op.op === "INSERT") {
                    console.log(
                        "INSERT",
                        op.list,
                        op.index,
                        op.room.room_id,
                        ";"
                    );
                    if (this.lists[op.list].roomIndexToRoomId[op.index]) {
                        const gapIndex = gapIndexes[op.list];
                        // something is in this space, shift items out of the way
                        if (gapIndex < 0) {
                            console.log(
                                "cannot work out where gap is, INSERT without previous DELETE! List: ",
                                op.list
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
                                if (indexInRange(this.lists[op.list].list.ranges, i)) {
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
                                if (indexInRange(this.lists[op.list].list.ranges, i)) {
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
                    this._invokeRoomDataListeners(op.room.room_id, op.room);
                } else if (op.op === "UPDATE") {
                    console.log(
                        "UPDATE",
                        op.list,
                        op.index,
                        op.room.room_id,
                        ";"
                    );
                    this._invokeRoomDataListeners(op.room.room_id, op.room);
                } else if (op.op === "SYNC") {
                    let syncRooms = [];
                    const startIndex = op.range[0];
                    for (let i = startIndex; i <= op.range[1]; i++) {
                        const r = op.rooms[i - startIndex];
                        if (!r) {
                            break; // we are at the end of list
                        }
                        this.lists[op.list].roomIndexToRoomId[i] = r.room_id;
                        syncRooms.push(r.room_id);
                        this._invokeRoomDataListeners(r.room_id, r);
                    }
                    console.log(
                        "SYNC",
                        op.list,
                        op.range[0],
                        op.range[1],
                        syncRooms.join(" "),
                        ";"
                    );
                } else if (op.op === "INVALIDATE") {
                    let invalidRooms = [];
                    const startIndex = op.range[0];
                    for (let i = startIndex; i <= op.range[1]; i++) {
                        invalidRooms.push(
                            this.lists[op.list].roomIndexToRoomId[i]
                        );
                        delete this.lists[op.list].roomIndexToRoomId[i];
                    }
                    console.log(
                        "INVALIDATE",
                        op.list,
                        op.range[0],
                        op.range[1],
                        ";"
                    );
                }
            });

            this._invokeLifecycleListeners(SlidingSyncState.Complete, resp);
        }
    }
}

function difference(setA: Set<string>, setB: Set<string>): Set<string> {
    let _difference = new Set(setA)
    for (let elem of setB) {
        _difference.delete(elem)
    }
    return _difference
}

const sleep = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

// SYNC 0 2 a b c; SYNC 6 8 d e f; DELETE 7; INSERT 0 e;
// 0 1 2 3 4 5 6 7 8
// a b c       d e f
// a b c       d _ f
// e a b c       d f  <--- c=3 is wrong as we are not tracking it, ergo we need to see if `i` is in range else drop it
const indexInRange = (ranges, i) => {
    let isInRange = false;
    ranges.forEach((r) => {
        if (r[0] <= i && i <= r[1]) {
            isInRange = true;
        }
    });
    return isInRange;
};