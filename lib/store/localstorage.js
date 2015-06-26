"use strict";
/**
 * This is an internal module.
 * @module store/localstorage
 */

/**
 * Construct a localstorage store.
 * @constructor
 */
function LocalStorageStore() {

}

LocalStorageStore.prototype = {

    /**
     * Store a room in local storage.
     * @param {Room} room
     */
    storeRoom: function(room) {
    },

    /**
     * Retrieve a room from local storage.
     * @param {string} roomId
     * @return {null}
     */
    getRoom: function(roomId) {
        return null;
    },

    /**
     * Get a list of all rooms from local storage.
     * @return {Array} An empty array.
     */
    getRooms: function() {
        return [];
    },

    /**
     * Get a list of summaries from local storage.
     * @return {Array} An empty array.
     */
    getRoomSummaries: function() {
        return [];
    },

    /**
     * Store a user in local storage.
     * @param {User} user
     */
    storeUser: function(user) {
    },

    /**
     * Get a user from local storage.
     * @param {string} userId
     * @return {null}
     */
    getUser: function(userId) {
        return null;
    }

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};

/** Local Storage Store class. */
module.exports = LocalStorageStore;
