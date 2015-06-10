"use strict";
/**
 * @module models/room
 */
var RoomState = require("./room-state");
var RoomSummary = require("./room-summary");
var utils = require("../utils");

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
     * Get a member from the current room state.
     * @param {string} userId The user ID of the member.
     * @return {RoomMember} The member or <code>null</code>.
     */
     getMember: function(userId) {
        var member = this.currentState.members[userId];
        if (!member) {
            return null;
        }
        return member;
     },

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
    },

    /**
     * Add some events to this room. This can include state events, message
     * events and typing notifications. These events are treated as "live" so
     * they will go to the end of the timeline.
     * @param {MatrixEvent[]} events A list of events to add.
     */
    addEvents: function(events) {
        for (var i = 0; i < events.length; i++) {
            if (events[i].getType() === "m.typing") {
                this.currentState.setTypingEvent(events[i]);
            }
            else {
                // TODO: We should have a filter to say "only add state event
                // types X Y Z to the timeline".
                this.addEventsToTimeline([events[i]]);
                if (events[i].isState()) {
                    this.currentState.setStateEvents([events[i]]);
                }
            }
        }
    },

    /**
     * Recalculate various aspects of the room, including the room name and
     * room summary. Call this any time the room's current state is modified.
     * @param {string} userId The client's user ID.
     */
    recalculate: function(userId) {
        this.name = this.calculateRoomName(userId);
        this.summary = new RoomSummary(this.roomId, {
            title: this.name
        });
    },

    /**
     * Calculates the name of the room from the current room state.
     * @param {string} userId The client's user ID. Used to filter room members
     * correctly.
     * @return {string} The calculated room name.
     */
    calculateRoomName: function(userId) {
        // check for an alias, if any. for now, assume first alias is the
        // official one.
        var alias;
        var mRoomAliases = this.currentState.getStateEvents("m.room.aliases")[0];
        if (mRoomAliases && utils.isArray(mRoomAliases.getContent().aliases)) {
            alias = mRoomAliases.getContent().aliases[0];
        }

        var mRoomName = this.currentState.getStateEvents('m.room.name', '');
        if (mRoomName) {
            return mRoomName.getContent().name + (alias ? " (" + alias + ")" : "");
        }
        else if (alias) {
            return alias;
        }
        else {
            // get members that are NOT ourselves.
            var members = utils.filter(this.currentState.getMembers(), function(m) {
                return m.userId !== userId;
            });
            // TODO: Localisation
            if (members.length === 0) {
                if (this.currentState.getMembers().length === 1) {
                    // we exist, but no one else... self-chat!
                    return userId;
                }
                else {
                    // there really isn't anyone in this room...
                    return "?";
                }
            }
            else if (members.length === 1) {
                return members[0].name;
            }
            else if (members.length === 2) {
                return (
                    members[0].name + " and " + members[1].name
                );
            }
            else {
                return (
                    members[0].name + " and " + (members.length - 1) + " others"
                );
            }
        }
    }
};

/**
 * The Room class.
 */
module.exports = Room;
