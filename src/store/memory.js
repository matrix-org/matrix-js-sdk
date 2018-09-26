/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd

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
const utils = require("../utils");
const User = require("../models/user");
import Promise from 'bluebird';

/**
 * Construct a new in-memory data store for the Matrix Client.
 * @constructor
 * @param {Object=} opts Config options
 * @param {LocalStorage} opts.localStorage The local storage instance to persist
 * some forms of data such as tokens. Rooms will NOT be stored.
 */
module.exports.MatrixInMemoryStore = function MatrixInMemoryStore(opts) {
    opts = opts || {};
    this.rooms = {
        // roomId: Room
    };
    this.groups = {
        // groupId: Group
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
    this.accountData = {
        // type : content
    };
    this.localStorage = opts.localStorage;
    this._oobMembers = {
        // roomId: [member events]
    };
    this._clientOptions = {};
};

module.exports.MatrixInMemoryStore.prototype = {

    /**
     * Retrieve the token to stream from.
     * @return {string} The token or null.
     */
    getSyncToken: function() {
        return this.syncToken;
    },

    /** @return {Promise<bool>} whether or not the database was newly created in this session. */
    isNewlyCreated: function() {
        return Promise.resolve(true);
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
     * @param {Group} group The group to be stored
     */
    storeGroup: function(group) {
        this.groups[group.groupId] = group;
    },

    /**
     * Retrieve a group by its group ID.
     * @param {string} groupId The group ID.
     * @return {Group} The group or null.
     */
    getGroup: function(groupId) {
        return this.groups[groupId] || null;
    },

    /**
     * Retrieve all known groups.
     * @return {Group[]} A list of groups, which may be empty.
     */
    getGroups: function() {
        return utils.values(this.groups);
    },

    /**
     * Store the given room.
     * @param {Room} room The room to be stored. All properties must be stored.
     */
    storeRoom: function(room) {
        this.rooms[room.roomId] = room;
        // add listeners for room member changes so we can keep the room member
        // map up-to-date.
        room.currentState.on("RoomState.members", this._onRoomMember.bind(this));
        // add existing members
        const self = this;
        room.currentState.getMembers().forEach(function(m) {
            self._onRoomMember(null, room.currentState, m);
        });
    },

    /**
     * Called when a room member in a room being tracked by this store has been
     * updated.
     * @param {MatrixEvent} event
     * @param {RoomState} state
     * @param {RoomMember} member
     */
    _onRoomMember: function(event, state, member) {
        if (member.membership === "invite") {
            // We do NOT add invited members because people love to typo user IDs
            // which would then show up in these lists (!)
            return;
        }

        const user = this.users[member.userId] || new User(member.userId);
        if (member.name) {
            user.setDisplayName(member.name);
            if (member.events.member) {
                user.setRawDisplayName(
                    member.events.member.getDirectionalContent().displayname,
                );
            }
        }
        if (member.events.member && member.events.member.getContent().avatar_url) {
            user.setAvatarUrl(member.events.member.getContent().avatar_url);
        }
        this.users[user.userId] = user;
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
        if (this.rooms[roomId]) {
            this.rooms[roomId].removeListener("RoomState.members", this._onRoomMember);
        }
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
     * Retrieve all known users.
     * @return {User[]} A list of users, which may be empty.
     */
    getUsers: function() {
        return utils.values(this.users);
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
        if (!filter) {
            return;
        }
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
        } catch (e) {}
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
        } catch (e) {}
    },

    /**
     * Store user-scoped account data events.
     * N.B. that account data only allows a single event per type, so multiple
     * events with the same type will replace each other.
     * @param {Array<MatrixEvent>} events The events to store.
     */
    storeAccountDataEvents: function(events) {
        const self = this;
        events.forEach(function(event) {
            self.accountData[event.getType()] = event;
        });
    },

    /**
     * Get account data event by event type
     * @param {string} eventType The event type being queried
     * @return {?MatrixEvent} the user account_data event of given type, if any
     */
    getAccountData: function(eventType) {
        return this.accountData[eventType];
    },

    /**
     * setSyncData does nothing as there is no backing data store.
     *
     * @param {Object} syncData The sync data
     * @return {Promise} An immediately resolved promise.
     */
    setSyncData: function(syncData) {
        return Promise.resolve();
    },

    /**
     * We never want to save becase we have nothing to save to.
     *
     * @return {boolean} If the store wants to save
     */
    wantsSave: function() {
        return false;
    },

    /**
     * Save does nothing as there is no backing data store.
     */
    save: function() {},

    /**
     * Startup does nothing as this store doesn't require starting up.
     * @return {Promise} An immediately resolved promise.
     */
    startup: function() {
        return Promise.resolve();
    },

    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync: function() {
        return Promise.resolve(null);
    },

    /**
     * @return {Promise} If there is a saved sync, the nextBatch token
     * for this sync, otherwise null.
     */
    getSavedSyncToken: function() {
        return Promise.resolve(null);
    },

    /**
     * Delete all data from this store.
     * @return {Promise} An immediately resolved promise.
     */
    deleteAllData: function() {
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
        this.accountData = {
            // type : content
        };
        return Promise.resolve();
    },
    /**
     * Returns the out-of-band membership events for this room that
     * were previously loaded.
     * @param {string} roomId
     * @returns {event[]} the events, potentially an empty array if OOB loading didn't yield any new members
     * @returns {null} in case the members for this room haven't been stored yet
     */
    getOutOfBandMembers: function(roomId) {
        return Promise.resolve(this._oobMembers[roomId] || null);
    },
    /**
     * Stores the out-of-band membership events for this room. Note that
     * it still makes sense to store an empty array as the OOB status for the room is
     * marked as fetched, and getOutOfBandMembers will return an empty array instead of null
     * @param {string} roomId
     * @param {event[]} membershipEvents the membership events to store
     * @returns {Promise} when all members have been stored
     */
    setOutOfBandMembers: function(roomId, membershipEvents) {
        this._oobMembers[roomId] = membershipEvents;
        return Promise.resolve();
    },

    getClientOptions: function() {
        return Promise.resolve(this._clientOptions);
    },

    storeClientOptions: function(options) {
        this._clientOptions = Object.assign({}, options);
        return Promise.resolve();
    },
};
