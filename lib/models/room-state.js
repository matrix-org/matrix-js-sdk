"use strict";
/**
 * @module models/room-state
 */
var utils = require("../utils");
var RoomMember = require("./room-member");

/**
 * Construct room state.
 * @constructor
 * @param {string} roomId Required. The ID of the room which has this state.
 * @prop {Object.<string, RoomMember>} members The room member dictionary, keyed
 * on the user's ID.
 * @prop {Object.<string, Object.<string, MatrixEvent>>} stateEvents The state
 * events dictionary, keyed on the event type and then the state_key value.
 * @prop {string} paginationToken The pagination token for this state.
 */
function RoomState(roomId) {
    this.roomId = roomId;
    this.members = {
        // userId: RoomMember
    };
    this.stateEvents = {
        // eventType: { stateKey: MatrixEvent }
    };
    this.paginationToken = null;
}
RoomState.prototype = {
    /**
     * Get all RoomMembers in this room.
     * @return {Array<RoomMember>} A list of RoomMembers.
     */
    getMembers: function() {
        return utils.values(this.members);
    },

    /**
     * Get state events from the state of the room.
     * @param {string} eventType The event type of the state event.
     * @param {string} stateKey Optional. The state_key of the state event. If
     * this is <code>undefined</code> then all matching state events will be
     * returned.
     * @return {MatrixEvent[]|MatrixEvent} A list of events if state_key was
     * <code>undefined</code>, else a single event (or null if no match found).
     */
    getStateEvents: function(eventType, stateKey) {
        if (!this.stateEvents[eventType]) {
            // no match
            return stateKey === undefined ? [] : null;
        }
        if (stateKey === undefined) { // return all values
            return utils.values(this.stateEvents[eventType]);
        }
        var event = this.stateEvents[eventType][stateKey];
        return event ? event : null;
    },

    /**
     * Add an array of one or more state MatrixEvents, overwriting
     * any existing state with the same {type, stateKey} tuple.
     * @param {MatrixEvent[]} stateEvents a list of state events for this room.
     */
    setStateEvents: function(stateEvents) {
        for (var i = 0; i < stateEvents.length; i++) {
            var event = stateEvents[i];
            if (event.getRoomId() !== this.roomId) { continue; }
            if (!event.isState()) { continue; }

            if (this.stateEvents[event.getType()] === undefined) {
                this.stateEvents[event.getType()] = {};
            }
            this.stateEvents[event.getType()][event.getStateKey()] = event;

            if (event.getType() === "m.room.member") {
                var member = new RoomMember(event);
                member.calculateDisplayName(this);
                this.members[event.getStateKey()] = member;
            }
        }
    }
};

/**
 * The RoomState class.
 */
module.exports = RoomState;
