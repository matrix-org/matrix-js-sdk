"use strict";
/**
 * This is an internal module. See {@link MatrixInMemoryStore} for the public class.
 * @module store/memory
 */
 var utils = require("../utils");

/**
 * Construct a new in-memory data store for the Matrix Client.
 * @constructor
 */
module.exports.MatrixInMemoryStore = function MatrixInMemoryStore() {
    this.rooms = {
        // roomId: Room
    };
    this.users = {
        // userId: User
    };
    this.syncToken = null;
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
    }

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};
