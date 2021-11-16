"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.EventContext = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _eventTimeline = require("./event-timeline");

/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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
class EventContext {
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
  constructor(ourEvent) {
    (0, _defineProperty2.default)(this, "timeline", void 0);
    (0, _defineProperty2.default)(this, "ourEventIndex", 0);
    (0, _defineProperty2.default)(this, "paginateTokens", {
      [_eventTimeline.Direction.Backward]: null,
      [_eventTimeline.Direction.Forward]: null
    });
    this.timeline = [ourEvent];
  }
  /**
   * Get the main event of interest
   *
   * This is a convenience function for getTimeline()[getOurEventIndex()].
   *
   * @return {MatrixEvent} The event at the centre of this context.
   */


  getEvent() {
    return this.timeline[this.ourEventIndex];
  }
  /**
   * Get the list of events in this context
   *
   * @return {Array} An array of MatrixEvents
   */


  getTimeline() {
    return this.timeline;
  }
  /**
   * Get the index in the timeline of our event
   *
   * @return {Number}
   */


  getOurEventIndex() {
    return this.ourEventIndex;
  }
  /**
   * Get a pagination token.
   *
   * @param {boolean} backwards   true to get the pagination token for going
   *                                  backwards in time
   * @return {string}
   */


  getPaginateToken(backwards = false) {
    return this.paginateTokens[backwards ? _eventTimeline.Direction.Backward : _eventTimeline.Direction.Forward];
  }
  /**
   * Set a pagination token.
   *
   * Generally this will be used only by the matrix js sdk.
   *
   * @param {string} token        pagination token
   * @param {boolean} backwards   true to set the pagination token for going
   *                                   backwards in time
   */


  setPaginateToken(token, backwards = false) {
    this.paginateTokens[backwards ? _eventTimeline.Direction.Backward : _eventTimeline.Direction.Forward] = token;
  }
  /**
   * Add more events to the timeline
   *
   * @param {Array} events      new events, in timeline order
   * @param {boolean} atStart   true to insert new events at the start
   */


  addEvents(events, atStart = false) {
    // TODO: should we share logic with Room.addEventsToTimeline?
    // Should Room even use EventContext?
    if (atStart) {
      this.timeline = events.concat(this.timeline);
      this.ourEventIndex += events.length;
    } else {
      this.timeline = this.timeline.concat(events);
    }
  }

}

exports.EventContext = EventContext;