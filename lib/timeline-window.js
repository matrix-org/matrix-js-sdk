/*
Copyright 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
"use strict";

/** @module timeline-window */

var q = require("q");
var EventTimeline = require("./models/event-timeline");

/**
 * @private
 */
var DEBUG = false;

/**
 * @private
 */
var debuglog = DEBUG ? console.log.bind(console) : function() {};

/**
 * Construct a TimelineWindow.
 *
 * <p>This abstracts the separate timelines in a Matrix {@link
 * module:models/room~Room|Room} into a single iterable thing. It keeps track of
 * the start and endpoints of the window, which can be advanced with the help
 * of pagination requests.
 *
 * <p>Before the window is useful, it must be initialised by calling {@link
 * module:timeline-window~TimelineWindow#load|load}.
 *
 * <p>Note that the window will not automatically extend itself when new events
 * are received from /sync; you should arrange to call {@link
 * module:timeline-window~TimelineWindow#paginate|paginate} on {@link
 * module:client~MatrixClient.event:"Room.timeline"|Room.timeline} events.
 *
 * @param {MatrixClient} client   MatrixClient to be used for context/pagination
 *   requests.
 *
 * @param {Room} room  The room to track
 *
 * @param {Object} [opts] Configuration options for this window
 *
 * @param {number} [opts.windowLimit = 1000] maximum number of events to keep
 *    in the window. If more events are retrieved via pagination requests,
 *    excess events will be dropped from the other end of the window.
 *
 * @constructor
 */
function TimelineWindow(client, room, opts) {
    opts = opts || {};
    this._client = client;
    this._room = room;

    // _start.index is inclusive; _end.index is exclusive.
    this._start = null;
    this._end = null;

    this._eventCount = 0;
    this._windowLimit = opts.windowLimit || 1000;
}

/**
 * Initialise the window to point at a given event, or the live timeline
 *
 * @param {string} [initialEventId]   If given, the window will contain the
 *    given event
 * @param {number} [initialWindowSize = 20]   Size of the initial window
 *
 * @return {module:client.Promise}
 */
TimelineWindow.prototype.load = function(initialEventId, initialWindowSize) {
    var self = this;
    initialWindowSize = initialWindowSize || 20;

    var prom;
    if (initialEventId) {
        debuglog("TimelineWindow: initialising for event " + initialEventId);
        prom = this._client.getEventTimeline(this._room, initialEventId)
            .then(function(tl) {
                // make sure that our window includes the event
                for (var i = 0; i < tl.getEvents().length; i++) {
                    if (tl.getEvents()[i].getId() == initialEventId) {
                        return [tl, i];
                    }
                }
                throw new Error("getEventTimeline result didn't include requested event");
            });
    } else {
        debuglog("TimelineWindow: initialising with live timeline");

        // start with the most recent events
        var tl = this._room.getLiveTimeline();
        prom = q([tl, tl.getEvents().length]);
    }

    prom = prom.then(function(v) {
        var tl = v[0], eventIndex = v[1];

        var endIndex = Math.min(tl.getEvents().length,
                                eventIndex + initialWindowSize / 2);
        var startIndex = Math.max(0, endIndex - initialWindowSize);
        self._start = new TimelineIndex(tl, startIndex - tl.getBaseIndex());
        self._end = new TimelineIndex(tl, endIndex - tl.getBaseIndex());
        self._eventCount = endIndex - startIndex;
    });

    return prom;
};

/**
 * Check if this window can be extended
 *
 * <p>This returns true if we either have more events, or if we have a
 * pagination token which means we can paginate in that direction. It does not
 * necessarily mean that there are more events available in that direction at
 * this time.
 *
 * @param {string} direction   EventTimeline.BACKWARDS to check if we can
 *   paginate backwards; EventTimeline.FORWARDS to check if we can go forwards
 *
 * @return {boolean} true if we can paginate in the given direction
 */
TimelineWindow.prototype.canPaginate = function(direction) {
    var tl;
    if (direction == EventTimeline.BACKWARDS) {
        tl = this._start;
        if (tl.index > tl.minIndex()) { return true; }
    } else if (direction == EventTimeline.FORWARDS) {
        tl = this._end;
        if (tl.index < tl.maxIndex()) { return true; }
    } else {
        throw new Error("Invalid direction '" + direction + "'");
    }

    return tl.timeline.getNeighbouringTimeline(direction) ||
        tl.timeline.getPaginationToken(direction);
};

/**
 * Attempt to extend the window
 *
 * @param {string} direction   EventTimeline.BACKWARDS to extend the window
 *    backwards (towards older events); EventTimeline.FORWARDS to go forwards.
 *
 * @param {number} size   number of events to try to extend by. If fewer than this
 *    number are immediately available, then we return immediately rather than
 *    making an API call.
 *
 * @param {boolean} [makeRequest = true]  whether we should make API calls to
 *    fetch further events if we don't have any.
 *
 * @return {module:client.Promise} Resolves to a boolean which is true if more events
 *    were successfully retrieved.
 */
TimelineWindow.prototype.paginate = function(direction, size, makeRequest) {
    // Either wind back the message cap (if there are enough events in the
    // timeline to do so), or fire off a pagination request.

    if (makeRequest === undefined) {
        makeRequest = true;
    }

    var tl;
    if (direction == EventTimeline.BACKWARDS) {
        tl = this._start;
    } else if (direction == EventTimeline.FORWARDS) {
        tl = this._end;
    } else {
        throw new Error("Invalid direction '" + direction + "'");
    }

    if (!tl) {
        debuglog("TimelineWindow: no timeline yet");
        return q(false);
    }

    if (tl.pendingPaginate) {
        return tl.pendingPaginate;
    }

    // try moving the cap
    var count = (direction == EventTimeline.BACKWARDS) ?
        tl.retreat(size) : tl.advance(size);

    if (count) {
        this._eventCount += count;
        debuglog("TimelineWindow: increased cap by " + count +
                 " (now " + this._eventCount + ")");
        // remove some events from the other end, if necessary
        if (this._eventCount > this._windowLimit) {
            this._unpaginate(direction != EventTimeline.BACKWARDS);
        }
        return q(true);
    }

    if (!makeRequest) {
        return q(false);
    }

    // try making a pagination request
    var token = tl.timeline.getPaginationToken(direction);
    if (!token) {
        debuglog("TimelineWindow: no token");
        return q(false);
    }

    debuglog("TimelineWindow: starting request");
    var self = this;
    var prom = this._client.paginateEventTimeline(tl.timeline, {
        backwards: direction == EventTimeline.BACKWARDS,
        limit: size
    }).finally(function() {
        tl.pendingPaginate = null;
    }).then(function(r) {
        debuglog("TimelineWindow: request completed with result " + r);
        if (!r) {
            // end of timeline
            return false;
        }
        return self.paginate(direction, size);
    });
    tl.pendingPaginate = prom;
    return prom;
};


/**
 * Trim the window to the windowlimit
 *
 * @param {boolean} startOfTimeline if events should be removed from the start
 *     of the timeline.
 *
 * @private
 */
TimelineWindow.prototype._unpaginate = function(startOfTimeline) {
    var tl = startOfTimeline ? this._start : this._end;

    var delta = this._eventCount - this._windowLimit;

    while (delta > 0) {
        var count = startOfTimeline ? tl.advance(delta) : tl.retreat(delta);
        if (count <= 0) {
            // sadness. This shouldn't be possible.
            throw new Error(
                "Unable to unpaginate any further, but still have " +
                    this._eventCount + " events");
        }

        delta -= count;
        this._eventCount -= count;
        debuglog("TimelineWindow.unpaginate: dropped " + count +
                 " (now " + this._eventCount + ")");
    }
};


/**
 * Get a list of the events currently in the window
 *
 * @return {MatrixEvent[]} the events in the window
 */
TimelineWindow.prototype.getEvents = function() {
    if (!this._start) {
        // not yet loaded
        return [];
    }

    var result = [];

    for (var timeline = this._start.timeline; timeline !== null;
        timeline = timeline.getNeighbouringTimeline(EventTimeline.FORWARDS)) {

        var events = timeline.getEvents();
        var startIndex = 0, endIndex = events.length;
        if (timeline === this._start.timeline) {
            startIndex = this._start.index + timeline.getBaseIndex();
        }
        if (timeline === this._end.timeline) {
            endIndex = this._end.index + timeline.getBaseIndex();
        }

        for (var i = startIndex; i < endIndex; i++) {
            result.push(events[i]);
        }
    }
    return result;
};


/**
 * a thing which contains a timeline reference, and an index into it.
 *
 * @constructor
 * @param {EventTimeline} timeline
 * @param {number} index
 * @private
 */
function TimelineIndex(timeline, index) {
    this.timeline = timeline;

    // the indexes are relative to BaseIndex, so could well be negative.
    this.index = index;
}

/**
 * @return {number} the minimum possible value for the index in the current
 *    timeline
 */
TimelineIndex.prototype.minIndex = function() {
    return -this.timeline.getBaseIndex();
};

/**
 * @return {number} the maximum possible value for the index in the current
 *    timeline
 */
TimelineIndex.prototype.maxIndex = function() {
    return this.timeline.getEvents().length - this.timeline.getBaseIndex();
};

/**
 * Try move the index forward, or into the neighbouring timeline
 *
 * @param {number} delta  number of events to advance by
 * @return {number} number of events successfully advanced by
 */
TimelineIndex.prototype.advance = function(delta) {
    // first try moving the cap
    var x;
    if (delta === 0) {
        return 0;
    } else if (delta < 0) {
        x = Math.max(delta, this.minIndex() - this.index);
        if (x < 0) {
            this.index += x;
            return x;
        }
    } else {
        x = Math.min(delta, this.maxIndex() - this.index);
        if (x > 0) {
            this.index += x;
            return x;
        }
    }

    // next see if there is a neighbouring timeline to switch to
    var neighbour = this.timeline.getNeighbouringTimeline(
        delta < 0 ? EventTimeline.BACKWARDS : EventTimeline.FORWARDS);
    if (neighbour) {
        this.timeline = neighbour;
        if (delta < 0) {
            this.index = this.maxIndex();
        } else {
            this.index = this.minIndex();
        }

        debuglog("paginate: switched to new neighbour");

        // recurse, using the next timeline
        return this.advance(delta);
    }

    return 0;
};

/**
 * Try move the index backwards, or into the neighbouring timeline
 *
 * @param {number} delta  number of events to retreat by
 * @return {number} number of events successfully retreated by
 */
TimelineIndex.prototype.retreat = function(delta) {
    return this.advance(delta * -1) * -1;
};

/**
 * The TimelineWindow class.
 */
module.exports.TimelineWindow = TimelineWindow;
