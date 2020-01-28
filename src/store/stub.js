/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

/**
 * This is an internal module.
 * @module store/stub
 */

/**
 * Construct a stub store. This does no-ops on most store methods.
 * @constructor
 */
export class StubStore {
    constructor() {
        this.fromToken = null;
    }
    /** @return {Promise<bool>} whether or not the database was newly created in this session. */
    isNewlyCreated() {
        return Promise.resolve(true);
    }

    /**
     * Get the sync token.
     * @return {string}
     */
    getSyncToken() {
        return this.fromToken;
    }

    /**
     * Set the sync token.
     * @param {string} token
     */
    setSyncToken(token) {
        this.fromToken = token;
    }

    /**
     * No-op.
     * @param {Group} group
     */
    storeGroup(group) {
    }

    /**
     * No-op.
     * @param {string} groupId
     * @return {null}
     */
    getGroup(groupId) {
        return null;
    }

    /**
     * No-op.
     * @return {Array} An empty array.
     */
    getGroups() {
        return [];
    }

    /**
     * No-op.
     * @param {Room} room
     */
    storeRoom(room) {
    }

    /**
     * No-op.
     * @param {string} roomId
     * @return {null}
     */
    getRoom(roomId) {
        return null;
    }

    /**
     * No-op.
     * @return {Array} An empty array.
     */
    getRooms() {
        return [];
    }

    /**
     * Permanently delete a room.
     * @param {string} roomId
     */
    removeRoom(roomId) {
        return;
    }

    /**
     * No-op.
     * @return {Array} An empty array.
     */
    getRoomSummaries() {
        return [];
    }

    /**
     * No-op.
     * @param {User} user
     */
    storeUser(user) {
    }

    /**
     * No-op.
     * @param {string} userId
     * @return {null}
     */
    getUser(userId) {
        return null;
    }

    /**
     * No-op.
     * @return {User[]}
     */
    getUsers() {
        return [];
    }

    /**
     * No-op.
     * @param {Room} room
     * @param {integer} limit
     * @return {Array}
     */
    scrollback(room, limit) {
        return [];
    }

    /**
     * Store events for a room.
     * @param {Room} room The room to store events for.
     * @param {Array<MatrixEvent>} events The events to store.
     * @param {string} token The token associated with these events.
     * @param {boolean} toStart True if these are paginated results.
     */
    storeEvents(room, events, token, toStart) {
    }

    /**
     * Store a filter.
     * @param {Filter} filter
     */
    storeFilter(filter) {
    }

    /**
     * Retrieve a filter.
     * @param {string} userId
     * @param {string} filterId
     * @return {?Filter} A filter or null.
     */
    getFilter(userId, filterId) {
        return null;
    }

    /**
     * Retrieve a filter ID with the given name.
     * @param {string} filterName The filter name.
     * @return {?string} The filter ID or null.
     */
    getFilterIdByName(filterName) {
        return null;
    }

    /**
     * Set a filter name to ID mapping.
     * @param {string} filterName
     * @param {string} filterId
     */
    setFilterIdByName(filterName, filterId) {

    }

    /**
     * Store user-scoped account data events
     * @param {Array<MatrixEvent>} events The events to store.
     */
    storeAccountDataEvents(events) {

    }

    /**
     * Get account data event by event type
     * @param {string} eventType The event type being queried
     */
    getAccountData(eventType) {

    }

    /**
     * setSyncData does nothing as there is no backing data store.
     *
     * @param {Object} syncData The sync data
     * @return {Promise} An immediately resolved promise.
     */
    setSyncData(syncData) {
        return Promise.resolve();
    }

    /**
     * We never want to save becase we have nothing to save to.
     *
     * @return {boolean} If the store wants to save
     */
    wantsSave() {
        return false;
    }

    /**
     * Save does nothing as there is no backing data store.
     */
    save() { }

    /**
     * Startup does nothing.
     * @return {Promise} An immediately resolved promise.
     */
    startup() {
        return Promise.resolve();
    }

    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync() {
        return Promise.resolve(null);
    }

    /**
     * @return {Promise} If there is a saved sync, the nextBatch token
     * for this sync, otherwise null.
     */
    getSavedSyncToken() {
        return Promise.resolve(null);
    }

    /**
     * Delete all data from this store. Does nothing since this store
     * doesn't store anything.
     * @return {Promise} An immediately resolved promise.
     */
    deleteAllData() {
        return Promise.resolve();
    }

    getOutOfBandMembers() {
        return Promise.resolve(null);
    }

    setOutOfBandMembers() {
        return Promise.resolve();
    }

    clearOutOfBandMembers() {
        return Promise.resolve();
    }

    getClientOptions() {
        return Promise.resolve();
    }

    storeClientOptions() {
        return Promise.resolve();
    }
};
