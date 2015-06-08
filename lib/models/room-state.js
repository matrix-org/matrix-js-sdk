"use strict";
/**
 * @module models/room-state
 */

/**
 * Construct room state.
 * @constructor
 * @prop {Object.<string, RoomMember>} members The room member dictionary, keyed
 * on the user's ID.
 * @prop {Object.<string, Object.<string, MatrixEvent>>} stateEvents The state
 * events dictionary, keyed on the event type and then the state_key value.
 * @prop {string} paginationToken The pagination token for this state.
 */
function RoomState() {
    this.members = {
        // userId: RoomMember
    };
    this.stateEvents = {
        // eventType: { stateKey: MatrixEvent }
    };
    this.paginationToken = null;
}

/**
 * The RoomState class.
 */
module.exports = RoomState;
