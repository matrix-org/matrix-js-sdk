"use strict";
/**
 * This is an internal module. See {@link MatrixInMemoryStore} for the public class.
 * @module store/memory
 */

/**
 * Construct a new in-memory data store for the Matrix Client.
 * @constructor
 */
module.exports.MatrixInMemoryStore = function MatrixInMemoryStore() {
    this.presence = {
        // presence objects keyed by userId
    };
};

module.exports.MatrixInMemoryStore.prototype = {

    /**
     * Store the given room.
     * @param {Room} room The room to be stored. All properties must be stored.
     */
    storeRoom: function(room) {

    },

    /**
     * Retrieve a room by its' room ID.
     * @param {string} roomId The room ID.
     * @return {Room} The room or null.
     */
    getRoom: function(roomId) {
        return null;
    },

    /**
     * Retrieve a summary of all the rooms.
     * @return {RoomSummary[]} A summary of each room.
     */
    getRoomSummaries: function() {
        return [];
    },

    setPresenceEvents: function(presenceEvents) {
        for (var i = 0; i < presenceEvents.length; i++) {
            var matrixEvent = presenceEvents[i];
            this.presence[matrixEvent.event.user_id] = matrixEvent;
        }
    },

    getPresenceEvents: function(userId) {
        return this.presence[userId];
    }

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};
