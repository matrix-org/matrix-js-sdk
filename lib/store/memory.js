/*
Copyright 2015, 2016 OpenMarket Ltd

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
/**
 * This is an internal module. See {@link MatrixInMemoryStore} for the public class.
 * @module store/memory
 */
 var utils = require("../utils");

/**
 * Construct a new in-memory data store for the Matrix Client.
 * @constructor
 * @param {Object=} opts Config options
 * @param {LocalStorage} opts.localStorage The local storage instance to persist
 * some forms of data such as tokens. Rooms will NOT be stored. See
 * {@link WebStorageStore} to persist rooms.
 */
module.exports.MatrixInMemoryStore = function MatrixInMemoryStore(opts) {
    opts = opts || {};
    this.rooms = {
        // roomId: Room
    };
    this.users = {
        // userId: User
    };
    this.syncToken = null;
    this.filters = {
        // userId: {
        //    filterId: Filter
        // }
    };
    this.localStorage = opts.localStorage;
};

module.exports.MatrixInMemoryStore.prototype = {

    /**
     * Retrieve the token to stream from.
     * @return {string} The token or null.
     */
    getSyncToken: function() {
        return this.syncToken;
    },

    /**
     * Set the token to stream from.
     * @param {string} token The token to stream from.
     */
    setSyncToken: function(token) {
        this.syncToken = token;
    },

    /**
     * Store the given room.
     * @param {Room} room The room to be stored. All properties must be stored.
     */
    storeRoom: function(room) {
        this.rooms[room.roomId] = room;
    },

    /**
     * Retrieve a room by its' room ID.
     * @param {string} roomId The room ID.
     * @return {Room} The room or null.
     */
    getRoom: function(roomId) {
        return this.rooms[roomId] || null;
    },

    /**
     * Retrieve all known rooms.
     * @return {Room[]} A list of rooms, which may be empty.
     */
    getRooms: function() {
        return utils.values(this.rooms);
    },

    /**
     * Permanently delete a room.
     * @param {string} roomId
     */
    removeRoom: function(roomId) {
        delete this.rooms[roomId];
    },

    /**
     * Retrieve a summary of all the rooms.
     * @return {RoomSummary[]} A summary of each room.
     */
    getRoomSummaries: function() {
        return utils.map(utils.values(this.rooms), function(room) {
            return room.summary;
        });
    },

    /**
     * Store a User.
     * @param {User} user The user to store.
     */
    storeUser: function(user) {
        this.users[user.userId] = user;
    },

    /**
     * Retrieve a User by its' user ID.
     * @param {string} userId The user ID.
     * @return {User} The user or null.
     */
    getUser: function(userId) {
        return this.users[userId] || null;
    },

    /**
     * Retrieve scrollback for this room.
     * @param {Room} room The matrix room
     * @param {integer} limit The max number of old events to retrieve.
     * @return {Array<Object>} An array of objects which will be at most 'limit'
     * length and at least 0. The objects are the raw event JSON.
     */
    scrollback: function(room, limit) {
        return [];
    },

    /**
     * Store events for a room. The events have already been added to the timeline
     * @param {Room} room The room to store events for.
     * @param {Array<MatrixEvent>} events The events to store.
     * @param {string} token The token associated with these events.
     * @param {boolean} toStart True if these are paginated results.
     */
    storeEvents: function(room, events, token, toStart) {
        // no-op because they've already been added to the room instance.
    },

    /**
     * Store a filter.
     * @param {Filter} filter
     */
    storeFilter: function(filter) {
        if (!filter) { return; }
        if (!this.filters[filter.userId]) {
            this.filters[filter.userId] = {};
        }
        this.filters[filter.userId][filter.filterId] = filter;
    },

    /**
     * Retrieve a filter.
     * @param {string} userId
     * @param {string} filterId
     * @return {?Filter} A filter or null.
     */
    getFilter: function(userId, filterId) {
        if (!this.filters[userId] || !this.filters[userId][filterId]) {
            return null;
        }
        return this.filters[userId][filterId];
    },

    /**
     * Retrieve a filter ID with the given name.
     * @param {string} filterName The filter name.
     * @return {?string} The filter ID or null.
     */
    getFilterIdByName: function(filterName) {
        if (!this.localStorage) {
            return null;
        }
        try {
            return this.localStorage.getItem("mxjssdk_memory_filter_" + filterName);
        }
        catch (e) {}
        return null;
    },

    /**
     * Set a filter name to ID mapping.
     * @param {string} filterName
     * @param {string} filterId
     */
    setFilterIdByName: function(filterName, filterId) {
        if (!this.localStorage) {
            return;
        }
        try {
            this.localStorage.setItem("mxjssdk_memory_filter_" + filterName, filterId);
        }
        catch (e) {}
    }

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};
