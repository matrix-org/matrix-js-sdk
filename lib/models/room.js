/*
Copyright 2015, 2016 OpenMarket Ltd

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
/**
 * @module models/room
 */
var EventEmitter = require("events").EventEmitter;

var EventStatus = require("./event").EventStatus;
var RoomSummary = require("./room-summary");
var MatrixEvent = require("./event").MatrixEvent;
var utils = require("../utils");
var ContentRepo = require("../content-repo");
var EventTimeline = require("./event-timeline");

function synthesizeReceipt(userId, event, receiptType) {
    // console.log("synthesizing receipt for "+event.getId());
    // This is really ugly because JS has no way to express an object literal
    // where the name of a key comes from an expression
    var fakeReceipt = {
        content: {},
        type: "m.receipt",
        room_id: event.getRoomId()
    };
    fakeReceipt.content[event.getId()] = {};
    fakeReceipt.content[event.getId()][receiptType] = {};
    fakeReceipt.content[event.getId()][receiptType][userId] = {
        ts: event.getTs()
    };
    return new MatrixEvent(fakeReceipt);
}


/**
 * Construct a new Room.
 *
 * <p>For a room, we store an ordered sequence of timelines, which may or may not
 * be continuous. Each timeline lists a series of events, as well as tracking
 * the room state at the start and the end of the timeline. It also tracks
 * forward and backward pagination tokens, as well as containing links to the
 * next timeline in the sequence.
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
 * @param {string} roomId Required. The ID of this room.
 * @param {Object=} opts Configuration options
 * @param {*} opts.storageToken Optional. The token which a data store can use
 * to remember the state of the room. What this means is dependent on the store
 * implementation.
 * @param {String=} opts.pendingEventOrdering Controls where pending messages appear
 * in a room's timeline. If "<b>chronological</b>", messages will appear in the timeline
 * when the call to <code>sendEvent</code> was made. If "<b>end</b>", pending messages
 * will always appear at the end of the timeline (multiple pending messages will be sorted
 * chronologically). Default: "chronological".
 * @param {boolean} [opts.timelineSupport = false] Set to true to enable improved
 * timeline support.
 *
 * @prop {string} roomId The ID of this room.
 * @prop {string} name The human-readable display name for this room.
 * @prop {Array<MatrixEvent>} timeline The live event timeline for this room,
 * with the oldest event at index 0. Present for backwards compatibility -
 * prefer getLiveTimeline().getEvents().
 * @prop {object} tags Dict of room tags; the keys are the tag name and the values
 * are any metadata associated with the tag - e.g. { "fav" : { order: 1 } }
 * @prop {object} accountData Dict of per-room account_data events; the keys are the
 * event type and the values are the events.
 * @prop {RoomState} oldState The state of the room at the time of the oldest
 * event in the live timeline. Present for backwards compatibility -
 * prefer getLiveTimeline().getState(true).
 * @prop {RoomState} currentState The state of the room at the time of the
 * newest event in the timeline. Present for backwards compatibility -
 * prefer getLiveTimeline().getState(false).
 * @prop {RoomSummary} summary The room summary.
 * @prop {*} storageToken A token which a data store can use to remember
 * the state of the room.
 */
function Room(roomId, opts) {
    opts = opts || {};
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";

    if (["chronological", "end"].indexOf(opts.pendingEventOrdering) === -1) {
        throw new Error(
            "opts.pendingEventOrdering MUST be either 'chronological' or " +
            "'end'. Got: '" + opts.pendingEventOrdering + "'"
        );
    }

    this.roomId = roomId;
    this.name = roomId;
    this.tags = {
        // $tagName: { $metadata: $value },
        // $tagName: { $metadata: $value },
    };
    this.accountData = {
        // $eventType: $event
    };
    this.summary = null;
    this.storageToken = opts.storageToken;
    this._opts = opts;
    this._txnToEvent = {}; // Pending in-flight requests { string: MatrixEvent }
    // receipts should clobber based on receipt_type and user_id pairs hence
    // the form of this structure. This is sub-optimal for the exposed APIs
    // which pass in an event ID and get back some receipts, so we also store
    // a pre-cached list for this purpose.
    this._receipts = {
        // receipt_type: {
        //   user_id: {
        //     eventId: <event_id>,
        //     data: <receipt_data>
        //   }
        // }
    };
    this._receiptCacheByEventId = {
        // $event_id: [{
        //   type: $type,
        //   userId: $user_id,
        //   data: <receipt data>
        // }]
    };
    // only receipts that came from the server, not synthesized ones
    this._realReceipts = {};

    this._notificationCounts = {};

    this._liveTimeline = new EventTimeline(this.roomId);
    this._fixUpLegacyTimelineFields();

    // just a list - *not* ordered.
    this._timelines = [this._liveTimeline];
    this._eventIdToTimeline = {};
    this._timelineSupport = Boolean(opts.timelineSupport);

}
utils.inherits(Room, EventEmitter);

/**
 * Get the live timeline for this room.
 *
 * @return {module:models/event-timeline~EventTimeline} live timeline
 */
Room.prototype.getLiveTimeline = function() {
    return this._liveTimeline;
};

/**
 * Reset the live timeline, and start a new one.
 *
 * <p>This is used when /sync returns a 'limited' timeline.
 *
 * @fires module:client~MatrixClient#event:"Room.timelineReset"
 */
Room.prototype.resetLiveTimeline = function() {
    var newTimeline;

    if (!this._timelineSupport) {
        // if timeline support is disabled, forget about the old timelines
        newTimeline = new EventTimeline(this.roomId);
        this._timelines = [newTimeline];
        this._eventIdToTimeline = {};
    } else {
        newTimeline = this.addTimeline();
    }

    // initialise the state in the new timeline from our last known state
    var evMap = this._liveTimeline.getState(EventTimeline.FORWARDS).events;
    var events = [];
    for (var evtype in evMap) {
        if (!evMap.hasOwnProperty(evtype)) { continue; }
        for (var stateKey in evMap[evtype]) {
            if (!evMap[evtype].hasOwnProperty(stateKey)) { continue; }
            events.push(evMap[evtype][stateKey]);
        }
    }
    newTimeline.initialiseState(events);

    this._liveTimeline = newTimeline;
    this._fixUpLegacyTimelineFields();
    this.emit("Room.timelineReset", this);
};

/**
 * Fix up this.timeline, this.oldState and this.currentState
 *
 * @private
 */
Room.prototype._fixUpLegacyTimelineFields = function() {
    // maintain this.timeline as a reference to the live timeline,
    // and this.oldState and this.currentState as references to the
    // state at the start and end of that timeline. These are more
    // for backwards-compatibility than anything else.
    this.timeline = this._liveTimeline.getEvents();
    this.oldState = this._liveTimeline.getState(EventTimeline.BACKWARDS);
    this.currentState = this._liveTimeline.getState(EventTimeline.FORWARDS);
};

/**
 * Get the timeline which contains the given event, if any
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event-timeline~EventTimeline} timeline containing
 * the given event, or null if unknown
 */
Room.prototype.getTimelineForEvent = function(eventId) {
    var res = this._eventIdToTimeline[eventId];
    return (res === undefined) ? null : res;
};

/**
 * Get an event which is stored in our timelines
 *
 * @param {string} eventId  event ID to look for
 * @return {?module:models/event~MatrixEvent} the given event, or undefined if unknown
 */
Room.prototype.findEventById = function(eventId) {
    var tl = this.getTimelineForEvent(eventId);
    if (!tl) {
        return undefined;
    }
    return utils.findElement(tl.getEvents(),
                             function(ev) { return ev.getId() == eventId; });
};


/**
 * Get one of the notification counts for this room
 * @param {String} type The type of notification count to get. default: 'total'
 * @return {Number} The notification count, or undefined if there is no count
 *                  for this type.
 */
Room.prototype.getUnreadNotificationCount = function(type) {
    type = type || 'total';
    return this._notificationCounts[type];
};

/**
 * Set one of the notification counts for this room
 * @param {String} type The type of notification count to set.
 * @param {Number} count The new count
 */
Room.prototype.setUnreadNotificationCount = function(type, count) {
    this._notificationCounts[type] = count;
};

/**
 * Get the avatar URL for a room if one was set.
 * @param {String} baseUrl The homeserver base URL. See
 * {@link module:client~MatrixClient#getHomeserverUrl}.
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {boolean} allowDefault True to allow an identicon for this room if an
 * avatar URL wasn't explicitly set. Default: true.
 * @return {?string} the avatar URL or null.
 */
Room.prototype.getAvatarUrl = function(baseUrl, width, height, resizeMethod,
                                       allowDefault) {
    var roomAvatarEvent = this.currentState.getStateEvents("m.room.avatar", "");
    if (allowDefault === undefined) { allowDefault = true; }
    if (!roomAvatarEvent && !allowDefault) {
        return null;
    }

    var mainUrl = roomAvatarEvent ? roomAvatarEvent.getContent().url : null;
    if (mainUrl) {
        return ContentRepo.getHttpUriForMxc(
            baseUrl, mainUrl, width, height, resizeMethod
        );
    }
    else if (allowDefault) {
        return ContentRepo.getIdenticonUri(
            baseUrl, this.roomId, width, height
        );
    }

    return null;
};

/**
 * Get a member from the current room state.
 * @param {string} userId The user ID of the member.
 * @return {RoomMember} The member or <code>null</code>.
 */
 Room.prototype.getMember = function(userId) {
    var member = this.currentState.members[userId];
    if (!member) {
        return null;
    }
    return member;
 };

/**
 * Get a list of members whose membership state is "join".
 * @return {RoomMember[]} A list of currently joined members.
 */
 Room.prototype.getJoinedMembers = function() {
    return this.getMembersWithMembership("join");
 };

/**
 * Get a list of members with given membership state.
 * @param {string} membership The membership state.
 * @return {RoomMember[]} A list of members with the given membership state.
 */
 Room.prototype.getMembersWithMembership = function(membership) {
    return utils.filter(this.currentState.getMembers(), function(m) {
        return m.membership === membership;
    });
 };

 /**
  * Get the default room name (i.e. what a given user would see if the
  * room had no m.room.name)
  * @param {string} userId The userId from whose perspective we want
  * to calculate the default name
  * @return {string} The default room name
  */
 Room.prototype.getDefaultRoomName = function(userId) {
    return calculateRoomName(this, userId, true);
 };


 /**
 * Check if the given user_id has the given membership state.
 * @param {string} userId The user ID to check.
 * @param {string} membership The membership e.g. <code>'join'</code>
 * @return {boolean} True if this user_id has the given membership state.
 */
 Room.prototype.hasMembershipState = function(userId, membership) {
    var member = this.getMember(userId);
    if (!member) {
        return false;
    }
    return member.membership === membership;
 };

/**
 * Add a new timeline to this room
 *
 * @return {module:models/event-timeline~EventTimeline} newly-created timeline
 */
Room.prototype.addTimeline = function() {
    if (!this._timelineSupport) {
        throw Error("timeline support is disabled. Set the 'timelineSupport'" +
                    " parameter to true when creating MatrixClient to enable" +
                    " it.");
    }

    var timeline = new EventTimeline(this.roomId);
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
 * @param {module:models/event-timeline~EventTimeline=} timeline   timeline to
 *    add events to. If not given, events will be added to the live timeline
 *
 * @param {string=} paginationToken   token for the next batch of events
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 *
 */
Room.prototype.addEventsToTimeline = function(events, toStartOfTimeline,
                                              timeline, paginationToken) {
    if (!timeline) {
        timeline = this._liveTimeline;
    }

    if (!toStartOfTimeline && timeline == this._liveTimeline) {
        // special treatment for live events
        this._addLiveEvents(events);
        return;
    }

    var direction = toStartOfTimeline ? EventTimeline.BACKWARDS :
        EventTimeline.FORWARDS;
    var inverseDirection = toStartOfTimeline ? EventTimeline.FORWARDS :
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
    // Finally, consider what we want to do with the pagination token. In the
    // case above, we will be given a pagination token which tells us how to
    // get events beyond 'U' - in this case, it makes sense to store this
    // against timeline4. But what if timeline4 already had 'U' and beyond? in
    // that case, our best bet is to throw away the pagination token we were
    // given and stick with whatever token timeline4 had previously. In short,
    // we want to only store the pagination token if the last event we receive
    // is one we didn't previously know about.

    var updateToken = false;
    for (var i = 0; i < events.length; i++) {
        var event = events[i];
        var eventId = event.getId();

        var existingTimeline = this._eventIdToTimeline[eventId];

        if (!existingTimeline) {
            // we don't know about this event yet. Just add it to the timeline.
            this._addEventToTimeline(event, timeline, toStartOfTimeline);
            updateToken = true;
            continue;
        }

        // we already know about this event. We don't want to use the pagination
        // token if this is the last event, as per the text above.
        updateToken = false;

        if (existingTimeline == timeline) {
            console.log("Event " + eventId + " already in timeline " + timeline);
            continue;
        }

        var neighbour = timeline.getNeighbouringTimeline(direction);
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
                console.log("Event " + eventId + " in neighbouring timeline - " +
                            "switching to " + existingTimeline);
            } else {
                console.log("Event " + eventId + " already in a different " +
                            "timeline " + existingTimeline);
            }
            timeline = existingTimeline;
            continue;
        }

        // time to join the timelines.
        console.info("Already have timeline for " + eventId +
                     " - joining timeline " + timeline + " to " +
                     existingTimeline);
        timeline.setNeighbouringTimeline(existingTimeline, direction);
        existingTimeline.setNeighbouringTimeline(timeline, inverseDirection);
        timeline = existingTimeline;
    }

    if (updateToken) {
        timeline.setPaginationToken(paginationToken, direction);
    }
};

/**
 * Check for redactions, and otherwise add event to the given timeline. Assumes
 * we have already checked we don't know about this event.
 *
 * Will fire "Room.timeline" for each event added.
 *
 * @param {MatrixEvent} event
 * @param {EventTimeline} timeline
 * @param {boolean} toStartOfTimeline
 *
 * @param {boolean} spliceBeforeLocalEcho   if true, insert this event before
 *     any localecho events at the end of the timeline. Ignored if
 *     toStartOfTimeline == true.
 *
 * @fires module:client~MatrixClient#event:"Room.timeline"
 *
 * @private
 */
Room.prototype._addEventToTimeline = function(event, timeline, toStartOfTimeline,
                                              spliceBeforeLocalEcho) {
    var eventId = event.getId();
    timeline.addEvent(event, toStartOfTimeline, spliceBeforeLocalEcho);
    this._eventIdToTimeline[eventId] = timeline;

    var data = {
        timeline: timeline,
        liveEvent: !toStartOfTimeline && timeline == this._liveTimeline,
    };
    this.emit("Room.timeline", event, this, Boolean(toStartOfTimeline), false, data);
};


/**
 * Add some events to the end of this room's live timeline. Will fire
 * "Room.timeline" for each event added.
 *
 * @param {MatrixEvent[]} events A list of events to add.
 * @fires module:client~MatrixClient#event:"Room.timeline"
 * @private
 */
Room.prototype._addLiveEvents = function(events) {
    var addLocalEchoToEnd = this._opts.pendingEventOrdering === "end";

    for (var i = 0; i < events.length; i++) {
        var isLocalEcho = (
                events[i].status === EventStatus.SENDING ||
                events[i].status === EventStatus.QUEUED
        );

        // FIXME: HORRIBLE ASSUMPTION THAT THIS PROP EXISTS
        // Exists due to client.js:815 (MatrixClient.sendEvent)
        // We should make txnId a first class citizen.
        if (events[i]._txnId) {
            // this is the outgoing copy of the event (ie, the local echo).
            this._txnToEvent[events[i]._txnId] = events[i];
        }
        else if (events[i].getUnsigned().transaction_id) {
            // remote echo of an event we sent earlier
            var existingEvent = this._txnToEvent[events[i].getUnsigned().transaction_id];
            if (existingEvent) {
                // no longer pending
                delete this._txnToEvent[events[i].getUnsigned().transaction_id];

                // update the timeline map, because the event id has changed
                var existingTimeline = this._eventIdToTimeline[existingEvent.getId()];
                if (existingTimeline) {
                    delete this._eventIdToTimeline[existingEvent.getId()];
                    this._eventIdToTimeline[events[i].getId()] = existingTimeline;
                }

                // replace the event source
                existingEvent.event = events[i].event;
                continue;
            }
        }


        if (events[i].getType() === "m.room.redaction") {
            var redactId = events[i].event.redacts;

            // if we know about this event, redact its contents now.
            var redactedEvent = this.findEventById(redactId);
            if (redactedEvent) {
                redactedEvent.makeRedacted(events[i]);
                this.emit("Room.redaction", events[i], this);

                // TODO: we stash user displaynames (among other things) in
                // RoomMember objects which are then attached to other events
                // (in the sender and target fields). We should get those
                // RoomMember objects to update themselves when the events that
                // they are based on are changed.
            }

            // NB: We continue to add the redaction event to the timeline so
            // clients can say "so and so redacted an event" if they wish to. Also
            // this may be needed to trigger an update.
        }

        var spliceBeforeLocalEcho = !isLocalEcho && addLocalEchoToEnd;

        if (!this._eventIdToTimeline[events[i].getId()]) {
            // TODO: pass through filter to see if this should be added to the timeline.
            this._addEventToTimeline(events[i], this._liveTimeline, false,
                                     spliceBeforeLocalEcho);
        }

        // synthesize and inject implicit read receipts
        // Done after adding the event because otherwise the app would get a read receipt
        // pointing to an event that wasn't yet in the timeline
        //
        // (we don't do this for local echoes, as they have temporary event
        // ids, which don't make much sense as RRs).
        if (events[i].sender && !isLocalEcho) {
            this.addReceipt(synthesizeReceipt(
                events[i].sender.userId, events[i], "m.read"
            ), true);
        }
    }
};

/**
 * Add some events to this room. This can include state events, message
 * events and typing notifications. These events are treated as "live" so
 * they will go to the end of the timeline.
 * @param {MatrixEvent[]} events A list of events to add.
 * @param {string} duplicateStrategy Optional. Applies to events in the
 * timeline only. If this is not specified, no duplicate suppression is
 * performed (this improves performance). If this is 'replace' then if a
 * duplicate is encountered, the event passed to this function will replace the
 * existing event in the timeline. If this is 'ignore', then the event passed to
 * this function will be ignored entirely, preserving the existing event in the
 * timeline. Events are identical based on their event ID <b>only</b>.
 * @throws If <code>duplicateStrategy</code> is not falsey, 'replace' or 'ignore'.
 */
Room.prototype.addEvents = function(events, duplicateStrategy) {
    if (duplicateStrategy && ["replace", "ignore"].indexOf(duplicateStrategy) === -1) {
        throw new Error("duplicateStrategy MUST be either 'replace' or 'ignore'");
    }
    for (var i = 0; i < events.length; i++) {
        if (events[i].getType() === "m.typing") {
            this.currentState.setTypingEvent(events[i]);
        }
        else if (events[i].getType() === "m.receipt") {
            this.addReceipt(events[i]);
        }
        // N.B. account_data is added directly by /sync to avoid
        // having to maintain an event.isAccountData() here
        else {
            var timeline = this._eventIdToTimeline[events[i].getId()];
            if (timeline && duplicateStrategy) {
                // is there a duplicate?
                var shouldIgnore = false;
                var tlEvents = timeline.getEvents();
                for (var j = 0; j < tlEvents.length; j++) {
                    if (tlEvents[j].getId() === events[i].getId()) {
                        if (duplicateStrategy === "replace") {
                            // still need to set the right metadata on this event
                            setEventMetadata(
                                events[i],
                                timeline.getState(EventTimeline.FORWARDS),
                                false
                            );

                            if (!tlEvents[j].encryptedType) {
                                tlEvents[j] = events[i];
                            }
                            // skip the insert so we don't add this event twice.
                            // Don't break in case we replace multiple events.
                            shouldIgnore = true;
                        }
                        else if (duplicateStrategy === "ignore") {
                            shouldIgnore = true;
                            break; // stop searching, we're skipping the insert
                        }
                    }
                }
                if (shouldIgnore) {
                    continue; // skip the insertion of this event.
                }
            }
            // TODO: We should have a filter to say "only add state event
            // types X Y Z to the timeline".
            this._addLiveEvents([events[i]]);
        }
    }
};

/**
 * Removes events from this room.
 * @param {String[]} event_ids A list of event_ids to remove.
 */
Room.prototype.removeEvents = function(event_ids) {
    for (var i = 0; i < event_ids.length; ++i) {
        this.removeEvent(event_ids[i]);
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
Room.prototype.removeEvent = function(eventId) {
    var timeline = this._eventIdToTimeline[eventId];
    if (!timeline) {
        return null;
    }

    var removed = timeline.removeEvent(eventId);
    if (removed) {
        delete this._eventIdToTimeline[eventId];
        var data = {
            timeline: timeline,
        };
        this.emit("Room.timeline", removed, this, undefined, true, data);
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
Room.prototype.compareEventOrdering = function(eventId1, eventId2) {
    if (eventId1 == eventId2) {
        // optimise this case
        return 0;
    }

    var timeline1 = this._eventIdToTimeline[eventId1];
    var timeline2 = this._eventIdToTimeline[eventId2];

    if (timeline1 === undefined) {
        return null;
    }
    if (timeline2 === undefined) {
        return null;
    }

    if (timeline1 === timeline2) {
        // both events are in the same timeline - figure out their
        // relative indices
        var idx1, idx2;
        var events = timeline1.getEvents();
        for (var idx = 0; idx < events.length &&
             (idx1 === undefined || idx2 === undefined); idx++) {
            var evId = events[idx].getId();
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
    var tl = timeline1;
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
 * Recalculate various aspects of the room, including the room name and
 * room summary. Call this any time the room's current state is modified.
 * May fire "Room.name" if the room name is updated.
 * @param {string} userId The client's user ID.
 * @fires module:client~MatrixClient#event:"Room.name"
 */
Room.prototype.recalculate = function(userId) {
    // set fake stripped state events if this is an invite room so logic remains
    // consistent elsewhere.
    var self = this;
    var membershipEvent = this.currentState.getStateEvents(
        "m.room.member", userId
    );
    if (membershipEvent && membershipEvent.getContent().membership === "invite") {
        var strippedStateEvents = membershipEvent.event.invite_room_state || [];
        utils.forEach(strippedStateEvents, function(strippedEvent) {
            var existingEvent = self.currentState.getStateEvents(
                strippedEvent.type, strippedEvent.state_key
            );
            if (!existingEvent) {
                // set the fake stripped event instead
                self.currentState.setStateEvents([new MatrixEvent({
                    type: strippedEvent.type,
                    state_key: strippedEvent.state_key,
                    content: strippedEvent.content,
                    event_id: "$fake" + Date.now(),
                    room_id: self.roomId,
                    user_id: userId // technically a lie
                })]);
            }
        });
    }



    var oldName = this.name;
    this.name = calculateRoomName(this, userId);
    this.summary = new RoomSummary(this.roomId, {
        title: this.name
    });

    if (oldName !== this.name) {
        this.emit("Room.name", this);
    }
};


/**
 * Get a list of user IDs who have <b>read up to</b> the given event.
 * @param {MatrixEvent} event the event to get read receipts for.
 * @return {String[]} A list of user IDs.
 */
Room.prototype.getUsersReadUpTo = function(event) {
    return this.getReceiptsForEvent(event).filter(function(receipt) {
        return receipt.type === "m.read";
    }).map(function(receipt) {
        return receipt.userId;
    });
};

/**
 * Get the ID of the event that a given user has read up to, or null if we
 * have received no read receipts from them.
 * @param {String} userId The user ID to get read receipt event ID for
 * @param {Boolean} ignoreSynthesized If true, return only receipts that have been
 *                                    sent by the server, not implicit ones generated
 *                                    by the JS SDK.
 * @return {String} ID of the latest event that the given user has read, or null.
 */
Room.prototype.getEventReadUpTo = function(userId, ignoreSynthesized) {
    var receipts = this._receipts;
    if (ignoreSynthesized) {
        receipts = this._realReceipts;
    }

    if (
        receipts["m.read"] === undefined ||
        receipts["m.read"][userId] === undefined
    ) {
        return null;
    }

    return receipts["m.read"][userId].eventId;
};

/**
 * Get a list of receipts for the given event.
 * @param {MatrixEvent} event the event to get receipts for
 * @return {Object[]} A list of receipts with a userId, type and data keys or
 * an empty list.
 */
Room.prototype.getReceiptsForEvent = function(event) {
    return this._receiptCacheByEventId[event.getId()] || [];
};

/**
 * Add a receipt event to the room.
 * @param {MatrixEvent} event The m.receipt event.
 * @param {Boolean} fake True if this event is implicit
 */
Room.prototype.addReceipt = function(event, fake) {
    // event content looks like:
    // content: {
    //   $event_id: {
    //     $receipt_type: {
    //       $user_id: {
    //         ts: $timestamp
    //       }
    //     }
    //   }
    // }
    if (fake === undefined) { fake = false; }
    if (!fake) {
        this._addReceiptsToStructure(event, this._realReceipts);
        // we don't bother caching real receipts by event ID
        // as there's nothing that would read it.
    }
    this._addReceiptsToStructure(event, this._receipts);
    this._receiptCacheByEventId = this._buildReciptCache(this._receipts);

    // send events after we've regenerated the cache, otherwise things that
    // listened for the event would read from a stale cache
    this.emit("Room.receipt", event, this);
};

/**
 * Add a receipt event to the room.
 * @param {MatrixEvent} event The m.receipt event.
 * @param {Object} receipts The object to add receipts to
 */
Room.prototype._addReceiptsToStructure = function(event, receipts) {
    var self = this;
    utils.keys(event.getContent()).forEach(function(eventId) {
        utils.keys(event.getContent()[eventId]).forEach(function(receiptType) {
            utils.keys(event.getContent()[eventId][receiptType]).forEach(
            function(userId) {
                var receipt = event.getContent()[eventId][receiptType][userId];

                if (!receipts[receiptType]) {
                    receipts[receiptType] = {};
                }

                var existingReceipt = receipts[receiptType][userId];

                if (!existingReceipt) {
                    receipts[receiptType][userId] = {};
                } else {
                    // we only want to add this receipt if we think it is later
                    // than the one we already have. (This is managed
                    // server-side, but because we synthesize RRs locally we
                    // have to do it here too.)
                    var ordering = self.compareEventOrdering(
                        existingReceipt.eventId, eventId);
                    if (ordering !== null && ordering >= 0) {
                        return;
                    }
                }

                receipts[receiptType][userId] = {
                    eventId: eventId,
                    data: receipt
                };
            });
        });
    });
};

/**
 * Build and return a map of receipts by event ID
 * @param {Object} receipts A map of receipts
 * @return {Object} Map of receipts by event ID
 */
Room.prototype._buildReciptCache = function(receipts) {
    var receiptCacheByEventId = {};
    utils.keys(receipts).forEach(function(receiptType) {
        utils.keys(receipts[receiptType]).forEach(function(userId) {
            var receipt = receipts[receiptType][userId];
            if (!receiptCacheByEventId[receipt.eventId]) {
                receiptCacheByEventId[receipt.eventId] = [];
            }
            receiptCacheByEventId[receipt.eventId].push({
                userId: userId,
                type: receiptType,
                data: receipt.data
            });
        });
    });
    return receiptCacheByEventId;
};


/**
 * Add a temporary local-echo receipt to the room to reflect in the
 * client the fact that we've sent one.
 * @param {string} userId The user ID if the receipt sender
 * @param {MatrixEvent} e The event that is to be acknowledged
 * @param {string} receiptType The type of receipt
 */
Room.prototype._addLocalEchoReceipt = function(userId, e, receiptType) {
    this.addReceipt(synthesizeReceipt(userId, e, receiptType), true);
};

/**
 * Update the room-tag event for the room.  The previous one is overwritten.
 * @param {MatrixEvent} event the m.tag event
 */
Room.prototype.addTags = function(event) {
    // event content looks like:
    // content: {
    //    tags: {
    //       $tagName: { $metadata: $value },
    //       $tagName: { $metadata: $value },
    //    }
    // }

    // XXX: do we need to deep copy here?
    this.tags = event.getContent().tags;

    // XXX: we could do a deep-comparison to see if the tags have really
    // changed - but do we want to bother?
    this.emit("Room.tags", event, this);
};

/**
 * Update the account_data events for this room, overwriting events of the same type.
 * @param {Array<MatrixEvent>} events an array of account_data events to add
 */
Room.prototype.addAccountData = function(events) {
    for (var i = 0; i < events.length; i++) {
        var event = events[i];
        if (event.getType() === "m.tag") {
            this.addTags(event);
        }
        this.accountData[event.getType()] = event;
        this.emit("Room.accountData", event, this);
    }
};

/**
 * Access account_data event of given event type for this room
 * @param {string} type the type of account_data event to be accessed
 * @return {?MatrixEvent} the account_data event in question
 */
Room.prototype.getAccountData = function(type) {
    return this.accountData[type];
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
 * This is an internal method. Calculates the name of the room from the current
 * room state.
 * @param {Room} room The matrix room.
 * @param {string} userId The client's user ID. Used to filter room members
 * correctly.
 * @param {bool} ignoreRoomNameEvent Return the implicit room name that we'd see if there
 * was no m.room.name event.
 * @return {string} The calculated room name.
 */
function calculateRoomName(room, userId, ignoreRoomNameEvent) {
    if (!ignoreRoomNameEvent) {
        // check for an alias, if any. for now, assume first alias is the
        // official one.
        var mRoomName = room.currentState.getStateEvents("m.room.name", "");
        if (mRoomName && mRoomName.getContent() && mRoomName.getContent().name) {
            return mRoomName.getContent().name;
        }
    }

    var alias;
    var canonicalAlias = room.currentState.getStateEvents("m.room.canonical_alias", "");
    if (canonicalAlias) {
        alias = canonicalAlias.getContent().alias;
    }

    if (!alias) {
        var mRoomAliases = room.currentState.getStateEvents("m.room.aliases")[0];
        if (mRoomAliases && utils.isArray(mRoomAliases.getContent().aliases)) {
            alias = mRoomAliases.getContent().aliases[0];
        }
    }
    if (alias) {
        return alias;
    }

    // get members that are NOT ourselves and are actually in the room.
    var otherMembers = utils.filter(room.currentState.getMembers(), function(m) {
        return (m.userId !== userId && m.membership !== "leave");
    });
    var allMembers = utils.filter(room.currentState.getMembers(), function(m) {
        return (m.membership !== "leave");
    });
    var myMemberEventArray = utils.filter(room.currentState.getMembers(), function(m) {
        return (m.userId == userId);
    });
    var myMemberEvent = (
        (myMemberEventArray.length && myMemberEventArray[0].events) ?
            myMemberEventArray[0].events.member.event : undefined
    );

    // TODO: Localisation
    if (myMemberEvent && myMemberEvent.content.membership == "invite") {
        if (room.currentState.getMember(myMemberEvent.sender)) {
            // extract who invited us to the room
            return "Invite from " + room.currentState.getMember(
                myMemberEvent.sender
            ).name;
        } else if (allMembers[0].events.member) {
            // use the sender field from the invite event, although this only
            // gets us the mxid
            return "Invite from " + myMemberEvent.sender;
        } else {
            return "Room Invite";
        }
    }


    if (otherMembers.length === 0) {
        if (allMembers.length === 1) {
            // self-chat, peeked room with 1 participant,
            // or inbound invite, or outbound 3PID invite.
            if (allMembers[0].userId === userId) {
                var thirdPartyInvites =
                    room.currentState.getStateEvents("m.room.third_party_invite");
                if (thirdPartyInvites && thirdPartyInvites.length > 0) {
                    var name = "Inviting " +
                               thirdPartyInvites[0].getContent().display_name;
                    if (thirdPartyInvites.length > 1) {
                        if (thirdPartyInvites.length == 2) {
                            name += " and " +
                                    thirdPartyInvites[1].getContent().display_name;
                        }
                        else {
                            name += " and " +
                                    thirdPartyInvites.length + " others";
                        }
                    }
                    return name;
                }
                else {
                    return "Empty room";
                }
            }
            else {
                return allMembers[0].name;
            }
        }
        else {
            // there really isn't anyone in this room...
            return "Empty room";
        }
    }
    else if (otherMembers.length === 1) {
        return otherMembers[0].name;
    }
    else if (otherMembers.length === 2) {
        return (
            otherMembers[0].name + " and " + otherMembers[1].name
        );
    }
    else {
        return (
            otherMembers[0].name + " and " + (otherMembers.length - 1) + " others"
        );
    }
}

/**
 * The Room class.
 */
module.exports = Room;

/**
 * Fires whenever the timeline in a room is updated.
 * @event module:client~MatrixClient#"Room.timeline"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @param {Room} room The room whose Room.timeline was updated.
 * @param {boolean} toStartOfTimeline True if this event was added to the start
 * @param {boolean} removed True if this event has just been removed from the timeline
 * (beginning; oldest) of the timeline e.g. due to pagination.
 *
 * @param {object} data  more data about the event
 *
 * @param {module:event-timeline.EventTimeline} data.timeline the timeline the
 * event was added to/removed from
 *
 * @param {boolean} data.liveEvent true if the event was a real-time event
 * added to the end of the live timeline
 *
 * @example
 * matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline, data){
 *   if (!toStartOfTimeline && data.liveEvent) {
 *     var messageToAppend = room.timeline.[room.timeline.length - 1];
 *   }
 * });
 */

/**
 * Fires wheneer the live timeline in a room is reset.
 *
 * When we get a 'limited' sync (for example, after a network outage), we reset
 * the live timeline to be empty before adding the recent events to the new
 * timeline. This event is fired after the timeline is reset, and before the
 * new events are added.
 *
 * @event module:clinet~MatrixClient#"Room.timelineReset"
 * @param {Room} room The room whose live timeline was reset.
 */

/**
 * Fires when an event we had previously received is redacted.
 *
 * (Note this is *not* fired when the redaction happens before we receive the
 * event).
 *
 * @event module:client~MatrixClient#"Room.redaction"
 * @param {MatrixEvent} event The matrix event which was redacted
 * @param {Room} room The room containing the redacted event
 */

/**
 * Fires whenever the name of a room is updated.
 * @event module:client~MatrixClient#"Room.name"
 * @param {Room} room The room whose Room.name was updated.
 * @example
 * matrixClient.on("Room.name", function(room){
 *   var newName = room.name;
 * });
 */

/**
 * Fires whenever a receipt is received for a room
 * @event module:client~MatrixClient#"Room.receipt"
 * @param {event} event The receipt event
 * @param {Room} room The room whose receipts was updated.
 * @example
 * matrixClient.on("Room.receipt", function(event, room){
 *   var receiptContent = event.getContent();
 * });
 */

/**
 * Fires whenever a room's tags are updated.
 * @event module:client~MatrixClient#"Room.tags"
 * @param {event} event The tags event
 * @param {Room} room The room whose Room.tags was updated.
 * @example
 * matrixClient.on("Room.tags", function(event, room){
 *   var newTags = event.getContent().tags;
 *   if (newTags["favourite"]) showStar(room);
 * });
 */

/**
 * Fires whenever a room's account_data is updated.
 * @event module:client~MatrixClient#"Room.accountData"
 * @param {event} event The account_data event
 * @param {Room} room The room whose account_data was updated.
 * @example
 * matrixClient.on("Room.accountData", function(event, room){
 *   if (event.getType() === "m.room.colorscheme") {
 *       applyColorScheme(event.getContents());
 *   }
 * });
 */
