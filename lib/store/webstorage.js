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
 * This is an internal module. Implementation details:
 * <pre>
 * Room data is stored as follows:
 *   room_$ROOMID_timeline_$INDEX : [ Event, Event, Event ]
 *   room_$ROOMID_state : {
 *                          pagination_token: <oldState.paginationToken>,
 *                          events: {
 *                            <event_type>: { <state_key> : {JSON} }
 *                          }
 *                        }
 * User data is stored as follows:
 *   user_$USERID : User
 * Sync token:
 *   sync_token : $TOKEN
 *
 * Room Retrieval
 * --------------
 * Retrieving a room requires the $ROOMID which then pulls out the current state
 * from room_$ROOMID_state. A defined starting batch of timeline events are then
 * extracted from the highest numbered $INDEX for room_$ROOMID_timeline_$INDEX
 * (more indices as required). The $INDEX may be negative. These are
 * added to the timeline in the same way as /initialSync (old state will diverge).
 * If there exists a room_$ROOMID_timeline_live key, then a timeline sync should
 * be performed before retrieving.
 *
 * Retrieval of earlier messages
 * -----------------------------
 * The earliest event the Room instance knows about is E. Retrieving earlier
 * messages requires a Room which has a storageToken defined.
 * This token maps to the index I where the Room is at. Events are then retrieved from
 * room_$ROOMID_timeline_{I} and elements before E are extracted. If the limit
 * demands more events, I-1 is retrieved, up until I=min $INDEX where it gives
 * less than the limit. Index may go negative if you have paginated in the past.
 *
 * Full Insertion
 * --------------
 * Storing a room requires the timeline and state keys for $ROOMID to
 * be blown away and completely replaced, which is computationally expensive.
 * Room.timeline is batched according to the given batch size B. These batches
 * are then inserted into storage as room_$ROOMID_timeline_$INDEX. Finally,
 * the current room state is persisted to room_$ROOMID_state.
 *
 * Incremental Insertion
 * ---------------------
 * As events arrive, the store can quickly persist these new events. This
 * involves pushing the events to room_$ROOMID_timeline_live. If the
 * current room state has been modified by the new event, then
 * room_$ROOMID_state should be updated in addition to the timeline.
 *
 * Timeline sync
 * -------------
 * Retrieval of events from the timeline depends on the proper batching of
 * events. This is computationally expensive to perform on every new event, so
 * is deferred by inserting live events to room_$ROOMID_timeline_live. A
 * timeline sync reconciles timeline_live and timeline_$INDEX. This involves
 * retrieving _live and the highest numbered $INDEX batch. If the batch is < B,
 * the earliest entries from _live are inserted into the $INDEX until the
 * batch == B. Then, the remaining entries in _live are batched to $INDEX+1,
 * $INDEX+2, and so on. The easiest way to visualise this is that the timeline
 * goes from old to new, left to right:
 *          -2         -1         0         1
 * <--OLD---------------------------------------NEW-->
 *        [a,b,c]    [d,e,f]   [g,h,i]   [j,k,l]
 *
 * Purging
 * -------
 * Events from the timeline can be purged by removing the lowest
 * timeline_$INDEX in the store.
 *
 * Example
 * -------
 * A room with room_id !foo:bar has 9 messages (M1->9 where 9=newest) with a
 * batch size of 4. The very first time, there is no entry for !foo:bar until
 * storeRoom() is called, which results in the keys: [Full Insert]
 *   room_!foo:bar_timeline_0 : [M1, M2, M3, M4]
 *   room_!foo:bar_timeline_1 : [M5, M6, M7, M8]
 *   room_!foo:bar_timeline_2 : [M9]
 *   room_!foo:bar_state: { ... }
 *
 * 5 new messages (N1-5, 5=newest) arrive and are then added: [Incremental Insert]
 *   room_!foo:bar_timeline_live: [N1]
 *   room_!foo:bar_timeline_live: [N1, N2]
 *   room_!foo:bar_timeline_live: [N1, N2, N3]
 *   room_!foo:bar_timeline_live: [N1, N2, N3, N4]
 *   room_!foo:bar_timeline_live: [N1, N2, N3, N4, N5]
 *
 * App is shutdown. Restarts. The timeline is synced [Timeline Sync]
 *   room_!foo:bar_timeline_2 : [M9, N1, N2, N3]
 *   room_!foo:bar_timeline_3 : [N4, N5]
 *   room_!foo:bar_timeline_live: []
 *
 * And the room is retrieved with 8 messages: [Room Retrieval]
 *   Room.timeline: [M7, M8, M9, N1, N2, N3, N4, N5]
 *   Room.storageToken: => early_index = 1 because that's where M7 is.
 *
 * 3 earlier messages are requested: [Earlier retrieval]
 *   Use storageToken to find batch index 1. Scan batch for earliest event ID.
 *   earliest event = M7
 *   events = room_!foo:bar_timeline_1 where event < M7 = [M5, M6]
 * Too few events, use next index (0) and get 1 more:
 *   events = room_!foo:bar_timeline_0 = [M1, M2, M3, M4] => [M4]
 * Return concatentation:
 *   [M4, M5, M6]
 *
 * Purge oldest events: [Purge]
 *   del room_!foo:bar_timeline_0
 * </pre>
 * @module store/webstorage
 */
var DEBUG = false;  // set true to enable console logging.
var utils = require("../utils");
var Room = require("../models/room");
var User = require("../models/user");
var MatrixEvent = require("../models/event").MatrixEvent;

/**
 * Construct a web storage store, capable of storing rooms and users.
 * @constructor
 * @param {WebStorage} webStore A web storage implementation, e.g.
 * 'window.localStorage' or 'window.sessionStorage' or a custom implementation.
 * @param {integer} batchSize The number of events to store per key/value (room
 * scoped). Use -1 to store all events for a room under one key/value.
 * @throws if the supplied 'store' does not meet the Storage interface of the
 * WebStorage API.
 */
function WebStorageStore(webStore, batchSize) {
    this.store = webStore;
    this.batchSize = batchSize;
    if (!utils.isFunction(webStore.getItem) || !utils.isFunction(webStore.setItem) ||
            !utils.isFunction(webStore.removeItem) || !utils.isFunction(webStore.key)) {
        throw new Error(
            "Supplied webStore does not meet the WebStorage API interface"
        );
    }
    if (!parseInt(webStore.length) && webStore.length !== 0) {
        throw new Error(
            "Supplied webStore does not meet the WebStorage API interface (length)"
        );
    }
    // cached list of room_ids this is storing.
    this._roomIds = [];
    this._syncedWithStore = false;
    // tokens used to remember which index the room instance is at.
    this._tokens = [
        // { earliestIndex: -4 }
    ];
}


/**
 * Retrieve the token to stream from.
 * @return {string} The token or null.
 */
WebStorageStore.prototype.getSyncToken = function() {
    return this.store.getItem("sync_token");
};

/**
 * Set the token to stream from.
 * @param {string} token The token to stream from.
 */
WebStorageStore.prototype.setSyncToken = function(token) {
    this.store.setItem("sync_token", token);
};

/**
 * Store a room in web storage.
 * @param {Room} room
 */
WebStorageStore.prototype.storeRoom = function(room) {
    var serRoom = SerialisedRoom.fromRoom(room, this.batchSize);
    persist(this.store, serRoom);
    if (this._roomIds.indexOf(room.roomId) === -1) {
        this._roomIds.push(room.roomId);
    }
};

/**
 * Retrieve a room from web storage.
 * @param {string} roomId
 * @return {?Room}
 */
WebStorageStore.prototype.getRoom = function(roomId) {
    // probe if room exists; break early if not. Every room should have state.
    if (!getItem(this.store, keyName(roomId, "state"))) {
        debuglog("getRoom: No room with id %s found.", roomId);
        return null;
    }
    var timelineKeys = getTimelineIndices(this.store, roomId);
    if (timelineKeys.indexOf("live") !== -1) {
        debuglog("getRoom: Live events found. Syncing timeline for %s", roomId);
        this._syncTimeline(roomId, timelineKeys);
    }
    return loadRoom(this.store, roomId, this.batchSize, this._tokens);
};

/**
 * Get a list of all rooms from web storage.
 * @return {Array} An empty array.
 */
WebStorageStore.prototype.getRooms = function() {
    var rooms = [];
    var i;
    if (!this._syncedWithStore) {
        // sync with the store to set this._roomIds correctly. We know there is
        // exactly one 'state' key for each room, so we grab them.
        this._roomIds = [];
        for (i = 0; i < this.store.length; i++) {
            if (this.store.key(i).indexOf("room_") === 0 &&
                    this.store.key(i).indexOf("_state") !== -1) {
                // grab the middle bit which is the room ID
                var k = this.store.key(i);
                this._roomIds.push(
                    k.substring("room_".length, k.length - "_state".length)
                );
            }
        }
        this._syncedWithStore = true;
    }
    // call getRoom on each room_id
    for (i = 0; i < this._roomIds.length; i++) {
        var rm = this.getRoom(this._roomIds[i]);
        if (rm) {
            rooms.push(rm);
        }
    }
    return rooms;
};

/**
 * Get a list of summaries from web storage.
 * @return {Array} An empty array.
 */
WebStorageStore.prototype.getRoomSummaries = function() {
    return [];
};

/**
 * Store a user in web storage.
 * @param {User} user
 */
WebStorageStore.prototype.storeUser = function(user) {
    // persist the events used to make the user, we can reconstruct on demand.
    setItem(this.store, "user_" + user.userId, {
        presence: user.events.presence ? user.events.presence.event : null
    });
};

/**
 * Get a user from web storage.
 * @param {string} userId
 * @return {User}
 */
WebStorageStore.prototype.getUser = function(userId) {
    var userData = getItem(this.store, "user_" + userId);
    if (!userData) {
        return null;
    }
    var user = new User(userId);
    if (userData.presence) {
        user.setPresenceEvent(new MatrixEvent(userData.presence));
    }
    return user;
};

/**
 * Retrieve scrollback for this room. Automatically adds events to the timeline.
 * @param {Room} room The matrix room to add the events to the start of the timeline.
 * @param {integer} limit The max number of old events to retrieve.
 * @return {Array<Object>} An array of objects which will be at most 'limit'
 * length and at least 0. The objects are the raw event JSON. The last element
 * is the 'oldest' (for parity with homeserver scrollback APIs).
 */
WebStorageStore.prototype.scrollback = function(room, limit) {
    if (room.storageToken === undefined || room.storageToken >= this._tokens.length) {
        return [];
    }
    // find the index of the earliest event in this room's timeline
    var storeData = this._tokens[room.storageToken] || {};
    var i;
    var earliestIndex = storeData.earliestIndex;
    var earliestEventId = room.timeline[0] ? room.timeline[0].getId() : null;
    debuglog(
        "scrollback in %s (timeline=%s msgs) i=%s, timeline[0].id=%s - req %s events",
        room.roomId, room.timeline.length, earliestIndex, earliestEventId, limit
    );
    var batch = getItem(
        this.store, keyName(room.roomId, "timeline", earliestIndex)
    );
    if (!batch) {
        // bad room or already at start, either way we have nothing to give.
        debuglog("No batch with index %s found.", earliestIndex);
        return [];
    }
    // populate from this batch first
    var scrollback = [];
    var foundEventId = false;
    for (i = batch.length - 1; i >= 0; i--) {
        // go back and find the earliest event ID, THEN start adding entries.
        // Make a MatrixEvent so we don't assume .event_id exists
        // (e.g v2/v3 JSON may be different)
        var matrixEvent = new MatrixEvent(batch[i]);
        if (matrixEvent.getId() === earliestEventId) {
            foundEventId = true;
            debuglog(
                "Found timeline[0] event at position %s in batch %s",
                i, earliestIndex
            );
            continue;
        }
        if (!foundEventId) {
            continue;
        }
        // add entry
        debuglog("Add event at position %s in batch %s", i, earliestIndex);
        scrollback.push(batch[i]);
        if (scrollback.length === limit) {
            break;
        }
    }
    if (scrollback.length === limit) {
        debuglog("Batch has enough events to satisfy request.");
        return scrollback;
    }
    if (!foundEventId) {
        // the earliest index batch didn't contain the event. In other words,
        // this timeline is at a state we don't know, so bail.
        debuglog(
            "Failed to find event ID %s in batch %s", earliestEventId, earliestIndex
        );
        return [];
    }

    // get the requested earlier events from earlier batches
    while (scrollback.length < limit) {
        earliestIndex--;
        batch = getItem(
            this.store, keyName(room.roomId, "timeline", earliestIndex)
        );
        if (!batch) {
            // no more events
            debuglog("No batch found at index %s", earliestIndex);
            break;
        }
        for (i = batch.length - 1; i >= 0; i--) {
            debuglog("Add event at position %s in batch %s", i, earliestIndex);
            scrollback.push(batch[i]);
            if (scrollback.length === limit) {
                break;
            }
        }
    }
    debuglog(
        "Out of %s requested events, returning %s. New index=%s",
        limit, scrollback.length, earliestIndex
    );
    room.addEventsToTimeline(utils.map(scrollback, function(e) {
            return new MatrixEvent(e);
    }), true, room.getLiveTimeline());

    this._tokens[room.storageToken] = {
        earliestIndex: earliestIndex
    };
    return scrollback;
};

/**
 * Store events for a room. The events have already been added to the timeline.
 * @param {Room} room The room to store events for.
 * @param {Array<MatrixEvent>} events The events to store.
 * @param {string} token The token associated with these events.
 * @param {boolean} toStart True if these are paginated results. The last element
 * is the 'oldest' (for parity with homeserver scrollback APIs).
 */
WebStorageStore.prototype.storeEvents = function(room, events, token, toStart) {
    if (toStart) {
        // add paginated events to lowest batch indexes (can go -ve)
        var lowIndex = getIndexExtremity(
            getTimelineIndices(this.store, room.roomId), true
        );
        var i, key, batch;
        for (i = 0; i < events.length; i++) { // loop events to be stored
            key = keyName(room.roomId, "timeline", lowIndex);
            batch = getItem(this.store, key) || [];
            while (batch.length < this.batchSize && i < events.length) {
                batch.unshift(events[i].event);
                i++; // increment to insert next event into this batch
            }
            i--; // decrement to avoid skipping one (for loop ++s)
            setItem(this.store, key, batch);
            lowIndex--; // decrement index to get a new batch.
        }
    }
    else {
        // dump as live events
        var liveEvents = getItem(
            this.store, keyName(room.roomId, "timeline", "live")
        ) || [];
        debuglog(
            "Adding %s events to %s live list (which has %s already)",
            events.length, room.roomId, liveEvents.length
        );
        var updateState = false;
        liveEvents = liveEvents.concat(utils.map(events, function(me) {
            // cheeky check to avoid looping twice
            if (me.isState()) {
                updateState = true;
            }
            return me.event;
        }));
        setItem(
            this.store, keyName(room.roomId, "timeline", "live"), liveEvents
        );
        if (updateState) {
            debuglog("Storing state for %s as new events updated state", room.roomId);
            // use 0 batch size; we don't care about batching right now.
            var serRoom = SerialisedRoom.fromRoom(room, 0);
            setItem(this.store, keyName(serRoom.roomId, "state"), serRoom.state);
        }
    }
};

/**
 * Sync the 'live' timeline, batching live events according to 'batchSize'.
 * @param {string} roomId The room to sync the timeline.
 * @param {Array<String>} timelineIndices Optional. The indices in the timeline
 * if known already.
 */
WebStorageStore.prototype._syncTimeline = function(roomId, timelineIndices) {
    timelineIndices = timelineIndices || getTimelineIndices(this.store, roomId);
    var liveEvents = getItem(this.store, keyName(roomId, "timeline", "live")) || [];

    // get the highest numbered $INDEX batch
    var highestIndex = getIndexExtremity(timelineIndices);
    var hiKey = keyName(roomId, "timeline", highestIndex);
    var hiBatch = getItem(this.store, hiKey) || [];
    // fill up the existing batch first.
    while (hiBatch.length < this.batchSize && liveEvents.length > 0) {
        hiBatch.push(liveEvents.shift());
    }
    setItem(this.store, hiKey, hiBatch);

    // start adding new batches as required
    var batch = [];
    while (liveEvents.length > 0) {
        batch.push(liveEvents.shift());
        if (batch.length === this.batchSize || liveEvents.length === 0) {
            // persist the full batch and make another
            highestIndex++;
            hiKey = keyName(roomId, "timeline", highestIndex);
            setItem(this.store, hiKey, batch);
            batch = [];
        }
    }
    // reset live array
    setItem(this.store, keyName(roomId, "timeline", "live"), []);
};


/**
 * Store a filter.
 * @param {Filter} filter
 */
WebStorageStore.prototype.storeFilter = function(filter) {
};

/**
 * Retrieve a filter.
 * @param {string} userId
 * @param {string} filterId
 * @return {?Filter} A filter or null.
 */
WebStorageStore.prototype.getFilter = function(userId, filterId) {
    return null;
};

function SerialisedRoom(roomId) {
    this.state = {
        events: {}
    };
    this.timeline = {
        // $INDEX: []
    };
    this.roomId = roomId;
}

/**
 * Convert a Room instance into a SerialisedRoom instance which can be stored
 * in the key value store.
 * @param {Room} room The matrix room to convert
 * @param {integer} batchSize The number of events per timeline batch
 * @return {SerialisedRoom} A serialised room representation of 'room'.
 */
SerialisedRoom.fromRoom = function(room, batchSize) {
    var self = new SerialisedRoom(room.roomId);
    var index;
    self.state.pagination_token = room.oldState.paginationToken;
    // [room_$ROOMID_state] downcast to POJO from MatrixEvent
    utils.forEach(utils.keys(room.currentState.events), function(eventType) {
        utils.forEach(utils.keys(room.currentState.events[eventType]), function(skey) {
            if (!self.state.events[eventType]) {
                self.state.events[eventType] = {};
            }
            self.state.events[eventType][skey] = (
                room.currentState.events[eventType][skey].event
            );
        });
    });

    // [room_$ROOMID_timeline_$INDEX]
    if (batchSize > 0) {
        index = 0;
        while (index * batchSize < room.timeline.length) {
            self.timeline[index] = room.timeline.slice(
                index * batchSize, (index + 1) * batchSize
            );
            self.timeline[index] = utils.map(self.timeline[index], function(me) {
                // use POJO not MatrixEvent
                return me.event;
            });
            index++;
        }
    }
    else { // don't batch
        self.timeline[0] = utils.map(room.timeline, function(matrixEvent) {
            return matrixEvent.event;
        });
    }
    return self;
};

function loadRoom(store, roomId, numEvents, tokenArray) {
    var room = new Room(roomId, {
        storageToken: tokenArray.length
    });

    // populate state (flatten nested struct to event array)
    var currentStateMap = getItem(store, keyName(roomId, "state"));
    var stateEvents = [];
    utils.forEach(utils.keys(currentStateMap.events), function(eventType) {
        utils.forEach(utils.keys(currentStateMap.events[eventType]), function(skey) {
            stateEvents.push(currentStateMap.events[eventType][skey]);
        });
    });
    // TODO: Fix logic dupe with MatrixClient._processRoomEvents
    var oldStateEvents = utils.map(
        utils.deepCopy(stateEvents), function(e) {
            return new MatrixEvent(e);
        }
    );
    var currentStateEvents = utils.map(stateEvents, function(e) {
            return new MatrixEvent(e);
        }
    );
    room.oldState.setStateEvents(oldStateEvents);
    room.currentState.setStateEvents(currentStateEvents);

    // add most recent numEvents
    var recentEvents = [];
    var index = getIndexExtremity(getTimelineIndices(store, roomId));
    var eventIndex = index;
    var i, key, batch;
    while (recentEvents.length < numEvents) {
        key = keyName(roomId, "timeline", index);
        batch = getItem(store, key) || [];
        if (batch.length === 0) {
            // nothing left in the store.
            break;
        }
        for (i = batch.length - 1; i >= 0; i--) {
            recentEvents.unshift(new MatrixEvent(batch[i]));
            if (recentEvents.length === numEvents) {
                eventIndex = index;
                break;
            }
        }
        index--;
    }
    // add events backwards to diverge old state correctly.
    room.addEventsToTimeline(recentEvents.reverse(), true, room.getLiveTimeline());
    room.oldState.paginationToken = currentStateMap.pagination_token;
    // set the token data to let us know which index this room instance is at
    // for scrollback.
    tokenArray.push({
        earliestIndex: eventIndex
    });
    return room;
}

function persist(store, serRoom) {
    setItem(store, keyName(serRoom.roomId, "state"), serRoom.state);
    utils.forEach(utils.keys(serRoom.timeline), function(index) {
        setItem(store,
            keyName(serRoom.roomId, "timeline", index),
            serRoom.timeline[index]
        );
    });
}

function getTimelineIndices(store, roomId) {
    var keys = [];
    for (var i = 0; i < store.length; i++) {
        if (store.key(i).indexOf(keyName(roomId, "timeline_")) !== -1) {
            // e.g. room_$ROOMID_timeline_0  =>  0
            keys.push(
                store.key(i).replace(keyName(roomId, "timeline_"), "")
            );
        }
    }
    return keys;
}

function getIndexExtremity(timelineIndices, getLowest) {
    var extremity, index;
    for (var i = 0; i < timelineIndices.length; i++) {
        index = parseInt(timelineIndices[i]);
        if (!isNaN(index) && (
                extremity === undefined ||
                !getLowest && index > extremity ||
                getLowest && index < extremity)) {
            extremity = index;
        }
    }
    return extremity;
}

function keyName(roomId, key, index) {
    return "room_" + roomId + "_" + key + (
        index === undefined ? "" : ("_" + index)
    );
}

function getItem(store, key) {
    try {
        return JSON.parse(store.getItem(key));
    }
    catch (e) {
        debuglog("Failed to get key %s: %s", key, e);
        debuglog(e.stack);
    }
    return null;
}

function setItem(store, key, val) {
    store.setItem(key, JSON.stringify(val));
}

function debuglog() {
    if (DEBUG) {
        console.log.apply(console, arguments);
    }
}

/*
function delRoomStruct(store, roomId) {
    var prefix = "room_" + roomId;
    var keysToRemove = [];
    for (var i = 0; i < store.length; i++) {
        if (store.key(i).indexOf(prefix) !== -1) {
            keysToRemove.push(store.key(i));
        }
    }
    utils.forEach(keysToRemove, function(key) {
        store.removeItem(key);
    });
} */

/** Web Storage Store class. */
module.exports = WebStorageStore;
