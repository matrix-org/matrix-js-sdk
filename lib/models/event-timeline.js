"use strict";

/**
 * @module models/event-timeline
 */

var RoomState = require("./room-state");

/**
 * Construct a new EventTimeline
 *
 * <p>An EventTimeline represents a contiguous sequence of events in a room.
 *
 * <p>As well as keeping track of the events themselves, it stores the state of
 * the room at the beginning and end of the timeline, and pagination tokens for
 * going backwards and forwards in the timeline.
 *
 * <p>In order that clients can meaningfully maintain an index into a timeline, we
 * track a 'baseIndex'. This starts at zero, but is incremented when events are
 * prepended to the timeline. The index of an event relative to baseIndex
 * therefore remains constant.
 *
 * <p>Once a timeline joins up with its neighbour, we link them together into a
 * doubly-linked list.
 *
 * @param {string} roomId    the ID of the room where this timeline came from
 * @constructor
 */
function EventTimeline(roomId) {
    this._roomId = roomId;
    this._events = [];
    this._baseIndex = -1;
    this._startState = new RoomState(roomId);
    this._endState = new RoomState(roomId);

    this._prevTimeline = null;
    this._nextTimeline = null;

    // this is used by client.js
    this._paginationRequests = {'b': null, 'f': null};
}

/**
 * Initialise the start and end state with the given events
 *
 * <p>This can only be called before any events are added.
 *
 * @param {MatrixEvent[]} stateEvents list of state events to intialise the
 * state with.
 */
EventTimeline.prototype.initialiseState = function(stateEvents) {
    if (this._events.length > 0) {
        throw new Error("Cannot initialise state after events are added");
    }

    // do we need to copy here? sync thinks we do but I can't see why
    this._startState.setStateEvents(stateEvents);
    this._endState.setStateEvents(stateEvents);
};

/**
 * Get the ID of the room for this timeline
 * @return {string} room ID
 */
EventTimeline.prototype.getRoomId = function() {
    return this._roomId;
};

/**
 * Get the base index
 *
 * @return {number}
 */
EventTimeline.prototype.getBaseIndex = function() {
    return this._baseIndex;
};

/**
 * Get the list of events in this context
 *
 * @return {MatrixEvent[]} An array of MatrixEvents
 */
EventTimeline.prototype.getEvents = function() {
    return this._events;
};

/**
 * Get the room state at the start/end of the timeline
 *
 * @param {boolean} start true to get the state at the start of the timeline;
 * false to get the state at the end of the timeline.
 * @return {RoomState} state at the start/end of the timeline
 */
EventTimeline.prototype.getState = function(start) {
    return start ? this._startState : this._endState;
};

/**
 * Get a pagination token
 *
 * @param {boolean} backwards   true to get the pagination token for going
 *                                  backwards in time
 * @return {?string} pagination token
 */
EventTimeline.prototype.getPaginationToken = function(backwards) {
    return this.getState(backwards).paginationToken;
};

/**
 * Set a pagination token
 *
 * @param {?string} token       pagination token
 * @param {boolean} backwards   true to set the pagination token for going
 *                                   backwards in time
 */
EventTimeline.prototype.setPaginationToken = function(token, backwards) {
    this.getState(backwards).paginationToken = token;
};

/**
 * Get the next timeline in the series
 *
 * @param {boolean} before  true to get the previous timeline; false to get the
 *                                   following one
 *
 * @return {?EventTimeline} previous or following timeline, if they have been
 * joined up.
 */
EventTimeline.prototype.getNeighbouringTimeline = function(before) {
    return before ? this._prevTimeline : this._nextTimeline;
};

/**
 * Set the next timeline in the series
 *
 * @param {EventTimeline} neighbour previous/following timeline
 *
 * @param {boolean} before true to set the previous timeline; false to set
 * following one.
 */
EventTimeline.prototype.setNeighbouringTimeline = function(neighbour, before) {
    if (this.getNeighbouringTimeline(before)) {
        throw new Error("timeline already has a neighbouring timeline - " +
                        "cannot reset neighbour");
    }
    if (before) {
        this._prevTimeline = neighbour;
    } else {
        this._nextTimeline = neighbour;
    }

    // make sure we don't try to paginate this timeline
    this.setPaginationToken(null, before);
};

/**
 * Add a new event to the timeline, and update the state
 *
 * @param {MatrixEvent} event   new event
 * @param {boolean}  atStart     true to insert new event at the start
 * @param {boolean}  [spliceBeforeLocalEcho = false] insert this event before any
 *     localecho events at the end of the timeline. Ignored if atStart == true
 */
EventTimeline.prototype.addEvent = function(event, atStart, spliceBeforeLocalEcho) {
    var stateContext = atStart ? this._startState : this._endState;

    setEventMetadata(event, stateContext, atStart);

    // modify state
    if (event.isState()) {
        stateContext.setStateEvents([event]);
        // it is possible that the act of setting the state event means we
        // can set more metadata (specifically sender/target props), so try
        // it again if the prop wasn't previously set. It may also mean that
        // the sender/target is updated (if the event set was a room member event)
        // so we want to use the *updated* member (new avatar/name) instead.
        if (!event.sender || event.getType() === "m.room.member") {
            setEventMetadata(event, stateContext, atStart);
        }
    }

    var insertIndex;

    if (atStart) {
        insertIndex = 0;
    } else {
        insertIndex = this._events.length;

        // if this is a real event, we might need to splice it in before any pending
        // local echo events.
        if (spliceBeforeLocalEcho) {
            for (var j = this._events.length - 1; j >= 0; j--) {
                if (!this._events[j].status) { // real events don't have a status
                    insertIndex = j + 1;
                    break;
                }
            }
        }
    }

    this._events.splice(insertIndex, 0, event); // insert element
    if (insertIndex <= this._baseIndex || this._baseIndex == -1) {
        this._baseIndex++;
    }
};

function setEventMetadata(event, stateContext, toStartOfTimeline) {
    // set sender and target properties
    event.sender = stateContext.getSentinelMember(
        event.getSender()
    );
    if (event.getType() === "m.room.member") {
        event.target = stateContext.getSentinelMember(
            event.getStateKey()
        );
    }
    if (event.isState()) {
        // room state has no concept of 'old' or 'current', but we want the
        // room state to regress back to previous values if toStartOfTimeline
        // is set, which means inspecting prev_content if it exists. This
        // is done by toggling the forwardLooking flag.
        if (toStartOfTimeline) {
            event.forwardLooking = false;
        }
    }
}

/**
 * Remove an event from the timeline
 *
 * @param {string} eventId  ID of event to be removed
 * @return {?MatrixEvent} removed event, or null if not found
 */
EventTimeline.prototype.removeEvent = function(eventId) {
    for (var i = this._events.length - 1; i >= 0; i--) {
        var ev = this._events[i];
        if (ev.getId() == eventId) {
            this._events.splice(i, 1);
            if (i < this._baseIndex) {
                this._baseIndex--;
            }
            return ev;
        }
    }
    return null;
};


/**
 * The EventTimeline class
 */
module.exports = EventTimeline;
