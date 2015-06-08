"use strict";
/**
 * @module models/room
 */
var RoomState = require("./room-state");

/**
 * Construct a new Room.
 * @constructor
 * @param {string} roomId Required. The ID of this room.
 * @prop {string} roomId The ID of this room.
 * @prop {string} name The human-readable display name for this room.
 * @prop {Array<MatrixEvent>} timeline The ordered list of message events for
 * this room.
 * @prop {RoomState} oldState The state of the room at the time of the oldest
 * event in the timeline.
 * @prop {RoomState} currentState The state of the room at the time of the
 * newest event in the timeline.
 * @prop {RoomSummary} summary The room summary.
 */
function Room(roomId) {
    this.roomId = roomId;
    this.name = roomId;
    this.timeline = [];
    this.oldState = new RoomState(roomId);
    this.currentState = new RoomState(roomId);
    this.summary = null;
}
Room.prototype = {
    /**
     * Add some events to this room's timeline.
     * @param {MatrixEvent[]} events A list of events to add.
     * @param {boolean} toStartOfTimeline True to add these events to the start
     * (oldest) instead of the end (newest) of the timeline. If true, the oldest
     * event will be the <b>last</b> element of 'events'.
     */
    addEventsToTimeline: function(events, toStartOfTimeline) {
        for (var i = 0; i < events.length; i++) {
            if (toStartOfTimeline) {
                this.timeline.unshift(events[i]);
            }
            else {
                this.timeline.push(events[i]);
            }
        }
    }
};

/**
 * The Room class.
 */
module.exports = Room;
