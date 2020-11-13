/*
Copyright 2015, 2016 OpenMarket Ltd
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

/**
 * @module models/event-context
 */
import {MatrixEvent} from './event';

/**
 * Construct a new EventContext
 *
 * An eventcontext is used for circumstances such as search results, when we
 * have a particular event of interest, and a bunch of events before and after
 * it.
 *
 * It also stores pagination tokens for going backwards and forwards in the
 * timeline.
 *
 * @param {MatrixEvent} ourEvent  the event at the centre of this context
 *
 * @constructor
 */
export class EventContext {
    constructor (ourEvent) {
        this._timeline = [ourEvent];
        this._ourEventIndex = 0;
        this._paginateTokens = {b: null, f: null};

        // this is used by MatrixClient to keep track of active requests
        this._paginateRequests = {b: null, f: null};
    }

    /**
 * Get the main event of interest
 *
 * This is a convenience function for getTimeline()[getOurEventIndex()].
 *
 * @return {MatrixEvent} The event at the centre of this context.
 */
getEvent() {
    return this._timeline[this._ourEventIndex];
};

/**
 * Get the list of events in this context
 *
 * @return {Array} An array of MatrixEvents
 */
getTimeline() {
    return this._timeline;
};

/**
 * Get the index in the timeline of our event
 *
 * @return {Number}
 */
getOurEventIndex() {
    return this._ourEventIndex;
};

/**
 * Get a pagination token.
 *
 * @param {boolean} backwards   true to get the pagination token for going
 *                                  backwards in time
 * @return {string}
 */
getPaginateToken(backwards) {
    return this._paginateTokens[backwards ? 'b' : 'f'];
};

/**
 * Set a pagination token.
 *
 * Generally this will be used only by the matrix js sdk.
 *
 * @param {string} token        pagination token
 * @param {boolean} backwards   true to set the pagination token for going
 *                                   backwards in time
 */
setPaginateToken(token, backwards) {
    this._paginateTokens[backwards ? 'b' : 'f'] = token;
};

/**
 * Add more events to the timeline
 *
 * @param {Array} events      new events, in timeline order
 * @param {boolean} atStart   true to insert new events at the start
 */
addEvents(events, atStart) {
    // TODO: should we share logic with Room.addEventsToTimeline?
    // Should Room even use EventContext?

    if (atStart) {
        this._timeline = events.concat(this._timeline);
        this._ourEventIndex += events.length;
    } else {
        this._timeline = this._timeline.concat(events);
    }
};

}
export function EventContext(ourEvent) {
    this._timeline = [ourEvent];
    this._ourEventIndex = 0;
    this._paginateTokens = {b: null, f: null};

    // this is used by MatrixClient to keep track of active requests
    this._paginateRequests = {b: null, f: null};
}
