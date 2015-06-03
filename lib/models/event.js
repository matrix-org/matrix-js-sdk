"use strict";

/*
 * Construct a Matrix Event object
 * @param {Object} event The raw event to be wrapped in this DAO
 */
function MatrixEvent(event) {
    this.event = event || {};
}
MatrixEvent.prototype = {
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

/**
 * An event from Matrix.
 */
module.exports.MatrixEvent = MatrixEvent;
