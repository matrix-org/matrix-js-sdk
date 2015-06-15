"use strict";
/**
 * @module models/room
 */
var EventEmitter = require("events").EventEmitter;

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
utils.inherits(Room, EventEmitter);

/**
 * Get a member from the current room state.
 * @param {string} userId The user ID of the member.
 * @return {RoomMember} The member or <code>null</code>.
 */
 Room.prototype.getMember = function(userId) {
    var member = this.currentState.members[userId];
    if (!member) {
        return null;
    }
    return member;
 };

/**
 * Get a list of members whose membership state is "join".
 * @return {RoomMember[]} A list of currently joined members.
 */
 Room.prototype.getJoinedMembers = function() {
    return utils.filter(this.currentState.getMembers(), function(m) {
        return m.membership === "join";
    });
 };

/**
 * Add some events to this room's timeline. Will fire "Room.timeline" for
 * each event added.
 * @param {MatrixEvent[]} events A list of events to add.
 * @param {boolean} toStartOfTimeline True to add these events to the start
 * (oldest) instead of the end (newest) of the timeline. If true, the oldest
 * event will be the <b>last</b> element of 'events'.
 * @fires module:client~MatrixClient#event:"Room.timeline"
 */
Room.prototype.addEventsToTimeline = function(events, toStartOfTimeline) {
    var stateContext = toStartOfTimeline ? this.oldState : this.currentState;
    for (var i = 0; i < events.length; i++) {
        // set sender and target properties
        events[i].sender = stateContext.getSentinelMember(
            events[i].getSender()
        );
        if (events[i].getType() === "m.room.member") {
            events[i].target = stateContext.getSentinelMember(
                events[i].getStateKey()
            );
        }

        // modify state
        if (events[i].isState()) {
            // room state has no concept of 'old' or 'current', but we want the
            // room state to regress back to previous values if toStartOfTimeline
            // is set, which means inspecting prev_content if it exists. This
            // is done by toggling the forwardLooking flag.
            if (toStartOfTimeline) {
                events[i].forwardLooking = false;
            }
            stateContext.setStateEvents([events[i]], toStartOfTimeline);
        }
        // TODO: pass through filter to see if this should be added to the timeline.
        if (toStartOfTimeline) {
            this.timeline.unshift(events[i]);
        }
        else {
            this.timeline.push(events[i]);
        }
        this.emit("Room.timeline", events[i], this, toStartOfTimeline);
    }
};

/**
 * Add some events to this room. This can include state events, message
 * events and typing notifications. These events are treated as "live" so
 * they will go to the end of the timeline.
 * @param {MatrixEvent[]} events A list of events to add.
 */
Room.prototype.addEvents = function(events) {
    for (var i = 0; i < events.length; i++) {
        if (events[i].getType() === "m.typing") {
            this.currentState.setTypingEvent(events[i]);
        }
        else {
            // TODO: We should have a filter to say "only add state event
            // types X Y Z to the timeline".
            this.addEventsToTimeline([events[i]]);
        }
    }
};

/**
 * Recalculate various aspects of the room, including the room name and
 * room summary. Call this any time the room's current state is modified.
 * May fire "Room.name" if the room name is updated.
 * @param {string} userId The client's user ID.
 * @fires module:client~MatrixClient#event:"Room.name"
 */
Room.prototype.recalculate = function(userId) {
    var oldName = this.name;
    this.name = calculateRoomName(this, userId);
    this.summary = new RoomSummary(this.roomId, {
        title: this.name
    });

    if (oldName !== this.name) {
        this.emit("Room.name", this);
    }
};

/**
 * This is an internal method. Calculates the name of the room from the current
 * room state.
 * @param {Room} room The matrix room.
 * @param {string} userId The client's user ID. Used to filter room members
 * correctly.
 * @return {string} The calculated room name.
 */
function calculateRoomName(room, userId) {
    // check for an alias, if any. for now, assume first alias is the
    // official one.
    var alias;
    var mRoomAliases = room.currentState.getStateEvents("m.room.aliases")[0];
    if (mRoomAliases && utils.isArray(mRoomAliases.getContent().aliases)) {
        alias = mRoomAliases.getContent().aliases[0];
    }

    var mRoomName = room.currentState.getStateEvents('m.room.name', '');
    if (mRoomName) {
        return mRoomName.getContent().name + (alias ? " (" + alias + ")" : "");
    }
    else if (alias) {
        return alias;
    }
    else {
        // get members that are NOT ourselves.
        var members = utils.filter(room.currentState.getMembers(), function(m) {
            return m.userId !== userId;
        });
        // TODO: Localisation
        if (members.length === 0) {
            var memberList = room.currentState.getMembers();
            if (memberList.length === 1) {
                // we exist, but no one else... self-chat or invite.
                if (memberList[0].membership === "invite") {
                    return "Room Invite";
                }
                else {
                    return userId;
                }
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

/**
 * The Room class.
 */
module.exports = Room;

/**
 * Fires whenever the timeline in a room is updated.
 * @event module:client~MatrixClient#"Room.timeline"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {Room} room The room whose Room.timeline was updated.
 * @param {boolean} toStartOfTimeline True if this event was added to the start
 * (beginning; oldest) of the timeline e.g. due to pagination.
 * @example
 * matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline){
 *   if (toStartOfTimeline) {
 *     var messageToAppend = room.timeline[room.timeline.length - 1];
 *   }
 * });
 */

/**
 * Fires whenever the name of a room is updated.
 * @event module:client~MatrixClient#"Room.name"
 * @param {Room} room The room whose Room.name was updated.
 * @example
 * matrixClient.on("Room.name", function(room){
 *   var newName = room.name;
 * });
 */
