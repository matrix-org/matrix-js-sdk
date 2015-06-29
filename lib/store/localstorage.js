"use strict";
/**
 * This is an internal module. Implementation details:
 *
 * Room data is stored as follows:
 *   room_data_$ROOMID : { event_id1: Event, event_id2: Event, ... }
 *   room_timeline_$ROOMID : [event_id1, event_id2, event_id3, ...]
 * User data is stored as follows:
 *   user_$USERID : User
 * Sync token:
 *   sync_token : $TOKEN
 *
 * Retrieving earlier messages requires a Room which then finds the earliest
 * event_id in the timeline. Then, room_timeline_$ROOMID is inspected to grab
 * the N earlier event_ids. The event data is then extracted from
 * room_data_$ROOMID.
 *
 * TODO: room_data_$ROOMID may get Large. Should we shard the data off the event
 *       ID? E.g. hash event ID mod 10 and extract from buckets? We really want
 *       events close together to be in the same bucket, so perhaps abusing the
 *       origin_server_ts (which is fine since it's just for optimisation) would
 *       be a better approach?
 *
 * @module store/localstorage
 */

/**
 * Construct a local storage store, capable of storing rooms and users.
 *
 * @constructor
 * @throws if the global 'localStorage' does not exist.
 */
function LocalStorageStore() {
    if (!global.localStorage) {
        throw new Error("localStorage not found.");
    }
}

LocalStorageStore.prototype = {

    /**
     * Retrieve the token to stream from.
     * @return {string} The token or null.
     */
    getSyncToken: function() {
        return null;
    },

    /**
     * Set the token to stream from.
     * @param {string} token The token to stream from.
     */
    setSyncToken: function(token) {

    },

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
