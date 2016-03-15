"use strict";

/**
 * @module models/event-timeline
 */

var RoomState = require("./room-state");
var utils = require("../utils");
var MatrixEvent = require("./event").MatrixEvent;

/**
 * Construct a new EventTimeline
 *
 * <p>An EventTimeline represents a contiguous sequence of events in a room.
 *
 * <p>As well as keeping track of the events themselves, it stores the state of
 * the room at the beginning and end of the timeline, and pagination tokens for
 * going backwards and forwards in the timeline.
 *
 * <p>In order that clients can meaningfully maintain an index into a timeline,
 * the EventTimeline object tracks a 'baseIndex'. This starts at zero, but is
 * incremented when events are prepended to the timeline. The index of an event
 * relative to baseIndex therefore remains constant.
 *
 * <p>Once a timeline joins up with its neighbour, they are linked together into a
 * doubly-linked list.
 *
 * @param {string} roomId    the ID of the room where this timeline came from
 * @constructor
 */
function EventTimeline(roomId) {
    this._roomId = roomId;
    this._events = [];
    this._baseIndex = 0;
    this._startState = new RoomState(roomId);
    this._startState.paginationToken = null;
    this._endState = new RoomState(roomId);
    this._endState.paginationToken = null;

    this._prevTimeline = null;
    this._nextTimeline = null;

    // this is used by client.js
    this._paginationRequests = {'b': null, 'f': null};
}

/**
 * Symbolic constant for methods which take a 'direction' argument:
 * refers to the start of the timeline, or backwards in time.
 */
EventTimeline.BACKWARDS = "b";

/**
 * Symbolic constant for methods which take a 'direction' argument:
 * refers to the end of the timeline, or forwards in time.
 */
EventTimeline.FORWARDS = "f";

/**
 * Initialise the start and end state with the given events
 *
 * <p>This can only be called before any events are added.
 *
 * @param {MatrixEvent[]} stateEvents list of state events to initialise the
 * state with.
 * @throws {Error} if an attempt is made to call this after addEvent is called.
 */
EventTimeline.prototype.initialiseState = function(stateEvents) {
    if (this._events.length > 0) {
        throw new Error("Cannot initialise state after events are added");
    }

    // we deep-copy the events here, in case they get changed later - we don't
    // want changes to the start state leaking through to the end state.
    var oldStateEvents = utils.map(
        utils.deepCopy(
            stateEvents.map(function(mxEvent) { return mxEvent.event; })
        ), function(ev) { return new MatrixEvent(ev); });

    this._startState.setStateEvents(oldStateEvents);
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
 * Get the base index.
 *
 * <p>This is an index which is incremented when events are prepended to the
 * timeline. An individual event therefore stays at the same index in the array
 * relative to the base index (although note that a given event's index may
 * well be less than the base index, thus giving that event a negative relative
 * index).
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
 * @param {string} direction   EventTimeline.BACKWARDS to get the state at the
 *   start of the timeline; EventTimeline.FORWARDS to get the state at the end
 *   of the timeline.
 *
 * @return {RoomState} state at the start/end of the timeline
 */
EventTimeline.prototype.getState = function(direction) {
    if (direction == EventTimeline.BACKWARDS) {
        return this._startState;
    } else if (direction == EventTimeline.FORWARDS) {
        return this._endState;
    } else {
        throw new Error("Invalid direction '" + direction + "'");
    }
};

/**
 * Get a pagination token
 *
 * @param {string} direction   EventTimeline.BACKWARDS to get the pagination
 *   token for going backwards in time; EventTimeline.FORWARDS to get the
 *   pagination token for going forwards in time.
 *
 * @return {?string} pagination token
 */
EventTimeline.prototype.getPaginationToken = function(direction) {
    return this.getState(direction).paginationToken;
};

/**
 * Set a pagination token
 *
 * @param {?string} token       pagination token
 *
 * @param {string} direction    EventTimeline.BACKWARDS to set the pagination
 *   token for going backwards in time; EventTimeline.FORWARDS to set the
 *   pagination token for going forwards in time.
 */
EventTimeline.prototype.setPaginationToken = function(token, direction) {
    this.getState(direction).paginationToken = token;
};

/**
 * Get the next timeline in the series
 *
 * @param {string} direction EventTimeline.BACKWARDS to get the previous
 *   timeline; EventTimeline.FORWARDS to get the next timeline.
 *
 * @return {?EventTimeline} previous or following timeline, if they have been
 * joined up.
 */
EventTimeline.prototype.getNeighbouringTimeline = function(direction) {
    if (direction == EventTimeline.BACKWARDS) {
        return this._prevTimeline;
    } else if (direction == EventTimeline.FORWARDS) {
        return this._nextTimeline;
    } else {
        throw new Error("Invalid direction '" + direction + "'");
    }
};

/**
 * Set the next timeline in the series
 *
 * @param {EventTimeline} neighbour previous/following timeline
 *
 * @param {string} direction EventTimeline.BACKWARDS to set the previous
 *   timeline; EventTimeline.FORWARDS to set the next timeline.
 *
 * @throws {Error} if an attempt is made to set the neighbouring timeline when
 * it is already set.
 */
EventTimeline.prototype.setNeighbouringTimeline = function(neighbour, direction) {
    if (this.getNeighbouringTimeline(direction)) {
        throw new Error("timeline already has a neighbouring timeline - " +
                        "cannot reset neighbour");
    }

    if (direction == EventTimeline.BACKWARDS) {
        this._prevTimeline = neighbour;
    } else if (direction == EventTimeline.FORWARDS) {
        this._nextTimeline = neighbour;
    } else {
        throw new Error("Invalid direction '" + direction + "'");
    }

    // make sure we don't try to paginate this timeline
    this.setPaginationToken(null, direction);
};

/**
 * Add a new event to the timeline, and update the state
 *
 * @param {MatrixEvent} event   new event
 * @param {boolean}  atStart     true to insert new event at the start
 */
EventTimeline.prototype.addEvent = function(event, atStart) {
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
    }

    this._events.splice(insertIndex, 0, event); // insert element
    if (atStart) {
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
