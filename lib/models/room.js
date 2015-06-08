"use strict";

function Room(roomId) {
    this.roomId = roomId;
    this.name = roomId;
    this.timeline = [];
    this.oldState = null;
    this.currentState = null;
}

/**
 * The Room class.
 */
module.exports = Room;
