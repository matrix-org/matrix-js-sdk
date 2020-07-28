/*
Copyright 2016 OpenMarket Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

/** @module timeline-window */

import {EventTimeline} from './models/event-timeline';
import {logger} from './logger';

/**
 * @private
 */
const DEBUG = false;

/**
 * @private
 */
const debuglog = DEBUG ? logger.log.bind(logger) : function() {};

/**
 * the number of times we ask the server for more events before giving up
 *
 * @private
 */
const DEFAULT_PAGINATE_LOOP_LIMIT = 5;

/**
 * Construct a TimelineWindow.
 *
 * <p>This abstracts the separate timelines in a Matrix {@link
 * module:models/room|Room} into a single iterable thing. It keeps track of
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
 * @param {EventTimelineSet} timelineSet  The timelineSet to track
 *
 * @param {Object} [opts] Configuration options for this window
 *
 * @param {number} [opts.windowLimit = 1000] maximum number of events to keep
 *    in the window. If more events are retrieved via pagination requests,
 *    excess events will be dropped from the other end of the window.
 *
 * @constructor
 */
export function TimelineWindow(client, timelineSet, opts) {
    opts = opts || {};
    this._client = client;
    this._timelineSet = timelineSet;

    // these will be TimelineIndex objects; they delineate the 'start' and
    // 'end' of the window.
    //
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
 * @return {Promise}
 */
TimelineWindow.prototype.load = function(initialEventId, initialWindowSize) {
    const self = this;
    initialWindowSize = initialWindowSize || 20;

    // given an EventTimeline, find the event we were looking for, and initialise our
    // fields so that the event in question is in the middle of the window.
    const initFields = function(timeline) {
        let eventIndex;

        const events = timeline.getEvents();

        if (!initialEventId) {
            // we were looking for the live timeline: initialise to the end
            eventIndex = events.length;
        } else {
            for (let i = 0; i < events.length; i++) {
                if (events[i].getId() == initialEventId) {
                    eventIndex = i;
                    break;
                }
            }

            if (eventIndex === undefined) {
                throw new Error("getEventTimeline result didn't include requested event");
            }
        }

        const endIndex = Math.min(events.length,
                                eventIndex + Math.ceil(initialWindowSize / 2));
        const startIndex = Math.max(0, endIndex - initialWindowSize);
        self._start = new TimelineIndex(timeline, startIndex - timeline.getBaseIndex());
        self._end = new TimelineIndex(timeline, endIndex - timeline.getBaseIndex());
        self._eventCount = endIndex - startIndex;
    };

    // We avoid delaying the resolution of the promise by a reactor tick if
    // we already have the data we need, which is important to keep room-switching
    // feeling snappy.
    //
    if (initialEventId) {
        const timeline = this._timelineSet.getTimelineForEvent(initialEventId);
        if (timeline) {
            // hot-path optimization to save a reactor tick by replicating the sync check getTimelineForEvent does.
            initFields(timeline);
            return Promise.resolve(timeline);
        }

        const prom = this._client.getEventTimeline(this._timelineSet, initialEventId);
        return prom.then(initFields);
    } else {
        const tl = this._timelineSet.getLiveTimeline();
        initFields(tl);
        return Promise.resolve();
    }
};

/**
 * Get the TimelineIndex of the window in the given direction.
 *
 * @param {string} direction   EventTimeline.BACKWARDS to get the TimelineIndex
 * at the start of the window; EventTimeline.FORWARDS to get the TimelineIndex at
 * the end.
 *
 * @return {TimelineIndex} The requested timeline index if one exists, null
 * otherwise.
 */
TimelineWindow.prototype.getTimelineIndex = function(direction) {
    if (direction == EventTimeline.BACKWARDS) {
        return this._start;
    } else if (direction == EventTimeline.FORWARDS) {
        return this._end;
    } else {
        throw new Error("Invalid direction '" + direction + "'");
    }
};

/**
 * Try to extend the window using events that are already in the underlying
 * TimelineIndex.
 *
 * @param {string} direction   EventTimeline.BACKWARDS to try extending it
 *   backwards; EventTimeline.FORWARDS to try extending it forwards.
 * @param {number} size   number of events to try to extend by.
 *
 * @return {boolean} true if the window was extended, false otherwise.
 */
TimelineWindow.prototype.extend = function(direction, size) {
    const tl = this.getTimelineIndex(direction);

    if (!tl) {
        debuglog("TimelineWindow: no timeline yet");
        return false;
    }

    const count = (direction == EventTimeline.BACKWARDS) ?
        tl.retreat(size) : tl.advance(size);

    if (count) {
        this._eventCount += count;
        debuglog("TimelineWindow: increased cap by " + count +
                 " (now " + this._eventCount + ")");
        // remove some events from the other end, if necessary
        const excess = this._eventCount - this._windowLimit;
        if (excess > 0) {
            this.unpaginate(excess, direction != EventTimeline.BACKWARDS);
        }
        return true;
    }

    return false;
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
    const tl = this.getTimelineIndex(direction);

    if (!tl) {
        debuglog("TimelineWindow: no timeline yet");
        return false;
    }

    if (direction == EventTimeline.BACKWARDS) {
        if (tl.index > tl.minIndex()) {
            return true;
        }
    } else {
        if (tl.index < tl.maxIndex()) {
            return true;
        }
    }

    return Boolean(tl.timeline.getNeighbouringTimeline(direction) ||
                   tl.timeline.getPaginationToken(direction));
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
 * @param {boolean} [makeRequest = true] whether we should make API calls to
 *    fetch further events if we don't have any at all. (This has no effect if
 *    the room already knows about additional events in the relevant direction,
 *    even if there are fewer than 'size' of them, as we will just return those
 *    we already know about.)
 *
 * @param {number} [requestLimit = 5] limit for the number of API requests we
 *    should make.
 *
 * @return {Promise} Resolves to a boolean which is true if more events
 *    were successfully retrieved.
 */
TimelineWindow.prototype.paginate = function(direction, size, makeRequest,
                                             requestLimit) {
    // Either wind back the message cap (if there are enough events in the
    // timeline to do so), or fire off a pagination request.

    if (makeRequest === undefined) {
        makeRequest = true;
    }

    if (requestLimit === undefined) {
        requestLimit = DEFAULT_PAGINATE_LOOP_LIMIT;
    }

    const tl = this.getTimelineIndex(direction);

    if (!tl) {
        debuglog("TimelineWindow: no timeline yet");
        return Promise.resolve(false);
    }

    if (tl.pendingPaginate) {
        return tl.pendingPaginate;
    }

    // try moving the cap
    if (this.extend(direction, size)) {
        return Promise.resolve(true);
    }

    if (!makeRequest || requestLimit === 0) {
        // todo: should we return something different to indicate that there
        // might be more events out there, but we haven't found them yet?
        return Promise.resolve(false);
    }

    // try making a pagination request
    const token = tl.timeline.getPaginationToken(direction);
    if (!token) {
        debuglog("TimelineWindow: no token");
        return Promise.resolve(false);
    }

    debuglog("TimelineWindow: starting request");
    const self = this;

    const prom = this._client.paginateEventTimeline(tl.timeline, {
        backwards: direction == EventTimeline.BACKWARDS,
        limit: size,
    }).finally(function() {
        tl.pendingPaginate = null;
    }).then(function(r) {
        debuglog("TimelineWindow: request completed with result " + r);
        if (!r) {
            // end of timeline
            return false;
        }

        // recurse to advance the index into the results.
        //
        // If we don't get any new events, we want to make sure we keep asking
        // the server for events for as long as we have a valid pagination
        // token. In particular, we want to know if we've actually hit the
        // start of the timeline, or if we just happened to know about all of
        // the events thanks to https://matrix.org/jira/browse/SYN-645.
        //
        // On the other hand, we necessarily want to wait forever for the
        // server to make its mind up about whether there are other events,
        // because it gives a bad user experience
        // (https://github.com/vector-im/vector-web/issues/1204).
        return self.paginate(direction, size, true, requestLimit - 1);
    });
    tl.pendingPaginate = prom;
    return prom;
};


/**
 * Remove `delta` events from the start or end of the timeline.
 *
 * @param {number}  delta           number of events to remove from the timeline
 * @param {boolean} startOfTimeline if events should be removed from the start
 *     of the timeline.
 */
TimelineWindow.prototype.unpaginate = function(delta, startOfTimeline) {
    const tl = startOfTimeline ? this._start : this._end;

    // sanity-check the delta
    if (delta > this._eventCount || delta < 0) {
        throw new Error("Attemting to unpaginate " + delta + " events, but " +
                        "only have " + this._eventCount + " in the timeline");
    }

    while (delta > 0) {
        const count = startOfTimeline ? tl.advance(delta) : tl.retreat(delta);
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

    const result = [];

    // iterate through each timeline between this._start and this._end
    // (inclusive).
    let timeline = this._start.timeline;
    while (true) {
        const events = timeline.getEvents();

        // For the first timeline in the chain, we want to start at
        // this._start.index. For the last timeline in the chain, we want to
        // stop before this._end.index. Otherwise, we want to copy all of the
        // events in the timeline.
        //
        // (Note that both this._start.index and this._end.index are relative
        // to their respective timelines' BaseIndex).
        //
        let startIndex = 0;
        let endIndex = events.length;
        if (timeline === this._start.timeline) {
            startIndex = this._start.index + timeline.getBaseIndex();
        }
        if (timeline === this._end.timeline) {
            endIndex = this._end.index + timeline.getBaseIndex();
        }

        for (let i = startIndex; i < endIndex; i++) {
            result.push(events[i]);
        }

        // if we're not done, iterate to the next timeline.
        if (timeline === this._end.timeline) {
            break;
        } else {
            timeline = timeline.getNeighbouringTimeline(EventTimeline.FORWARDS);
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
export function TimelineIndex(timeline, index) {
    this.timeline = timeline;

    // the indexes are relative to BaseIndex, so could well be negative.
    this.index = index;
}

/**
 * @return {number} the minimum possible value for the index in the current
 *    timeline
 */
TimelineIndex.prototype.minIndex = function() {
    return this.timeline.getBaseIndex() * -1;
};

/**
 * @return {number} the maximum possible value for the index in the current
 *    timeline (exclusive - ie, it actually returns one more than the index
 *    of the last element).
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
    if (!delta) {
        return 0;
    }

    // first try moving the index in the current timeline. See if there is room
    // to do so.
    let cappedDelta;
    if (delta < 0) {
        // we want to wind the index backwards.
        //
        // (this.minIndex() - this.index) is a negative number whose magnitude
        // is the amount of room we have to wind back the index in the current
        // timeline. We cap delta to this quantity.
        cappedDelta = Math.max(delta, this.minIndex() - this.index);
        if (cappedDelta < 0) {
            this.index += cappedDelta;
            return cappedDelta;
        }
    } else {
        // we want to wind the index forwards.
        //
        // (this.maxIndex() - this.index) is a (positive) number whose magnitude
        // is the amount of room we have to wind forward the index in the current
        // timeline. We cap delta to this quantity.
        cappedDelta = Math.min(delta, this.maxIndex() - this.index);
        if (cappedDelta > 0) {
            this.index += cappedDelta;
            return cappedDelta;
        }
    }

    // the index is already at the start/end of the current timeline.
    //
    // next see if there is a neighbouring timeline to switch to.
    const neighbour = this.timeline.getNeighbouringTimeline(
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
