"use strict";
/**
 * @module models/room
 */

/**
 * Construct a new Room.
 * @constructor
 * @param {string} roomId The ID of this room.
 * @prop {string} roomId The ID of this room.
 * @prop {string} name The human-readable display name for this room.
 * @prop {Array<MatrixEvent>} timeline The ordered list of message events for
 * this room.
 * @prop {RoomState} oldState The state of the room at the time of the oldest
 * event in the timeline.
 * @prop {RoomState} currentState The state of the room at the time of the
 * newest event in the timeline.
 */
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
