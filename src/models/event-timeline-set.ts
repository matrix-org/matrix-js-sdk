/*
Copyright 2016 - 2021 The Matrix.org Foundation C.I.C.

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

import { EventEmitter } from "events";

import { EventTimeline } from "./event-timeline";
import { EventStatus, MatrixEvent } from "./event";
import { logger } from '../logger';
import { Relations } from './relations';
import { Room } from "./room";
import { Filter } from "../filter";
import { EventType, RelationType } from "../@types/event";
import { RoomState } from "./room-state";

// var DEBUG = false;
const DEBUG = true;

let debuglog;
if (DEBUG) {
    // using bind means that we get to keep useful line numbers in the console
    debuglog = logger.log.bind(logger);
} else {
    debuglog = function() {};
}

interface IOpts {
    timelineSupport?: boolean;
    filter?: Filter;
    unstableClientRelationAggregation?: boolean;
    pendingEvents?: boolean;
}

export enum DuplicateStrategy {
    Ignore = "ignore",
    Replace = "replace",
}

export class EventTimelineSet extends EventEmitter {
    private readonly timelineSupport: boolean;
    private unstableClientRelationAggregation: boolean;
    private displayPendingEvents: boolean;
    private liveTimeline: EventTimeline;
    private timelines: EventTimeline[];
    private _eventIdToTimeline: Record<string, EventTimeline>;
    private filter?: Filter;
    private relations: Record<string, Record<string, Record<RelationType, Relations>>>;

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
    constructor(public readonly room: Room, opts: IOpts) {
        super();

        this.timelineSupport = Boolean(opts.timelineSupport);
        this.liveTimeline = new EventTimeline(this);
        this.unstableClientRelationAggregation = !!opts.unstableClientRelationAggregation;
        this.displayPendingEvents = opts.pendingEvents !== false;

        // just a list - *not* ordered.
        this.timelines = [this.liveTimeline];
        this._eventIdToTimeline = {};

        this.filter = opts.filter;

        if (this.unstableClientRelationAggregation) {
            // A tree of objects to access a set of relations for an event, as in:
            // this.relations[relatesToEventId][relationType][relationEventType]
            this.relations = {};
        }
    }

    /**
     * Get all the timelines in this set
     * @return {module:models/event-timeline~EventTimeline[]} the timelines in this set
     */
    public getTimelines(): EventTimeline[] {
        return this.timelines;
    }

    /**
     * Get the filter object this timeline set is filtered on, if any
     * @return {?Filter} the optional filter for this timelineSet
     */
    public getFilter(): Filter | undefined {
        return this.filter;
    }

    /**
     * Set the filter object this timeline set is filtered on
     * (passed to the server when paginating via /messages).
     * @param {Filter} filter the filter for this timelineSet
     */
    public setFilter(filter?: Filter): void {
        this.filter = filter;
    }

    /**
     * Get the list of pending sent events for this timelineSet's room, filtered
     * by the timelineSet's filter if appropriate.
     *
     * @return {module:models/event.MatrixEvent[]} A list of the sent events
     * waiting for remote echo.
     *
     * @throws If <code>opts.pendingEventOrdering</code> was not 'detached'
     */
    public getPendingEvents(): MatrixEvent[] {
        if (!this.room || !this.displayPendingEvents) {
            return [];
        }

        if (this.filter) {
            return this.filter.filterRoomTimeline(this.room.getPendingEvents());
        } else {
            return this.room.getPendingEvents();
        }
    }

    /**
     * Get the live timeline for this room.
     *
     * @return {module:models/event-timeline~EventTimeline} live timeline
     */
    public getLiveTimeline(): EventTimeline {
        return this.liveTimeline;
    }

    /**
     * Return the timeline (if any) this event is in.
     * @param {String} eventId the eventId being sought
     * @return {module:models/event-timeline~EventTimeline} timeline
     */
    public eventIdToTimeline(eventId: string): EventTimeline {
        return this._eventIdToTimeline[eventId];
    }

    /**
     * Track a new event as if it were in the same timeline as an old event,
     * replacing it.
     * @param {String} oldEventId  event ID of the original event
     * @param {String} newEventId  event ID of the replacement event
     */
    public replaceEventId(oldEventId: string, newEventId: string): void {
        const existingTimeline = this._eventIdToTimeline[oldEventId];
        if (existingTimeline) {
            delete this._eventIdToTimeline[oldEventId];
            this._eventIdToTimeline[newEventId] = existingTimeline;
        }
    }

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
    public resetLiveTimeline(backPaginationToken: string, forwardPaginationToken?: string): void {
        // Each EventTimeline has RoomState objects tracking the state at the start
        // and end of that timeline. The copies at the end of the live timeline are
        // special because they will have listeners attached to monitor changes to
        // the current room state, so we move this RoomState from the end of the
        // current live timeline to the end of the new one and, if necessary,
        // replace it with a newly created one. We also make a copy for the start
        // of the new timeline.

        // if timeline support is disabled, forget about the old timelines
        const resetAllTimelines = !this.timelineSupport || !forwardPaginationToken;

        const oldTimeline = this.liveTimeline;
        const newTimeline = resetAllTimelines ?
            oldTimeline.forkLive(EventTimeline.FORWARDS) :
            oldTimeline.fork(EventTimeline.FORWARDS);

        if (resetAllTimelines) {
            this.timelines = [newTimeline];
            this._eventIdToTimeline = {};
        } else {
            this.timelines.push(newTimeline);
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
        this.liveTimeline = newTimeline;
        this.emit("Room.timelineReset", this.room, this, resetAllTimelines);
    }

    /**
     * Get the timeline which contains the given event, if any
     *
     * @param {string} eventId  event ID to look for
     * @return {?module:models/event-timeline~EventTimeline} timeline containing
     * the given event, or null if unknown
     */
    public getTimelineForEvent(eventId: string): EventTimeline | null {
        const res = this._eventIdToTimeline[eventId];
        return (res === undefined) ? null : res;
    }

    /**
     * Get an event which is stored in our timelines
     *
     * @param {string} eventId  event ID to look for
     * @return {?module:models/event~MatrixEvent} the given event, or undefined if unknown
     */
    public findEventById(eventId: string): MatrixEvent | undefined {
        const tl = this.getTimelineForEvent(eventId);
        if (!tl) {
            return undefined;
        }
        return tl.getEvents().find(function(ev) {
            return ev.getId() == eventId;
        });
    }

    /**
     * Add a new timeline to this timeline list
     *
     * @return {module:models/event-timeline~EventTimeline} newly-created timeline
     */
    public addTimeline(): EventTimeline {
        if (!this.timelineSupport) {
            throw new Error("timeline support is disabled. Set the 'timelineSupport'" +
                " parameter to true when creating MatrixClient to enable" +
                " it.");
        }

        const timeline = new EventTimeline(this);
        this.timelines.push(timeline);
        return timeline;
    }

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
    public addEventsToTimeline(
        events: MatrixEvent[],
        toStartOfTimeline: boolean,
        timeline: EventTimeline,
        paginationToken: string,
    ): void {
        if (!timeline) {
            throw new Error(
                "'timeline' not specified for EventTimelineSet.addEventsToTimeline",
            );
        }

        if (!toStartOfTimeline && timeline == this.liveTimeline) {
            throw new Error(
                "EventTimelineSet.addEventsToTimeline cannot be used for adding events to " +
                "the live timeline - use Room.addLiveEvents instead",
            );
        }

        if (this.filter) {
            events = this.filter.filterRoomTimeline(events);
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
            const existingIsLive = existingTimeline === this.liveTimeline;
            const timelineIsLive = timeline === this.liveTimeline;

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
            if (direction === EventTimeline.FORWARDS && timeline === this.liveTimeline) {
                logger.warn({ lastEventWasNew, didUpdate }); // for debugging
                logger.warn(
                    `Refusing to set forwards pagination token of live timeline ` +
                    `${timeline} to ${paginationToken}`,
                );
                return;
            }
            timeline.setPaginationToken(paginationToken, direction);
        }
    }

    /**
     * Add an event to the end of this live timeline.
     *
     * @param {MatrixEvent} event Event to be added
     * @param {string?} duplicateStrategy 'ignore' or 'replace'
     * @param {boolean} fromCache whether the sync response came from cache
     * @param roomState the state events to reconcile metadata from
     */
    public addLiveEvent(
        event: MatrixEvent,
        duplicateStrategy: DuplicateStrategy = DuplicateStrategy.Ignore,
        fromCache = false,
        roomState?: RoomState,
    ): void {
        if (this.filter) {
            const events = this.filter.filterRoomTimeline([event]);
            if (!events.length) {
                return;
            }
        }

        const timeline = this._eventIdToTimeline[event.getId()];
        if (timeline) {
            if (duplicateStrategy === DuplicateStrategy.Replace) {
                debuglog("EventTimelineSet.addLiveEvent: replacing duplicate event " +
                    event.getId());
                const tlEvents = timeline.getEvents();
                for (let j = 0; j < tlEvents.length; j++) {
                    if (tlEvents[j].getId() === event.getId()) {
                        // still need to set the right metadata on this event
                        if (!roomState) {
                            roomState = timeline.getState(EventTimeline.FORWARDS);
                        }
                        EventTimeline.setEventMetadata(
                            event,
                            roomState,
                            false,
                        );
                        tlEvents[j] = event;

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

        this.addEventToTimeline(event, this.liveTimeline, false, fromCache, roomState);
    }

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
    public addEventToTimeline(
        event: MatrixEvent,
        timeline: EventTimeline,
        toStartOfTimeline: boolean,
        fromCache = false,
        roomState?: RoomState,
    ) {
        const eventId = event.getId();
        timeline.addEvent(event, toStartOfTimeline, roomState);
        this._eventIdToTimeline[eventId] = timeline;

        this.setRelationsTarget(event);
        this.aggregateRelations(event);

        const data = {
            timeline: timeline,
            liveEvent: !toStartOfTimeline && timeline == this.liveTimeline && !fromCache,
        };
        this.emit("Room.timeline", event, this.room,
            Boolean(toStartOfTimeline), false, data);
    }

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
    public handleRemoteEcho(
        localEvent: MatrixEvent,
        oldEventId: string,
        newEventId: string,
    ): void {
        // XXX: why don't we infer newEventId from localEvent?
        const existingTimeline = this._eventIdToTimeline[oldEventId];
        if (existingTimeline) {
            delete this._eventIdToTimeline[oldEventId];
            this._eventIdToTimeline[newEventId] = existingTimeline;
        } else {
            if (this.filter) {
                if (this.filter.filterRoomTimeline([localEvent]).length) {
                    this.addEventToTimeline(localEvent, this.liveTimeline, false);
                }
            } else {
                this.addEventToTimeline(localEvent, this.liveTimeline, false);
            }
        }
    }

    /**
     * Removes a single event from this room.
     *
     * @param {String} eventId  The id of the event to remove
     *
     * @return {?MatrixEvent} the removed event, or null if the event was not found
     * in this room.
     */
    public removeEvent(eventId: string): MatrixEvent | null {
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
    }

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
    public compareEventOrdering(eventId1: string, eventId2: string): number | null {
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
    }

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
    public getRelationsForEvent(
        eventId: string,
        relationType: RelationType,
        eventType: EventType | string,
    ): Relations | undefined {
        if (!this.unstableClientRelationAggregation) {
            throw new Error("Client-side relation aggregation is disabled");
        }

        if (!eventId || !relationType || !eventType) {
            throw new Error("Invalid arguments for `getRelationsForEvent`");
        }

        // debuglog("Getting relations for: ", eventId, relationType, eventType);

        const relationsForEvent = this.relations[eventId] || {};
        const relationsWithRelType = relationsForEvent[relationType] || {};
        return relationsWithRelType[eventType];
    }

    /**
     * Set an event as the target event if any Relations exist for it already
     *
     * @param {MatrixEvent} event
     * The event to check as relation target.
     */
    public setRelationsTarget(event: MatrixEvent): void {
        if (!this.unstableClientRelationAggregation) {
            return;
        }

        const relationsForEvent = this.relations[event.getId()];
        if (!relationsForEvent) {
            return;
        }

        for (const relationsWithRelType of Object.values(relationsForEvent)) {
            for (const relationsWithEventType of Object.values(relationsWithRelType)) {
                relationsWithEventType.setTargetEvent(event);
            }
        }
    }

    /**
     * Add relation events to the relevant relation collection.
     *
     * @param {MatrixEvent} event
     * The new relation event to be aggregated.
     */
    public aggregateRelations(event: MatrixEvent): void {
        if (!this.unstableClientRelationAggregation) {
            return;
        }

        if (event.isRedacted() || event.status === EventStatus.CANCELLED) {
            return;
        }

        // If the event is currently encrypted, wait until it has been decrypted.
        if (event.isBeingDecrypted() || event.shouldAttemptDecryption()) {
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

        let relationsForEvent: Record<string, Partial<Record<string, Relations>>> = this.relations[relatesToEventId];
        if (!relationsForEvent) {
            relationsForEvent = this.relations[relatesToEventId] = {};
        }
        let relationsWithRelType = relationsForEvent[relationType];
        if (!relationsWithRelType) {
            relationsWithRelType = relationsForEvent[relationType] = {};
        }
        let relationsWithEventType = relationsWithRelType[eventType];

        let relatesToEvent;
        if (!relationsWithEventType) {
            relationsWithEventType = relationsWithRelType[eventType] = new Relations(
                relationType,
                eventType,
                this.room,
            );
            relatesToEvent = this.findEventById(relatesToEventId) || this.room.getPendingEvent(relatesToEventId);
            if (relatesToEvent) {
                relationsWithEventType.setTargetEvent(relatesToEvent);
            }
        }

        relationsWithEventType.addEvent(event);
    }
}

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
