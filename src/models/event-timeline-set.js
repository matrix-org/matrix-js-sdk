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

/**
 * @module models/event-timeline-set
 */

import {EventEmitter} from "events";
import {EventTimeline} from "./event-timeline";
import {EventStatus} from "./event";
import * as utils from "../utils";
import {logger} from '../logger';
import {Relations} from './relations';

// var DEBUG = false;
const DEBUG = true;

let debuglog;
if (DEBUG) {
    // using bind means that we get to keep useful line numbers in the console
    debuglog = logger.log.bind(logger);
} else {
    debuglog = function() {};
}

/**
 * Construct a set of EventTimeline objects, typically on behalf of a given
 * room.  A room may have multiple EventTimelineSets for different levels
 * of filtering.  The global notification list is also an EventTimelineSet, but
 * lacks a room.
 *
 * <p>This is an ordered sequence of timelines, which may or may not
 * be continuous. Each timeline lists a series of events, as well as tracking
 * the room state at the start and the end of the timeline (if appropriate).
 * It also tracks forward and backward pagination tokens, as well as containing
 * links to the next timeline in the sequence.
 *
 * <p>There is one special timeline - the 'live' timeline, which represents the
 * timeline to which events are being added in real-time as they are received
 * from the /sync API. Note that you should not retain references to this
 * timeline - even if it is the current timeline right now, it may not remain
 * so if the server gives us a timeline gap in /sync.
 *
 * <p>In order that we can find events from their ids later, we also maintain a
 * map from event_id to timeline and index.
 *
 * @constructor
 * @param {?Room} room
 * Room for this timelineSet. May be null for non-room cases, such as the
 * notification timeline.
 * @param {Object} opts Options inherited from Room.
 *
 * @param {boolean} [opts.timelineSupport = false]
 * Set to true to enable improved timeline support.
 * @param {Object} [opts.filter = null]
 * The filter object, if any, for this timelineSet.
 * @param {boolean} [opts.unstableClientRelationAggregation = false]
 * Optional. Set to true to enable client-side aggregation of event relations
 * via `getRelationsForEvent`.
 * This feature is currently unstable and the API may change without notice.
 */
export function EventTimelineSet(room, opts) {
    this.room = room;

    this._timelineSupport = Boolean(opts.timelineSupport);
    this._liveTimeline = new EventTimeline(this);
    this._unstableClientRelationAggregation = !!opts.unstableClientRelationAggregation;

    // just a list - *not* ordered.
    this._timelines = [this._liveTimeline];
    this._eventIdToTimeline = {};

    this._filter = opts.filter || null;

    if (this._unstableClientRelationAggregation) {
        // A tree of objects to access a set of relations for an event, as in:
        // this._relations[relatesToEventId][relationType][relationEventType]
        this._relations = {};
    }
}
utils.inherits(EventTimelineSet, EventEmitter);

/**
 * Get all the timelines in this set
 * @return {module:models/event-timeline~EventTimeline[]} the timelines in this set
 */
EventTimelineSet.prototype.getTimelines = function() {
    return this._timelines;
};
/**
 * Get the filter object this timeline set is filtered on, if any
 * @return {?Filter} the optional filter for this timelineSet
 */
EventTimelineSet.prototype.getFilter = function() {
    return this._filter;
};

/**
 * Set the filter object this timeline set is filtered on
 * (passed to the server when paginating via /messages).
 * @param {Filter} filter the filter for this timelineSet
 */
EventTimelineSet.prototype.setFilter = function(filter) {
    this._filter = filter;
};

/**
 * Get the list of pending sent events for this timelineSet's room, filtered
 * by the timelineSet's filter if appropriate.
 *
 * @return {module:models/event.MatrixEvent[]} A list of the sent events
 * waiting for remote echo.
 *
 * @throws If <code>opts.pendingEventOrdering</code> was not 'detached'
 */
EventTimelineSet.prototype.getPendingEvents = function() {
    if (!this.room) {
        return [];
    }

    if (this._filter) {
        return this._filter.filterRoomTimeline(this.room.getPendingEvents());
    } else {
        return this.room.getPendingEvents();
    }
};

/**
 * Get the live timeline for this room.
 *
 * @return {module:models/event-timeline~EventTimeline} live timeline
 */
EventTimelineSet.prototype.getLiveTimeline = function() {
    return this._liveTimeline;
};

/**
 * Return the timeline (if any) this event is in.
 * @param {String} eventId the eventId being sought
 * @return {module:models/event-timeline~EventTimeline} timeline
 */
EventTimelineSet.prototype.eventIdToTimeline = function(eventId) {
    return this._eventIdToTimeline[eventId];
};

/**
 * Track a new event as if it were in the same timeline as an old event,
 * replacing it.
 * @param {String} oldEventId  event ID of the original event
 * @param {String} newEventId  event ID of the replacement event
 */
EventTimelineSet.prototype.replaceEventId = function(oldEventId, newEventId) {
    const existingTimeline = this._eventIdToTimeline[oldEventId];
    if (existingTimeline) {
        delete this._eventIdToTimeline[oldEventId];
        this._eventIdToTimeline[newEventId] = existingTimeline;
    }
};

/**
 * Reset the live timeline, and start a new one.
 *
 * <p>This is used when /sync returns a 'limited' timeline.
 *
 * @param {string=} backPaginationToken   token for back-paginating the new timeline
 * @param {string=} forwardPaginationToken token for forward-paginating the old live timeline,
 * if absent or null, all timelines are reset.
 *
 * @fires module:client~MatrixClient#event:"Room.timelineReset"
 */
EventTimelineSet.prototype.resetLiveTimeline = function(
    backPaginationToken, forwardPaginationToken,
) {
    // Each EventTimeline has RoomState objects tracking the state at the start
    // and end of that timeline. The copies at the end of the live timeline are
    // special because they will have listeners attached to monitor changes to
    // the current room state, so we move this RoomState from the end of the
    // current live timeline to the end of the new one and, if necessary,
    // replace it with a newly created one. We also make a copy for the start
    // of the new timeline.

    // if timeline support is disabled, forget about the old timelines
    const resetAllTimelines = !this._timelineSupport || !forwardPaginationToken;

    const oldTimeline = this._liveTimeline;
    const newTimeline = resetAllTimelines ?
        oldTimeline.forkLive(EventTimeline.FORWARDS) :
        oldTimeline.fork(EventTimeline.FORWARDS);

    if (resetAllTimelines) {
        this._timelines = [newTimeline];
        this._eventIdToTimeline = {};
    } else {
        this._timelines.push(newTimeline);
    }

    if (forwardPaginationToken) {
        // Now set the forward pagination token on the old live timeline
        // so it can be forward-paginated.
        oldTimeline.setPaginationToken(
            forwardPaginationToken, EventTimeline.FORWARDS,
        );
    }

    // make sure we set the pagination token before firing timelineReset,
    // otherwise clients which start back-paginating will fail, and then get
    // stuck without realising that they *can* back-paginate.
    newTimeline.setPaginationToken(backPaginationToken, EventTimeline.BACKWARDS);

    // Now we can swap the live timeline to the new one.
    this._liveTimeline = newTimeline;
    this.emit("Room.timelineReset", this.room, this, resetAllTimelines);
};

/**
 * Get the timeline which contains the given event, if any
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event-timeline~EventTimeline} timeline containing
 * the given event, or null if unknown
 */
EventTimelineSet.prototype.getTimelineForEvent = function(eventId) {
    const res = this._eventIdToTimeline[eventId];
    return (res === undefined) ? null : res;
};

/**
 * Get an event which is stored in our timelines
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event~MatrixEvent} the given event, or undefined if unknown
 */
EventTimelineSet.prototype.findEventById = function(eventId) {
    const tl = this.getTimelineForEvent(eventId);
    if (!tl) {
        return undefined;
    }
    return utils.findElement(tl.getEvents(), function(ev) {
        return ev.getId() == eventId;
    });
};

/**
 * Add a new timeline to this timeline list
 *
 * @return {module:models/event-timeline~EventTimeline} newly-created timeline
 */
EventTimelineSet.prototype.addTimeline = function() {
    if (!this._timelineSupport) {
        throw new Error("timeline support is disabled. Set the 'timelineSupport'" +
                        " parameter to true when creating MatrixClient to enable" +
                        " it.");
    }

    const timeline = new EventTimeline(this);
    this._timelines.push(timeline);
    return timeline;
};


/**
 * Add events to a timeline
 *
 * <p>Will fire "Room.timeline" for each event added.
 *
 * @param {MatrixEvent[]} events A list of events to add.
 *
 * @param {boolean} toStartOfTimeline   True to add these events to the start
 * (oldest) instead of the end (newest) of the timeline. If true, the oldest
 * event will be the <b>last</b> element of 'events'.
 *
 * @param {module:models/event-timeline~EventTimeline} timeline   timeline to
 *    add events to.
 *
 * @param {string=} paginationToken   token for the next batch of events
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 *
 */
EventTimelineSet.prototype.addEventsToTimeline = function(events, toStartOfTimeline,
                                              timeline, paginationToken) {
    if (!timeline) {
        throw new Error(
            "'timeline' not specified for EventTimelineSet.addEventsToTimeline",
        );
    }

    if (!toStartOfTimeline && timeline == this._liveTimeline) {
        throw new Error(
            "EventTimelineSet.addEventsToTimeline cannot be used for adding events to " +
            "the live timeline - use Room.addLiveEvents instead",
        );
    }

    if (this._filter) {
        events = this._filter.filterRoomTimeline(events);
        if (!events.length) {
            return;
        }
    }

    const direction = toStartOfTimeline ? EventTimeline.BACKWARDS :
        EventTimeline.FORWARDS;
    const inverseDirection = toStartOfTimeline ? EventTimeline.FORWARDS :
        EventTimeline.BACKWARDS;

    // Adding events to timelines can be quite complicated. The following
    // illustrates some of the corner-cases.
    //
    // Let's say we start by knowing about four timelines. timeline3 and
    // timeline4 are neighbours:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M]          [P]          [S] <------> [T]
    //
    // Now we paginate timeline1, and get the following events from the server:
    // [M, N, P, R, S, T, U].
    //
    // 1. First, we ignore event M, since we already know about it.
    //
    // 2. Next, we append N to timeline 1.
    //
    // 3. Next, we don't add event P, since we already know about it,
    //    but we do link together the timelines. We now have:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P]          [S] <------> [T]
    //
    // 4. Now we add event R to timeline2:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R]       [S] <------> [T]
    //
    //    Note that we have switched the timeline we are working on from
    //    timeline1 to timeline2.
    //
    // 5. We ignore event S, but again join the timelines:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R] <---> [S] <------> [T]
    //
    // 6. We ignore event T, and the timelines are already joined, so there
    //    is nothing to do.
    //
    // 7. Finally, we add event U to timeline4:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R] <---> [S] <------> [T, U]
    //
    // The important thing to note in the above is what happened when we
    // already knew about a given event:
    //
    //   - if it was appropriate, we joined up the timelines (steps 3, 5).
    //   - in any case, we started adding further events to the timeline which
    //       contained the event we knew about (steps 3, 5, 6).
    //
    //
    // So much for adding events to the timeline. But what do we want to do
    // with the pagination token?
    //
    // In the case above, we will be given a pagination token which tells us how to
    // get events beyond 'U' - in this case, it makes sense to store this
    // against timeline4. But what if timeline4 already had 'U' and beyond? in
    // that case, our best bet is to throw away the pagination token we were
    // given and stick with whatever token timeline4 had previously. In short,
    // we want to only store the pagination token if the last event we receive
    // is one we didn't previously know about.
    //
    // We make an exception for this if it turns out that we already knew about
    // *all* of the events, and we weren't able to join up any timelines. When
    // that happens, it means our existing pagination token is faulty, since it
    // is only telling us what we already know. Rather than repeatedly
    // paginating with the same token, we might as well use the new pagination
    // token in the hope that we eventually work our way out of the mess.

    let didUpdate = false;
    let lastEventWasNew = false;
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const eventId = event.getId();

        const existingTimeline = this._eventIdToTimeline[eventId];

        if (!existingTimeline) {
            // we don't know about this event yet. Just add it to the timeline.
            this.addEventToTimeline(event, timeline, toStartOfTimeline);
            lastEventWasNew = true;
            didUpdate = true;
            continue;
        }

        lastEventWasNew = false;

        if (existingTimeline == timeline) {
            debuglog("Event " + eventId + " already in timeline " + timeline);
            continue;
        }

        const neighbour = timeline.getNeighbouringTimeline(direction);
        if (neighbour) {
            // this timeline already has a neighbour in the relevant direction;
            // let's assume the timelines are already correctly linked up, and
            // skip over to it.
            //
            // there's probably some edge-case here where we end up with an
            // event which is in a timeline a way down the chain, and there is
            // a break in the chain somewhere. But I can't really imagine how
            // that would happen, so I'm going to ignore it for now.
            //
            if (existingTimeline == neighbour) {
                debuglog("Event " + eventId + " in neighbouring timeline - " +
                            "switching to " + existingTimeline);
            } else {
                debuglog("Event " + eventId + " already in a different " +
                            "timeline " + existingTimeline);
            }
            timeline = existingTimeline;
            continue;
        }

        // time to join the timelines.
        logger.info("Already have timeline for " + eventId +
                     " - joining timeline " + timeline + " to " +
                     existingTimeline);

        // Variables to keep the line length limited below.
        const existingIsLive = existingTimeline === this._liveTimeline;
        const timelineIsLive = timeline === this._liveTimeline;

        const backwardsIsLive = direction === EventTimeline.BACKWARDS && existingIsLive;
        const forwardsIsLive = direction === EventTimeline.FORWARDS && timelineIsLive;

        if (backwardsIsLive || forwardsIsLive) {
            // The live timeline should never be spliced into a non-live position.
            // We use independent logging to better discover the problem at a glance.
            if (backwardsIsLive) {
                logger.warn(
                    "Refusing to set a preceding existingTimeLine on our " +
                    "timeline as the existingTimeLine is live (" + existingTimeline + ")",
                );
            }
            if (forwardsIsLive) {
                logger.warn(
                    "Refusing to set our preceding timeline on a existingTimeLine " +
                    "as our timeline is live (" + timeline + ")",
                );
            }
            continue; // abort splicing - try next event
        }

        timeline.setNeighbouringTimeline(existingTimeline, direction);
        existingTimeline.setNeighbouringTimeline(timeline, inverseDirection);

        timeline = existingTimeline;
        didUpdate = true;
    }

    // see above - if the last event was new to us, or if we didn't find any
    // new information, we update the pagination token for whatever
    // timeline we ended up on.
    if (lastEventWasNew || !didUpdate) {
        if (direction === EventTimeline.FORWARDS && timeline === this._liveTimeline) {
            logger.warn({lastEventWasNew, didUpdate}); // for debugging
            logger.warn(
                `Refusing to set forwards pagination token of live timeline ` +
                `${timeline} to ${paginationToken}`,
            );
            return;
        }
        timeline.setPaginationToken(paginationToken, direction);
    }
};

/**
 * Add an event to the end of this live timeline.
 *
 * @param {MatrixEvent} event Event to be added
 * @param {string?} duplicateStrategy 'ignore' or 'replace'
 * @param {boolean} fromCache whether the sync response came from cache
 */
EventTimelineSet.prototype.addLiveEvent = function(event, duplicateStrategy, fromCache) {
    if (this._filter) {
        const events = this._filter.filterRoomTimeline([event]);
        if (!events.length) {
            return;
        }
    }

    const timeline = this._eventIdToTimeline[event.getId()];
    if (timeline) {
        if (duplicateStrategy === "replace") {
            debuglog("EventTimelineSet.addLiveEvent: replacing duplicate event " +
                     event.getId());
            const tlEvents = timeline.getEvents();
            for (let j = 0; j < tlEvents.length; j++) {
                if (tlEvents[j].getId() === event.getId()) {
                    // still need to set the right metadata on this event
                    EventTimeline.setEventMetadata(
                        event,
                        timeline.getState(EventTimeline.FORWARDS),
                        false,
                    );

                    if (!tlEvents[j].encryptedType) {
                        tlEvents[j] = event;
                    }

                    // XXX: we need to fire an event when this happens.
                    break;
                }
            }
        } else {
            debuglog("EventTimelineSet.addLiveEvent: ignoring duplicate event " +
                     event.getId());
        }
        return;
    }

    this.addEventToTimeline(event, this._liveTimeline, false, fromCache);
};

/**
 * Add event to the given timeline, and emit Room.timeline. Assumes
 * we have already checked we don't know about this event.
 *
 * Will fire "Room.timeline" for each event added.
 *
 * @param {MatrixEvent} event
 * @param {EventTimeline} timeline
 * @param {boolean} toStartOfTimeline
 * @param {boolean} fromCache whether the sync response came from cache
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 */
EventTimelineSet.prototype.addEventToTimeline = function(event, timeline,
                                                         toStartOfTimeline, fromCache) {
    const eventId = event.getId();
    timeline.addEvent(event, toStartOfTimeline);
    this._eventIdToTimeline[eventId] = timeline;

    this.setRelationsTarget(event);
    this.aggregateRelations(event);

    const data = {
        timeline: timeline,
        liveEvent: !toStartOfTimeline && timeline == this._liveTimeline && !fromCache,
    };
    this.emit("Room.timeline", event, this.room,
              Boolean(toStartOfTimeline), false, data);
};

/**
 * Replaces event with ID oldEventId with one with newEventId, if oldEventId is
 * recognised.  Otherwise, add to the live timeline.  Used to handle remote echos.
 *
 * @param {MatrixEvent} localEvent     the new event to be added to the timeline
 * @param {String} oldEventId          the ID of the original event
 * @param {boolean} newEventId         the ID of the replacement event
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 */
EventTimelineSet.prototype.handleRemoteEcho = function(localEvent, oldEventId,
                                                        newEventId) {
    // XXX: why don't we infer newEventId from localEvent?
    const existingTimeline = this._eventIdToTimeline[oldEventId];
    if (existingTimeline) {
        delete this._eventIdToTimeline[oldEventId];
        this._eventIdToTimeline[newEventId] = existingTimeline;
    } else {
        if (this._filter) {
            if (this._filter.filterRoomTimeline([localEvent]).length) {
                this.addEventToTimeline(localEvent, this._liveTimeline, false);
            }
        } else {
            this.addEventToTimeline(localEvent, this._liveTimeline, false);
        }
    }
};

/**
 * Removes a single event from this room.
 *
 * @param {String} eventId  The id of the event to remove
 *
 * @return {?MatrixEvent} the removed event, or null if the event was not found
 * in this room.
 */
EventTimelineSet.prototype.removeEvent = function(eventId) {
    const timeline = this._eventIdToTimeline[eventId];
    if (!timeline) {
        return null;
    }

    const removed = timeline.removeEvent(eventId);
    if (removed) {
        delete this._eventIdToTimeline[eventId];
        const data = {
            timeline: timeline,
        };
        this.emit("Room.timeline", removed, this.room, undefined, true, data);
    }
    return removed;
};

/**
 * Determine where two events appear in the timeline relative to one another
 *
 * @param {string} eventId1   The id of the first event
 * @param {string} eventId2   The id of the second event

 * @return {?number} a number less than zero if eventId1 precedes eventId2, and
 *    greater than zero if eventId1 succeeds eventId2. zero if they are the
 *    same event; null if we can't tell (either because we don't know about one
 *    of the events, or because they are in separate timelines which don't join
 *    up).
 */
EventTimelineSet.prototype.compareEventOrdering = function(eventId1, eventId2) {
    if (eventId1 == eventId2) {
        // optimise this case
        return 0;
    }

    const timeline1 = this._eventIdToTimeline[eventId1];
    const timeline2 = this._eventIdToTimeline[eventId2];

    if (timeline1 === undefined) {
        return null;
    }
    if (timeline2 === undefined) {
        return null;
    }

    if (timeline1 === timeline2) {
        // both events are in the same timeline - figure out their
        // relative indices
        let idx1;
        let idx2;
        const events = timeline1.getEvents();
        for (let idx = 0; idx < events.length &&
             (idx1 === undefined || idx2 === undefined); idx++) {
            const evId = events[idx].getId();
            if (evId == eventId1) {
                idx1 = idx;
            }
            if (evId == eventId2) {
                idx2 = idx;
            }
        }
        return idx1 - idx2;
    }

    // the events are in different timelines. Iterate through the
    // linkedlist to see which comes first.

    // first work forwards from timeline1
    let tl = timeline1;
    while (tl) {
        if (tl === timeline2) {
            // timeline1 is before timeline2
            return -1;
        }
        tl = tl.getNeighbouringTimeline(EventTimeline.FORWARDS);
    }

    // now try backwards from timeline1
    tl = timeline1;
    while (tl) {
        if (tl === timeline2) {
            // timeline2 is before timeline1
            return 1;
        }
        tl = tl.getNeighbouringTimeline(EventTimeline.BACKWARDS);
    }

    // the timelines are not contiguous.
    return null;
};

/**
 * Get a collection of relations to a given event in this timeline set.
 *
 * @param {String} eventId
 * The ID of the event that you'd like to access relation events for.
 * For example, with annotations, this would be the ID of the event being annotated.
 * @param {String} relationType
 * The type of relation involved, such as "m.annotation", "m.reference", "m.replace", etc.
 * @param {String} eventType
 * The relation event's type, such as "m.reaction", etc.
 * @throws If <code>eventId</code>, <code>relationType</code> or <code>eventType</code>
 * are not valid.
 *
 * @returns {?Relations}
 * A container for relation events or undefined if there are no relation events for
 * the relationType.
 */
EventTimelineSet.prototype.getRelationsForEvent = function(
    eventId, relationType, eventType,
) {
    if (!this._unstableClientRelationAggregation) {
        throw new Error("Client-side relation aggregation is disabled");
    }

    if (!eventId || !relationType || !eventType) {
        throw new Error("Invalid arguments for `getRelationsForEvent`");
    }

    // debuglog("Getting relations for: ", eventId, relationType, eventType);

    const relationsForEvent = this._relations[eventId] || {};
    const relationsWithRelType = relationsForEvent[relationType] || {};
    return relationsWithRelType[eventType];
};

/**
 * Set an event as the target event if any Relations exist for it already
 *
 * @param {MatrixEvent} event
 * The event to check as relation target.
 */
EventTimelineSet.prototype.setRelationsTarget = function(event) {
    if (!this._unstableClientRelationAggregation) {
        return;
    }

    const relationsForEvent = this._relations[event.getId()];
    if (!relationsForEvent) {
        return;
    }
    // don't need it for non m.replace relations for now
    const relationsWithRelType = relationsForEvent["m.replace"];
    if (!relationsWithRelType) {
        return;
    }
    // only doing replacements for messages for now (e.g. edits)
    const relationsWithEventType = relationsWithRelType["m.room.message"];

    if (relationsWithEventType) {
        relationsWithEventType.setTargetEvent(event);
    }
};

/**
 * Add relation events to the relevant relation collection.
 *
 * @param {MatrixEvent} event
 * The new relation event to be aggregated.
 */
EventTimelineSet.prototype.aggregateRelations = function(event) {
    if (!this._unstableClientRelationAggregation) {
        return;
    }

    if (event.isRedacted() || event.status === EventStatus.CANCELLED) {
        return;
    }

    // If the event is currently encrypted, wait until it has been decrypted.
    if (event.isBeingDecrypted()) {
        event.once("Event.decrypted", () => {
            this.aggregateRelations(event);
        });
        return;
    }

    const relation = event.getRelation();
    if (!relation) {
        return;
    }

    const relatesToEventId = relation.event_id;
    const relationType = relation.rel_type;
    const eventType = event.getType();

    // debuglog("Aggregating relation: ", event.getId(), eventType, relation);

    let relationsForEvent = this._relations[relatesToEventId];
    if (!relationsForEvent) {
        relationsForEvent = this._relations[relatesToEventId] = {};
    }
    let relationsWithRelType = relationsForEvent[relationType];
    if (!relationsWithRelType) {
        relationsWithRelType = relationsForEvent[relationType] = {};
    }
    let relationsWithEventType = relationsWithRelType[eventType];

    let isNewRelations = false;
    let relatesToEvent;
    if (!relationsWithEventType) {
        relationsWithEventType = relationsWithRelType[eventType] = new Relations(
            relationType,
            eventType,
            this.room,
        );
        isNewRelations = true;
        relatesToEvent = this.findEventById(relatesToEventId);
        if (relatesToEvent) {
            relationsWithEventType.setTargetEvent(relatesToEvent);
        }
    }

    relationsWithEventType.addEvent(event);

    // only emit once event has been added to relations
    if (isNewRelations && relatesToEvent) {
        relatesToEvent.emit("Event.relationsCreated", relationType, eventType);
    }
};

/**
 * Fires whenever the timeline in a room is updated.
 * @event module:client~MatrixClient#"Room.timeline"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {?Room} room The room, if any, whose timeline was updated.
 * @param {boolean} toStartOfTimeline True if this event was added to the start
 * @param {boolean} removed True if this event has just been removed from the timeline
 * (beginning; oldest) of the timeline e.g. due to pagination.
 *
 * @param {object} data  more data about the event
 *
 * @param {module:models/event-timeline.EventTimeline} data.timeline the timeline the
 * event was added to/removed from
 *
 * @param {boolean} data.liveEvent true if the event was a real-time event
 * added to the end of the live timeline
 *
 * @example
 * matrixClient.on("Room.timeline",
 *                 function(event, room, toStartOfTimeline, removed, data) {
 *   if (!toStartOfTimeline && data.liveEvent) {
 *     var messageToAppend = room.timeline.[room.timeline.length - 1];
 *   }
 * });
 */

/**
 * Fires whenever the live timeline in a room is reset.
 *
 * When we get a 'limited' sync (for example, after a network outage), we reset
 * the live timeline to be empty before adding the recent events to the new
 * timeline. This event is fired after the timeline is reset, and before the
 * new events are added.
 *
 * @event module:client~MatrixClient#"Room.timelineReset"
 * @param {Room} room The room whose live timeline was reset, if any
 * @param {EventTimelineSet} timelineSet timelineSet room whose live timeline was reset
 * @param {boolean} resetAllTimelines True if all timelines were reset.
 */
