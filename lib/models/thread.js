"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ThreadEvent = exports.Thread = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _events = require("events");

var _event = require("./event");

var _eventTimeline = require("./event-timeline");

var _eventTimelineSet = require("./event-timeline-set");

/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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
let ThreadEvent;
/**
 * @experimental
 */

exports.ThreadEvent = ThreadEvent;

(function (ThreadEvent) {
  ThreadEvent["New"] = "Thread.new";
  ThreadEvent["Ready"] = "Thread.ready";
  ThreadEvent["Update"] = "Thread.update";
})(ThreadEvent || (exports.ThreadEvent = ThreadEvent = {}));

class Thread extends _events.EventEmitter {
  /**
   * A reference to the event ID at the top of the thread
   */

  /**
   * A reference to all the events ID at the bottom of the threads
   */
  constructor(events = [], room, client) {
    super();
    this.room = room;
    this.client = client;
    (0, _defineProperty2.default)(this, "root", void 0);
    (0, _defineProperty2.default)(this, "timelineSet", void 0);

    if (events.length === 0) {
      throw new Error("Can't create an empty thread");
    }

    this.timelineSet = new _eventTimelineSet.EventTimelineSet(this.room, {
      unstableClientRelationAggregation: true,
      timelineSupport: true,
      pendingEvents: false
    });
    events.forEach(event => this.addEvent(event));
  }
  /**
   * Add an event to the thread and updates
   * the tail/root references if needed
   * Will fire "Thread.update"
   * @param event The event to add
   */


  async addEvent(event, toStartOfTimeline = false) {
    if (this.timelineSet.findEventById(event.getId()) || event.status !== null) {
      return;
    }

    if (!this.root) {
      if (event.isThreadRelation) {
        this.root = event.threadRootId;
      } else {
        this.root = event.getId();
      }
    } // all the relevant membership info to hydrate events with a sender
    // is held in the main room timeline
    // We want to fetch the room state from there and pass it down to this thread
    // timeline set to let it reconcile an event with its relevant RoomMember


    const roomState = this.room.getLiveTimeline().getState(_eventTimeline.EventTimeline.FORWARDS);
    event.setThread(this);
    this.timelineSet.addEventToTimeline(event, this.timelineSet.getLiveTimeline(), toStartOfTimeline, false, roomState);

    if (this.ready) {
      this.client.decryptEventIfNeeded(event, {});
    }

    this.emit(ThreadEvent.Update, this);
  }
  /**
   * Finds an event by ID in the current thread
   */


  findEventById(eventId) {
    return this.timelineSet.findEventById(eventId);
  }
  /**
   * Determines thread's ready status
   */


  get ready() {
    return this.rootEvent !== undefined;
  }
  /**
   * The thread ID, which is the same as the root event ID
   */


  get id() {
    return this.root;
  }
  /**
   * The thread root event
   */


  get rootEvent() {
    return this.findEventById(this.root);
  }

  get roomId() {
    return this.rootEvent.getRoomId();
  }
  /**
   * The number of messages in the thread
   * Only count rel_type=m.thread as we want to
   * exclude annotations from that number
   */


  get length() {
    return this.events.filter(event => event.isThreadRelation).length;
  }
  /**
   * A set of mxid participating to the thread
   */


  get participants() {
    const participants = new Set();
    this.events.forEach(event => {
      participants.add(event.getSender());
    });
    return participants;
  }
  /**
   * A getter for the last event added to the thread
   */


  get replyToEvent() {
    const events = this.events;
    return events[events.length - 1];
  }

  get events() {
    return this.timelineSet.getLiveTimeline().getEvents();
  }

  merge(thread) {
    thread.events.forEach(event => {
      this.addEvent(event);
    });
    this.events.forEach(event => event.setThread(this));
  }

  has(eventId) {
    return this.timelineSet.findEventById(eventId) instanceof _event.MatrixEvent;
  }

  on(event, listener) {
    super.on(event, listener);
    return this;
  }

  once(event, listener) {
    super.once(event, listener);
    return this;
  }

  off(event, listener) {
    super.off(event, listener);
    return this;
  }

  addListener(event, listener) {
    super.addListener(event, listener);
    return this;
  }

  removeListener(event, listener) {
    super.removeListener(event, listener);
    return this;
  }

}

exports.Thread = Thread;