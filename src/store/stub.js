/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

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
"use strict";
import Promise from 'bluebird';
/**
 * This is an internal module.
 * @module store/stub
 */

/**
 * Construct a stub store. This does no-ops on most store methods.
 * @constructor
 */
function StubStore() {
    this.fromToken = null;
}

StubStore.prototype = {

    /**
     * Get the sync token.
     * @return {string}
     */
    getSyncToken: function() {
        return this.fromToken;
    },

    /**
     * Set the sync token.
     * @param {string} token
     */
    setSyncToken: function(token) {
        this.fromToken = token;
    },

    /**
     * No-op.
     * @param {Room} room
     */
    storeRoom: function(room) {
    },

    /**
     * No-op.
     * @param {string} roomId
     * @return {null}
     */
    getRoom: function(roomId) {
        return null;
    },

    /**
     * No-op.
     * @return {Array} An empty array.
     */
    getRooms: function() {
        return [];
    },

    /**
     * Permanently delete a room.
     * @param {string} roomId
     */
    removeRoom: function(roomId) {
        return;
    },

    /**
     * No-op.
     * @return {Array} An empty array.
     */
    getRoomSummaries: function() {
        return [];
    },

    /**
     * No-op.
     * @param {User} user
     */
    storeUser: function(user) {
    },

    /**
     * No-op.
     * @param {string} userId
     * @return {null}
     */
    getUser: function(userId) {
        return null;
    },

    /**
     * No-op.
     * @return {User[]}
     */
    getUsers: function() {
        return [];
    },

    /**
     * No-op.
     * @param {Room} room
     * @param {integer} limit
     * @return {Array}
     */
    scrollback: function(room, limit) {
        return [];
    },

    /**
     * Store events for a room.
     * @param {Room} room The room to store events for.
     * @param {Array<MatrixEvent>} events The events to store.
     * @param {string} token The token associated with these events.
     * @param {boolean} toStart True if these are paginated results.
     */
    storeEvents: function(room, events, token, toStart) {
    },

    /**
     * Store a filter.
     * @param {Filter} filter
     */
    storeFilter: function(filter) {
    },

    /**
     * Retrieve a filter.
     * @param {string} userId
     * @param {string} filterId
     * @return {?Filter} A filter or null.
     */
    getFilter: function(userId, filterId) {
        return null;
    },

    /**
     * Retrieve a filter ID with the given name.
     * @param {string} filterName The filter name.
     * @return {?string} The filter ID or null.
     */
    getFilterIdByName: function(filterName) {
        return null;
    },

    /**
     * Set a filter name to ID mapping.
     * @param {string} filterName
     * @param {string} filterId
     */
    setFilterIdByName: function(filterName, filterId) {

    },

    /**
     * Store user-scoped account data events
     * @param {Array<MatrixEvent>} events The events to store.
     */
    storeAccountDataEvents: function(events) {

    },

    /**
     * Get account data event by event type
     * @param {string} eventType The event type being queried
     */
    getAccountData: function(eventType) {

    },

    /**
     * setSyncData does nothing as there is no backing data store.
     *
     * @param {Object} syncData The sync data
     * @return {Promise} An immediately resolved promise.
     */
    setSyncData: function(syncData) {
        return q();
    },

    /**
     * Save does nothing as there is no backing data store.
     */
    save: function() {},

    /**
     * Startup does nothing.
     * @return {Promise} An immediately resolved promise.
     */
    startup: function() {
        return q();
    },

    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync: function() {
        return q(null);
    },

    /**
     * Delete all data from this store. Does nothing since this store
     * doesn't store anything.
     * @return {Promise} An immediately resolved promise.
     */
    deleteAllData: function() {
        return q();
    },
};

/** Stub Store class. */
module.exports = StubStore;
