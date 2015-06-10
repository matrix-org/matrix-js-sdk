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
 * @prop {Object.<string, Object.<string, MatrixEvent>>} events The state
 * events dictionary, keyed on the event type and then the state_key value.
 * @prop {string} paginationToken The pagination token for this state.
 */
function RoomState(roomId) {
    this.roomId = roomId;
    this.members = {
        // userId: RoomMember
    };
    this.events = {
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
        if (!this.events[eventType]) {
            // no match
            return stateKey === undefined ? [] : null;
        }
        if (stateKey === undefined) { // return all values
            return utils.values(this.events[eventType]);
        }
        var event = this.events[eventType][stateKey];
        return event ? event : null;
    },

    /**
     * Add an array of one or more state MatrixEvents, overwriting
     * any existing state with the same {type, stateKey} tuple.
     * @param {MatrixEvent[]} stateEvents a list of state events for this room.
     */
    setStateEvents: function(stateEvents) {
        var self = this;
        utils.forEach(stateEvents, function(event) {
            if (event.getRoomId() !== self.roomId) { return; }
            if (!event.isState()) { return; }

            if (self.events[event.getType()] === undefined) {
                self.events[event.getType()] = {};
            }
            self.events[event.getType()][event.getStateKey()] = event;

            if (event.getType() === "m.room.member") {
                var member = new RoomMember(event.getRoomId(), event.getSender());
                member.setMembershipEvent(event, self);
                // this member may have a power level already, so set it.
                var pwrLvlEvent = self.getStateEvents("m.room.power_levels", "");
                if (pwrLvlEvent) {
                    member.setPowerLevelEvent(pwrLvlEvent);
                }
                self.members[event.getStateKey()] = member;
            }
            else if (event.getType() === "m.room.power_levels") {
                var members = utils.values(self.members);
                utils.forEach(members, function(member) {
                    member.setPowerLevelEvent(event);
                });
            }
        });
    },

    /**
     * Set the current typing event for this room.
     * @param {MatrixEvent} event The typing event
     */
    setTypingEvent: function(event) {
        utils.forEach(utils.values(this.members), function(member) {
            member.setTypingEvent(event);
        });
    }
};

/**
 * The RoomState class.
 */
module.exports = RoomState;
