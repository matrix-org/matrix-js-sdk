"use strict";
/**
 * This is an internal module. See {@link MatrixEvent} and {@link RoomEvent} for
 * the public classes.
 * @module models/event
 */

/**
 * Construct a Matrix Event object
 * @constructor
 * @param {Object} event The raw event to be wrapped in this DAO
 */
module.exports.MatrixEvent = function MatrixEvent(event) {
    this.event = event || {};
};
module.exports.MatrixEvent.prototype = {
    getId: function() {
        return this.event.event_id;
    },
    getSender: function() {
        return this.event.user_id;
    },
    getType: function() {
        return this.event.type;
    },
    getRoomId: function() {
        return this.event.room_id;
    },
    getTs: function() {
        return this.event.ts;
    },
    getContent: function() {
        return this.event.content;
    },
    isState: function() {
        return this.event.state_key !== undefined;
    },
};
