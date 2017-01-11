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
 * @param {EventTimelineSet} eventTimelineSet the set of timelines this is part of
 * @constructor
 */
function EventTimeline(eventTimelineSet) {
    this._eventTimelineSet = eventTimelineSet;
    this._roomId = eventTimelineSet.room ? eventTimelineSet.room.roomId : null;
    this._events = [];
    this._baseIndex = 0;
    this._startState = new RoomState(this._roomId);
    this._startState.paginationToken = null;
    this._endState = new RoomState(this._roomId);
    this._endState.paginationToken = null;

    this._prevTimeline = null;
    this._nextTimeline = null;

    // this is used by client.js
    this._paginationRequests = {'b': null, 'f': null};

    this._name = this._roomId + ":" + new Date().toISOString();
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
 * Get the filter for this timeline's timelineSet (if any)
 * @return {Filter} filter
 */
EventTimeline.prototype.getFilter = function() {
    return this._eventTimelineSet.getFilter();
};

/**
 * Get the timelineSet for this timeline
 * @return {EventTimelineSet} timelineSet
 */
EventTimeline.prototype.getTimelineSet = function() {
    return this._eventTimelineSet;
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

    // only call setEventMetadata on the unfiltered timelineSets
    var timelineSet = this.getTimelineSet();
    if (timelineSet.room &&
        timelineSet.room.getUnfilteredTimelineSet() === timelineSet)
    {
        EventTimeline.setEventMetadata(event, stateContext, atStart);

        // modify state
        if (event.isState()) {
            stateContext.setStateEvents([event]);
            // it is possible that the act of setting the state event means we
            // can set more metadata (specifically sender/target props), so try
            // it again if the prop wasn't previously set. It may also mean that
            // the sender/target is updated (if the event set was a room member event)
            // so we want to use the *updated* member (new avatar/name) instead.
            //
            // However, we do NOT want to do this on member events if we're going
            // back in time, else we'll set the .sender value for BEFORE the given
            // member event, whereas we want to set the .sender value for the ACTUAL
            // member event itself.
            if (!event.sender || (event.getType() === "m.room.member" && !atStart)) {
                EventTimeline.setEventMetadata(event, stateContext, atStart);
            }
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

/**
 * Static helper method to set sender and target properties
 *
 * @param {MatrixEvent} event   the event whose metadata is to be set
 * @param {RoomState} stateContext  the room state to be queried
 * @param {bool} toStartOfTimeline  if true the event's forwardLooking flag is set false
 */
EventTimeline.setEventMetadata = function(event, stateContext, toStartOfTimeline) {
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
};

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
 * Return a string to identify this timeline, for debugging
 *
 * @return {string} name for this timeline
 */
EventTimeline.prototype.toString = function() {
    return this._name;
};


/**
 * The EventTimeline class
 */
module.exports = EventTimeline;
