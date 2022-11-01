/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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

import { EventType } from "../@types/event";
import { Room } from "../models/room";
import { User } from "../models/user";
import { IEvent, MatrixEvent } from "../models/event";
import { Filter } from "../filter";
import { RoomSummary } from "../models/room-summary";
import { IMinimalEvent, IRooms, ISyncResponse } from "../sync-accumulator";
import { IStartClientOpts } from "../client";
import { IStateEventWithRoomId } from "../@types/search";
import { IndexedToDeviceBatch, ToDeviceBatchWithTxnId } from "../models/ToDeviceMessage";
import { EventEmitterEvents } from "../models/typed-event-emitter";

export interface ISavedSync {
    nextBatch: string;
    roomsData: IRooms;
    accountData: IMinimalEvent[];
}

/**
 * A store for most of the data js-sdk needs to store, apart from crypto data
 */
export interface IStore {
    readonly accountData: Record<string, MatrixEvent>; // type : content

    // XXX: The indexeddb store exposes a non-standard emitter for the "degraded" event
    // for when it falls back to being a memory store due to errors.
    on?: (event: EventEmitterEvents | "degraded", handler: (...args: any[]) => void) => void;

    /** @return {Promise<boolean>} whether or not the database was newly created in this session. */
    isNewlyCreated(): Promise<boolean>;

    /**
     * Get the sync token.
     * @return {string}
     */
    getSyncToken(): string | null;

    /**
     * Set the sync token.
     * @param {string} token
     */
    setSyncToken(token: string): void;

    /**
     * Store the given room.
     * @param {Room} room The room to be stored. All properties must be stored.
     */
    storeRoom(room: Room): void;

    /**
     * Retrieve a room by its' room ID.
     * @param {string} roomId The room ID.
     * @return {Room} The room or null.
     */
    getRoom(roomId: string): Room | null;

    /**
     * Retrieve all known rooms.
     * @return {Room[]} A list of rooms, which may be empty.
     */
    getRooms(): Room[];

    /**
     * Permanently delete a room.
     * @param {string} roomId
     */
    removeRoom(roomId: string): void;

    /**
     * Retrieve a summary of all the rooms.
     * @return {RoomSummary[]} A summary of each room.
     */
    getRoomSummaries(): RoomSummary[];

    /**
     * Store a User.
     * @param {User} user The user to store.
     */
    storeUser(user: User): void;

    /**
     * Retrieve a User by its' user ID.
     * @param {string} userId The user ID.
     * @return {User} The user or null.
     */
    getUser(userId: string): User | null;

    /**
     * Retrieve all known users.
     * @return {User[]} A list of users, which may be empty.
     */
    getUsers(): User[];

    /**
     * Retrieve scrollback for this room.
     * @param {Room} room The matrix room
     * @param {number} limit The max number of old events to retrieve.
     * @return {Array<Object>} An array of objects which will be at most 'limit'
     * length and at least 0. The objects are the raw event JSON.
     */
    scrollback(room: Room, limit: number): MatrixEvent[];

    /**
     * Store events for a room.
     * @param {Room} room The room to store events for.
     * @param {Array<MatrixEvent>} events The events to store.
     * @param {string} token The token associated with these events.
     * @param {boolean} toStart True if these are paginated results.
     */
    storeEvents(room: Room, events: MatrixEvent[], token: string, toStart: boolean): void;

    /**
     * Store a filter.
     * @param {Filter} filter
     */
    storeFilter(filter: Filter): void;

    /**
     * Retrieve a filter.
     * @param {string} userId
     * @param {string} filterId
     * @return {?Filter} A filter or null.
     */
    getFilter(userId: string, filterId: string): Filter | null;

    /**
     * Retrieve a filter ID with the given name.
     * @param {string} filterName The filter name.
     * @return {?string} The filter ID or null.
     */
    getFilterIdByName(filterName: string): string | null;

    /**
     * Set a filter name to ID mapping.
     * @param {string} filterName
     * @param {string} filterId
     */
    setFilterIdByName(filterName: string, filterId?: string): void;

    /**
     * Store user-scoped account data events
     * @param {Array<MatrixEvent>} events The events to store.
     */
    storeAccountDataEvents(events: MatrixEvent[]): void;

    /**
     * Get account data event by event type
     * @param {string} eventType The event type being queried
     */
    getAccountData(eventType: EventType | string): MatrixEvent | undefined;

    /**
     * setSyncData does nothing as there is no backing data store.
     *
     * @param {Object} syncData The sync data
     * @return {Promise} An immediately resolved promise.
     */
    setSyncData(syncData: ISyncResponse): Promise<void>;

    /**
     * We never want to save because we have nothing to save to.
     *
     * @return {boolean} If the store wants to save
     */
    wantsSave(): boolean;

    /**
     * Save does nothing as there is no backing data store.
     */
    save(force?: boolean): void;

    /**
     * Startup does nothing.
     * @return {Promise} An immediately resolved promise.
     */
    startup(): Promise<void>;

    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync(): Promise<ISavedSync | null>;

    /**
     * @return {Promise} If there is a saved sync, the nextBatch token
     * for this sync, otherwise null.
     */
    getSavedSyncToken(): Promise<string | null>;

    /**
     * Delete all data from this store. Does nothing since this store
     * doesn't store anything.
     * @return {Promise} An immediately resolved promise.
     */
    deleteAllData(): Promise<void>;

    /**
     * Returns the out-of-band membership events for this room that
     * were previously loaded.
     * @param {string} roomId
     * @returns {event[]} the events, potentially an empty array if OOB loading didn't yield any new members
     * @returns {null} in case the members for this room haven't been stored yet
     */
    getOutOfBandMembers(roomId: string): Promise<IStateEventWithRoomId[] | null>;

    /**
     * Stores the out-of-band membership events for this room. Note that
     * it still makes sense to store an empty array as the OOB status for the room is
     * marked as fetched, and getOutOfBandMembers will return an empty array instead of null
     * @param {string} roomId
     * @param {event[]} membershipEvents the membership events to store
     * @returns {Promise} when all members have been stored
     */
    setOutOfBandMembers(roomId: string, membershipEvents: IStateEventWithRoomId[]): Promise<void>;

    clearOutOfBandMembers(roomId: string): Promise<void>;

    getClientOptions(): Promise<IStartClientOpts | undefined>;

    storeClientOptions(options: IStartClientOpts): Promise<void>;

    getPendingEvents(roomId: string): Promise<Partial<IEvent>[]>;

    setPendingEvents(roomId: string, events: Partial<IEvent>[]): Promise<void>;

    /**
     * Stores batches of outgoing to-device messages
     */
     saveToDeviceBatches(batch: ToDeviceBatchWithTxnId[]): Promise<void>;

     /**
      * Fetches the oldest batch of to-device messages in the queue
      */
     getOldestToDeviceBatch(): Promise<IndexedToDeviceBatch | null>;

     /**
      * Removes a specific batch of to-device messages from the queue
      */
     removeToDeviceBatch(id: number): Promise<void>;
}
