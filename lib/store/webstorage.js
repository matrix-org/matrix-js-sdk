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

var utils = require("../utils");
var Room = require("../models/room");
var MatrixEvent = require("../models/event").MatrixEvent;

/**
 * Construct a web storage store, capable of storing rooms and users.
 * @constructor
 * @param {WebStorage} store A web storage implementation, e.g.
 * 'window.localStorage' or 'window.sessionStorage' or a custom implementation.
 * @param {integer} batchSize The number of events to store per key/value (room
 * scoped). Use -1 to store all events for a room under one key/value.
 * @throws if the supplied 'store' does not meet the Storage interface of the
 * WebStorage API.
 */
function WebStorageStore(store, batchSize) {
    this.store = store;
    this.batchSize = batchSize;
    if (!utils.isFunction(store.getItem) || !utils.isFunction(store.setItem) ||
            !utils.isFunction(store.removeItem) || !utils.isFunction(store.key)) {
        throw new Error(
            "Supplied store does not meet the WebStorage API interface"
        );
    }
    if (!parseInt(store.length) && store.length !== 0) {
        throw new Error(
            "Supplied store does not meet the WebStorage API interface (length)"
        );
    }
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
};

/**
 * Retrieve a room from web storage.
 * @param {string} roomId
 * @return {?Room}
 */
WebStorageStore.prototype.getRoom = function(roomId) {
    // probe if room exists; break early if not. Every room should have state.
    if (!this.store.getItem(keyName(roomId, "state"))) {
        return null;
    }
    var timelineKeys = getTimelineIndices(this.store, roomId);
    if (timelineKeys.indexOf("live") !== -1) {
        this._syncTimeline(roomId, timelineKeys);
    }
    return loadRoom(this.store, roomId, this.batchSize);
};

/**
 * Get a list of all rooms from web storage.
 * @return {Array} An empty array.
 */
WebStorageStore.prototype.getRooms = function() {
    return [];
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
};

/**
 * Get a user from web storage.
 * @param {string} userId
 * @return {null}
 */
WebStorageStore.prototype.getUser = function(userId) {
    return null;
};

/**
 * Retrieve scrollback for this room.
 * @param {Room} room The matrix room
 * @param {integer} limit The max number of old events to retrieve.
 * @return {Array<Object>} An array of objects which will be at most 'limit'
 * length and at least 0. The objects are the raw event JSON.
 */
WebStorageStore.prototype.scrollback = function(room, limit) {
    return [];
};

/**
 * Sync the 'live' timeline, batching live events according to 'batchSize'.
 * @param {string} roomId The room to sync the timeline.
 * @param {Array<String>} timelineIndices Optional. The indices in the timeline
 * if known already.
 */
WebStorageStore.prototype._syncTimeline = function(roomId, timelineIndices) {
    timelineIndices = timelineIndices || getTimelineIndices(this.store, roomId);
    var liveEvents = this.store.getItem(keyName(roomId, "timeline", "live")) || [];

    // get the highest numbered $INDEX batch
    var highestIndex = getHighestIndex(timelineIndices);
    var hiKey = keyName(roomId, "timeline", highestIndex);
    var hiBatch = this.store.getItem(hiKey) || [];
    // fill up the existing batch first.
    while (hiBatch.length < this.batchSize && liveEvents.length > 0) {
        hiBatch.push(liveEvents.shift());
    }
    this.store.setItem(hiKey, hiBatch);

    // start adding new batches as required
    var batch = [];
    while (liveEvents.length > 0) {
        batch.push(liveEvents.shift());
        if (batch.length === this.batchSize || liveEvents.length === 0) {
            // persist the full batch and make another
            highestIndex++;
            hiKey = keyName(roomId, "timeline", highestIndex);
            this.store.setItem(hiKey, batch);
            batch = [];
        }
    }
    // reset live array
    this.store.setItem(keyName(roomId, "timeline", "live"), []);
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

function loadRoom(store, roomId, numEvents) {
    var room = new Room(roomId);
    // populate state (flatten nested struct to event array)
    var currentStateMap = store.getItem(keyName(roomId, "state"));
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
    var index = getHighestIndex(getTimelineIndices(store, roomId));
    var i, key, batch;
    while (recentEvents.length < numEvents) {
        key = keyName(roomId, "timeline", index);
        batch = store.getItem(key) || [];
        if (batch.length === 0) {
            // nothing left in the store.
            break;
        }
        for (i = batch.length - 1; i >= 0; i--) {
            recentEvents.unshift(new MatrixEvent(batch[i]));
            if (recentEvents.length === numEvents) {
                break;
            }
        }
        index--;
    }
    // add events backwards to diverge old state correctly.
    room.addEventsToTimeline(recentEvents.reverse(), true);
    room.oldState.paginationToken = currentStateMap.pagination_token;
    return room;
}

function persist(store, serRoom) {
    store.setItem(keyName(serRoom.roomId, "state"), serRoom.state);
    utils.forEach(utils.keys(serRoom.timeline), function(index) {
        store.setItem(
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

function getHighestIndex(timelineIndices) {
    var highestIndex, index;
    for (var i = 0; i < timelineIndices.length; i++) {
        index = parseInt(timelineIndices[i]);
        if (!isNaN(index) && (highestIndex === undefined || index > highestIndex)) {
            highestIndex = index;
        }
    }
    return highestIndex;
}

function keyName(roomId, key, index) {
    return "room_" + roomId + "_" + key + (
        index === undefined ? "" : ("_" + index)
    );
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
