"use strict";
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
     * @param {Room} room
     * @param {integer} limit
     * @return {Array}
     */
    scrollback: function(room, limit) {
        return [];
    }

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};

/** Stub Store class. */
module.exports = StubStore;
