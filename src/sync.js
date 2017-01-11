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

/*
 * TODO:
 * This class mainly serves to take all the syncing logic out of client.js and
 * into a separate file. It's all very fluid, and this class gut wrenches a lot
 * of MatrixClient props (e.g. _http). Given we want to support WebSockets as
 * an alternative syncing API, we may want to have a proper syncing interface
 * for HTTP and WS at some point.
 */
var q = require("q");
var User = require("./models/user");
var Room = require("./models/room");
var utils = require("./utils");
var Filter = require("./filter");
var EventTimeline = require("./models/event-timeline");

var DEBUG = true;

// /sync requests allow you to set a timeout= but the request may continue
// beyond that and wedge forever, so we need to track how long we are willing
// to keep open the connection. This constant is *ADDED* to the timeout= value
// to determine the max time we're willing to wait.
var BUFFER_PERIOD_MS = 80 * 1000;

function getFilterName(userId, suffix) {
    // scope this on the user ID because people may login on many accounts
    // and they all need to be stored!
    return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
}

function debuglog() {
    if (!DEBUG) { return; }
    console.log.apply(console, arguments);
}


/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @constructor
 * @param {MatrixClient} client The matrix client instance to use.
 * @param {Object} opts Config options
 */
function SyncApi(client, opts) {
    this.client = client;
    opts = opts || {};
    opts.initialSyncLimit = (
        opts.initialSyncLimit === undefined ? 8 : opts.initialSyncLimit
    );
    opts.resolveInvitesToProfiles = opts.resolveInvitesToProfiles || false;
    opts.pollTimeout = opts.pollTimeout || (30 * 1000);
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";
    this.opts = opts;
    this._peekRoomId = null;
    this._currentSyncRequest = null;
    this._syncState = null;
    this._running = false;
    this._keepAliveTimer = null;
    this._connectionReturnedDefer = null;
    this._notifEvents = []; // accumulator of sync events in the current sync response

    if (client.getNotifTimelineSet()) {
        reEmit(client, client.getNotifTimelineSet(),
               ["Room.timeline", "Room.timelineReset"]);
    }
}

/**
 * @param {string} roomId
 * @return {Room}
 */
SyncApi.prototype.createRoom = function(roomId) {
    var client = this.client;
    var room = new Room(roomId, {
        pendingEventOrdering: this.opts.pendingEventOrdering,
        timelineSupport: client.timelineSupport,
    });
    reEmit(client, room, ["Room.name", "Room.timeline", "Room.redaction",
                          "Room.receipt", "Room.tags",
                          "Room.timelineReset",
                          "Room.localEchoUpdated",
                          "Room.accountData",
                         ]);
    this._registerStateListeners(room);
    return room;
};

/**
 * @param {Room} room
 * @private
 */
SyncApi.prototype._registerStateListeners = function(room) {
    var client = this.client;
    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember"
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership"
            ]
        );
    });
};

/**
 * @param {Room} room
 * @private
 */
SyncApi.prototype._deregisterStateListeners = function(room) {
    // could do with a better way of achieving this.
    room.currentState.removeAllListeners("RoomState.events");
    room.currentState.removeAllListeners("RoomState.members");
    room.currentState.removeAllListeners("RoomState.newMember");
};


/**
 * Sync rooms the user has left.
 * @return {Promise} Resolved when they've been added to the store.
 */
SyncApi.prototype.syncLeftRooms = function() {
    var client = this.client;
    var self = this;

    // grab a filter with limit=1 and include_leave=true
    var filter = new Filter(this.client.credentials.userId);
    filter.setTimelineLimit(1);
    filter.setIncludeLeaveRooms(true);

    var localTimeoutMs = this.opts.pollTimeout + BUFFER_PERIOD_MS;
    var qps = {
        timeout: 0 // don't want to block since this is a single isolated req
    };

    return client.getOrCreateFilter(
        getFilterName(client.credentials.userId, "LEFT_ROOMS"), filter
    ).then(function(filterId) {
        qps.filter = filterId;
        return client._http.authedRequest(
            undefined, "GET", "/sync", qps, undefined, localTimeoutMs
        );
    }).then(function(data) {
        var leaveRooms = [];
        if (data.rooms && data.rooms.leave) {
            leaveRooms = self._mapSyncResponseToRoomArray(data.rooms.leave);
        }
        var rooms = [];
        leaveRooms.forEach(function(leaveObj) {
            var room = leaveObj.room;
            rooms.push(room);
            if (!leaveObj.isBrandNewRoom) {
                // the intention behind syncLeftRooms is to add in rooms which were
                // *omitted* from the initial /sync. Rooms the user were joined to
                // but then left whilst the app is running will appear in this list
                // and we do not want to bother with them since they will have the
                // current state already (and may get dupe messages if we add
                // yet more timeline events!), so skip them.
                // NB: When we persist rooms to localStorage this will be more
                //     complicated...
                return;
            }
            leaveObj.timeline = leaveObj.timeline || {};
            var timelineEvents =
                self._mapSyncEventsFormat(leaveObj.timeline, room);
            var stateEvents = self._mapSyncEventsFormat(leaveObj.state, room);

            // set the back-pagination token. Do this *before* adding any
            // events so that clients can start back-paginating.
            room.getLiveTimeline().setPaginationToken(leaveObj.timeline.prev_batch,
                                                      EventTimeline.BACKWARDS);

            self._processRoomEvents(room, stateEvents, timelineEvents);

            room.recalculate(client.credentials.userId);
            client.store.storeRoom(room);
            client.emit("Room", room);
        });
        return rooms;
    });
};

/**
 * Peek into a room. This will result in the room in question being synced so it
 * is accessible via getRooms(). Live updates for the room will be provided.
 * @param {string} roomId The room ID to peek into.
 * @return {Promise} A promise which resolves once the room has been added to the
 * store.
 */
SyncApi.prototype.peek = function(roomId) {
    var self = this;
    var client = this.client;
    this._peekRoomId = roomId;
    return this.client.roomInitialSync(roomId, 20).then(function(response) {
        // make sure things are init'd
        response.messages = response.messages || {};
        response.messages.chunk = response.messages.chunk || [];
        response.state = response.state || [];

        var peekRoom = self.createRoom(roomId);

        // FIXME: Mostly duplicated from _processRoomEvents but not entirely
        // because "state" in this API is at the BEGINNING of the chunk
        var oldStateEvents = utils.map(
            utils.deepCopy(response.state), client.getEventMapper()
        );
        var stateEvents = utils.map(
            response.state, client.getEventMapper()
        );
        var messages = utils.map(
            response.messages.chunk, client.getEventMapper()
        );

        // XXX: copypasted from /sync until we kill off this
        // minging v1 API stuff)
        // handle presence events (User objects)
        if (response.presence && utils.isArray(response.presence)) {
            response.presence.map(client.getEventMapper()).forEach(
            function(presenceEvent) {
                var user = client.store.getUser(presenceEvent.getContent().user_id);
                if (user) {
                    user.setPresenceEvent(presenceEvent);
                }
                else {
                    user = createNewUser(client, presenceEvent.getContent().user_id);
                    user.setPresenceEvent(presenceEvent);
                    client.store.storeUser(user);
                }
                client.emit("event", presenceEvent);
            });
        }

        // set the pagination token before adding the events in case people
        // fire off pagination requests in response to the Room.timeline
        // events.
        if (response.messages.start) {
            peekRoom.oldState.paginationToken = response.messages.start;
        }

        // set the state of the room to as it was after the timeline executes
        peekRoom.oldState.setStateEvents(oldStateEvents);
        peekRoom.currentState.setStateEvents(stateEvents);

        self._resolveInvites(peekRoom);
        peekRoom.recalculate(self.client.credentials.userId);

        // roll backwards to diverge old state. addEventsToTimeline
        // will overwrite the pagination token, so make sure it overwrites
        // it with the right thing.
        peekRoom.addEventsToTimeline(messages.reverse(), true,
                                     peekRoom.getLiveTimeline(),
                                     response.messages.start);

        client.store.storeRoom(peekRoom);
        client.emit("Room", peekRoom);

        self._peekPoll(roomId);
        return peekRoom;
    });
};

/**
 * Stop polling for updates in the peeked room. NOPs if there is no room being
 * peeked.
 */
SyncApi.prototype.stopPeeking = function() {
    this._peekRoomId = null;
};

/**
 * Do a peek room poll.
 * @param {string} roomId
 * @param {string} token from= token
 */
SyncApi.prototype._peekPoll = function(roomId, token) {
    if (this._peekRoomId !== roomId) {
        debuglog("Stopped peeking in room %s", roomId);
        return;
    }

    var self = this;
    // FIXME: gut wrenching; hard-coded timeout values
    this.client._http.authedRequest(undefined, "GET", "/events", {
        room_id: roomId,
        timeout: 30 * 1000,
        from: token
    }, undefined, 50 * 1000).done(function(res) {

        // We have a problem that we get presence both from /events and /sync
        // however, /sync only returns presence for users in rooms
        // you're actually joined to.
        // in order to be sure to get presence for all of the users in the
        // peeked room, we handle presence explicitly here. This may result
        // in duplicate presence events firing for some users, which is a
        // performance drain, but such is life.
        // XXX: copypasted from /sync until we can kill this minging v1 stuff.

        res.chunk.filter(function(e) {
            return e.type === "m.presence";
        }).map(self.client.getEventMapper()).forEach(function(presenceEvent) {
            var user = self.client.store.getUser(presenceEvent.getContent().user_id);
            if (user) {
                user.setPresenceEvent(presenceEvent);
            }
            else {
                user = createNewUser(self.client, presenceEvent.getContent().user_id);
                user.setPresenceEvent(presenceEvent);
                self.client.store.storeUser(user);
            }
            self.client.emit("event", presenceEvent);
        });

        // strip out events which aren't for the given room_id (e.g presence)
        var events = res.chunk.filter(function(e) {
            return e.room_id === roomId;
        }).map(self.client.getEventMapper());
        var room = self.client.getRoom(roomId);
        room.addLiveEvents(events);
        self._peekPoll(roomId, res.end);
    }, function(err) {
        console.error("[%s] Peek poll failed: %s", roomId, err);
        setTimeout(function() {
            self._peekPoll(roomId, token);
        }, 30 * 1000);
    });
};

/**
 * Returns the current state of this sync object
 * @see module:client~MatrixClient#event:"sync"
 * @return {?String}
 */
SyncApi.prototype.getSyncState = function() {
    return this._syncState;
};

/**
 * Main entry point
 */
SyncApi.prototype.sync = function() {
    debuglog("SyncApi.sync: starting with sync token " +
             this.client.store.getSyncToken());

    var client = this.client;
    var self = this;

    this._running = true;

    if (global.document) {
        this._onOnlineBound = this._onOnline.bind(this);
        global.document.addEventListener("online", this._onOnlineBound, false);
    }

    // We need to do one-off checks before we can begin the /sync loop.
    // These are:
    //   1) We need to get push rules so we can check if events should bing as we get
    //      them from /sync.
    //   2) We need to get/create a filter which we can use for /sync.

    function getPushRules() {
        client.getPushRules().done(function(result) {
            debuglog("Got push rules");
            client.pushRules = result;
            getFilter(); // Now get the filter
        }, function(err) {
            self._startKeepAlives().done(function() {
                getPushRules();
            });
            self._updateSyncState("ERROR", { error: err });
        });
    }

    function getFilter() {
        var filter;
        if (self.opts.filter) {
            filter = self.opts.filter;
        } else {
            filter = new Filter(client.credentials.userId);
            filter.setTimelineLimit(self.opts.initialSyncLimit);
        }

        client.getOrCreateFilter(
            getFilterName(client.credentials.userId), filter
        ).done(function(filterId) {
            // reset the notifications timeline to prepare it to paginate from
            // the current point in time.
            // The right solution would be to tie /sync pagination tokens into
            // /notifications API somehow.
            client.resetNotifTimelineSet();

            self._sync({ filterId: filterId });
        }, function(err) {
            self._startKeepAlives().done(function() {
                getFilter();
            });
            self._updateSyncState("ERROR", { error: err });
        });
    }

    if (client.isGuest()) {
        // no push rules for guests, no access to POST filter for guests.
        self._sync({});
    }
    else {
        getPushRules();
    }
};

/**
 * Stops the sync object from syncing.
 */
SyncApi.prototype.stop = function() {
    debuglog("SyncApi.stop");
    if (global.document) {
        global.document.removeEventListener("online", this._onOnlineBound, false);
        this._onOnlineBound = undefined;
    }
    this._running = false;
    if (this._currentSyncRequest) { this._currentSyncRequest.abort(); }
    if (this._keepAliveTimer) {
        clearTimeout(this._keepAliveTimer);
        this._keepAliveTimer = null;
    }
};

/**
 * Retry a backed off syncing request immediately. This should only be used when
 * the user <b>explicitly</b> attempts to retry their lost connection.
 * @return {boolean} True if this resulted in a request being retried.
 */
SyncApi.prototype.retryImmediately = function() {
    if (!this._connectionReturnedDefer) { return false; }
    this._startKeepAlives(0);
    return true;
};

/**
 * Invoke me to do /sync calls
 * @param {Object} syncOptions
 * @param {string} syncOptions.filterId
 * @param {boolean} syncOptions.hasSyncedBefore
 */
SyncApi.prototype._sync = function(syncOptions) {
    var client = this.client;
    var self = this;

    if (!this._running) {
        debuglog("Sync no longer running: exiting.");
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.reject();
            self._connectionReturnedDefer = null;
        }
        this._updateSyncState("STOPPED");
        return;
    }

    var filterId = syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = this._getGuestFilter();
    }

    var syncToken = client.store.getSyncToken();

    var qps = {
        filter: filterId,
        timeout: this.opts.pollTimeout,
    };

    if (syncToken) {
        qps.since = syncToken;
    } else {
        // use a cachebuster for initialsyncs, to make sure that
        // we don't get a stale sync
        // (https://github.com/vector-im/vector-web/issues/1354)
        qps._cacheBuster = Date.now();
    }

    if (this.getSyncState() == 'ERROR' || this.getSyncState() == 'RECONNECTING') {
        // we think the connection is dead. If it comes back up, we won't know
        // about it till /sync returns. If the timeout= is high, this could
        // be a long time. Set it to 0 when doing retries so we don't have to wait
        // for an event or a timeout before emiting the SYNCING event.
        qps.timeout = 0;
    }

    // normal timeout= plus buffer time
    var clientSideTimeoutMs = this.opts.pollTimeout + BUFFER_PERIOD_MS;

    this._currentSyncRequest = client._http.authedRequest(
        undefined, "GET", "/sync", qps, undefined, clientSideTimeoutMs
    );

    this._currentSyncRequest.done(function(data) {
        // set the sync token NOW *before* processing the events. We do this so
        // if something barfs on an event we can skip it rather than constantly
        // polling with the same token.
        client.store.setSyncToken(data.next_batch);

        try {
            self._processSyncResponse(syncToken, data);
        }
        catch (e) {
            // log the exception with stack if we have it, else fall back
            // to the plain description
            console.error("Caught /sync error", e.stack || e);
        }

        // emit synced events
        if (!syncOptions.hasSyncedBefore) {
            self._updateSyncState("PREPARED");
            syncOptions.hasSyncedBefore = true;
        }

        // keep emitting SYNCING -> SYNCING for clients who want to do bulk updates
        self._updateSyncState("SYNCING");

        self._sync(syncOptions);
    }, function(err) {
        if (!self._running) {
            debuglog("Sync no longer running: exiting");
            if (self._connectionReturnedDefer) {
                self._connectionReturnedDefer.reject();
                self._connectionReturnedDefer = null;
            }
            self._updateSyncState("STOPPED");
            return;
        }
        console.error("/sync error %s", err);
        console.error(err);

        debuglog("Starting keep-alive");
        // Note that we do *not* mark the sync connection as
        // lost yet: we only do this if a keepalive poke
        // fails, since long lived HTTP connections will
        // go away sometimes and we shouldn't treat this as
        // erroneous. We set the state to 'reconnecting'
        // instead, so that clients can onserve this state
        // if they wish.
        self._startKeepAlives().done(function() {
            self._sync(syncOptions);
        });
        self._currentSyncRequest = null;
        self._updateSyncState("RECONNECTING");
    });
};

/**
 * Process data returned from a sync response and propagate it
 * into the model objects
 *
 * @param {string} syncToken the old next_batch token sent to this
 *    sync request.
 * @param {Object} data The response from /sync
 */
SyncApi.prototype._processSyncResponse = function(syncToken, data) {
    var client = this.client;
    var self = this;

    // data looks like:
    // {
    //    next_batch: $token,
    //    presence: { events: [] },
    //    account_data: { events: [] },
    //    to_device: { events: [] },
    //    rooms: {
    //      invite: {
    //        $roomid: {
    //          invite_state: { events: [] }
    //        }
    //      },
    //      join: {
    //        $roomid: {
    //          state: { events: [] },
    //          timeline: { events: [], prev_batch: $token, limited: true },
    //          ephemeral: { events: [] },
    //          account_data: { events: [] },
    //          unread_notifications: {
    //              highlight_count: 0,
    //              notification_count: 0,
    //          }
    //        }
    //      },
    //      leave: {
    //        $roomid: {
    //          state: { events: [] },
    //          timeline: { events: [], prev_batch: $token }
    //        }
    //      }
    //    },
    // }

    // TODO-arch:
    // - Each event we pass through needs to be emitted via 'event', can we
    //   do this in one place?
    // - The isBrandNewRoom boilerplate is boilerplatey.

    // handle presence events (User objects)
    if (data.presence && utils.isArray(data.presence.events)) {
        data.presence.events.map(client.getEventMapper()).forEach(
        function(presenceEvent) {
            var user = client.store.getUser(presenceEvent.getSender());
            if (user) {
                user.setPresenceEvent(presenceEvent);
            }
            else {
                user = createNewUser(client, presenceEvent.getSender());
                user.setPresenceEvent(presenceEvent);
                client.store.storeUser(user);
            }
            client.emit("event", presenceEvent);
        });
    }

    // handle non-room account_data
    if (data.account_data && utils.isArray(data.account_data.events)) {
        var events = data.account_data.events.map(client.getEventMapper());
        client.store.storeAccountDataEvents(events);
        events.forEach(
            function(accountDataEvent) {
                if (accountDataEvent.getType() == 'm.push_rules') {
                    client.pushRules = accountDataEvent.getContent();
                }
                client.emit("accountData", accountDataEvent);
                return accountDataEvent;
            }
        );
    }

    // handle to-device events
    if (data.to_device && utils.isArray(data.to_device.events)) {
        data.to_device.events
            .map(client.getEventMapper())
            .forEach(
                function(toDeviceEvent) {
                    var content = toDeviceEvent.getContent();
                    if (
                        toDeviceEvent.getType() == "m.room.message" &&
                            content.msgtype == "m.bad.encrypted"
                    ) {
                        console.warn(
                            "Unable to decrypt to-device event: " + content.body
                        );
                        return;
                    }

                    client.emit("toDeviceEvent", toDeviceEvent);
                }
            );
    }

    // the returned json structure is a bit crap, so make it into a
    // nicer form (array) after applying sanity to make sure we don't fail
    // on missing keys (on the off chance)
    var inviteRooms = [];
    var joinRooms = [];
    var leaveRooms = [];

    if (data.rooms) {
        if (data.rooms.invite) {
            inviteRooms = this._mapSyncResponseToRoomArray(data.rooms.invite);
        }
        if (data.rooms.join) {
            joinRooms = this._mapSyncResponseToRoomArray(data.rooms.join);
        }
        if (data.rooms.leave) {
            leaveRooms = this._mapSyncResponseToRoomArray(data.rooms.leave);
        }
    }

    this._notifEvents = [];

    // Handle invites
    inviteRooms.forEach(function(inviteObj) {
        var room = inviteObj.room;
        var stateEvents =
            self._mapSyncEventsFormat(inviteObj.invite_state, room);
        self._processRoomEvents(room, stateEvents);
        if (inviteObj.isBrandNewRoom) {
            room.recalculate(client.credentials.userId);
            client.store.storeRoom(room);
            client.emit("Room", room);
        }
        stateEvents.forEach(function(e) { client.emit("event", e); });
    });

    // Handle joins
    joinRooms.forEach(function(joinObj) {
        var room = joinObj.room;
        var stateEvents = self._mapSyncEventsFormat(joinObj.state, room);
        var timelineEvents = self._mapSyncEventsFormat(joinObj.timeline, room);
        var ephemeralEvents = self._mapSyncEventsFormat(joinObj.ephemeral);
        var accountDataEvents = self._mapSyncEventsFormat(joinObj.account_data);

        // we do this first so it's correct when any of the events fire
        if (joinObj.unread_notifications) {
            room.setUnreadNotificationCount(
                'total', joinObj.unread_notifications.notification_count
            );
            room.setUnreadNotificationCount(
                'highlight', joinObj.unread_notifications.highlight_count
            );
        }

        joinObj.timeline = joinObj.timeline || {};

        if (joinObj.isBrandNewRoom) {
            // set the back-pagination token. Do this *before* adding any
            // events so that clients can start back-paginating.
            room.getLiveTimeline().setPaginationToken(
                joinObj.timeline.prev_batch, EventTimeline.BACKWARDS);
        }
        else if (joinObj.timeline.limited) {
            var limited = true;

            // we've got a limited sync, so we *probably* have a gap in the
            // timeline, so should reset. But we might have been peeking or
            // paginating and already have some of the events, in which
            // case we just want to append any subsequent events to the end
            // of the existing timeline.
            //
            // This is particularly important in the case that we already have
            // *all* of the events in the timeline - in that case, if we reset
            // the timeline, we'll end up with an entirely empty timeline,
            // which we'll try to paginate but not get any new events (which
            // will stop us linking the empty timeline into the chain).
            //
            for (var i = timelineEvents.length - 1; i >= 0; i--) {
                var eventId = timelineEvents[i].getId();
                if (room.getTimelineForEvent(eventId)) {
                    debuglog("Already have event " + eventId + " in limited " +
                             "sync - not resetting");
                    limited = false;

                    // we might still be missing some of the events before i;
                    // we don't want to be adding them to the end of the
                    // timeline because that would put them out of order.
                    timelineEvents.splice(0, i);

                    // XXX: there's a problem here if the skipped part of the
                    // timeline modifies the state set in stateEvents, because
                    // we'll end up using the state from stateEvents rather
                    // than the later state from timelineEvents. We probably
                    // need to wind stateEvents forward over the events we're
                    // skipping.

                    break;
                }
            }

            if (limited) {
                // save the old 'next_batch' token as the
                // forward-pagination token for the previously-active
                // timeline.
                room.currentState.paginationToken = syncToken;
                self._deregisterStateListeners(room);
                room.resetLiveTimeline(joinObj.timeline.prev_batch);

                // We have to assume any gap in any timeline is
                // reason to stop incrementally tracking notifications and
                // reset the timeline.
                client.resetNotifTimelineSet();

                self._registerStateListeners(room);
            }
        }

        self._processRoomEvents(room, stateEvents, timelineEvents);

        // XXX: should we be adding ephemeralEvents to the timeline?
        // It feels like that for symmetry with room.addAccountData()
        // there should be a room.addEphemeralEvents() or similar.
        room.addLiveEvents(ephemeralEvents);

        // we deliberately don't add accountData to the timeline
        room.addAccountData(accountDataEvents);

        room.recalculate(client.credentials.userId);
        if (joinObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }
        stateEvents.forEach(function(e) { client.emit("event", e); });
        timelineEvents.forEach(function(e) { client.emit("event", e); });
        ephemeralEvents.forEach(function(e) { client.emit("event", e); });
        accountDataEvents.forEach(function(e) { client.emit("event", e); });
    });

    // Handle leaves (e.g. kicked rooms)
    leaveRooms.forEach(function(leaveObj) {
        var room = leaveObj.room;
        var stateEvents =
            self._mapSyncEventsFormat(leaveObj.state, room);
        var timelineEvents =
            self._mapSyncEventsFormat(leaveObj.timeline, room);
        var accountDataEvents =
            self._mapSyncEventsFormat(leaveObj.account_data);

        self._processRoomEvents(room, stateEvents, timelineEvents);
        room.addAccountData(accountDataEvents);

        room.recalculate(client.credentials.userId);
        if (leaveObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }

        stateEvents.forEach(function(e) { client.emit("event", e); });
        timelineEvents.forEach(function(e) { client.emit("event", e); });
        accountDataEvents.forEach(function(e) { client.emit("event", e); });
    });

    // update the notification timeline, if appropriate.
    // we only do this for live events, as otherwise we can't order them sanely
    // in the timeline relative to ones paginated in by /notifications.
    // XXX: we could fix this by making EventTimeline support chronological
    // ordering... but it doesn't, right now.
    if (syncToken && this._notifEvents.length) {
        this._notifEvents.sort(function(a, b) {
            return a.getTs() - b.getTs();
        });
        this._notifEvents.forEach(function(event) {
            client.getNotifTimelineSet().addLiveEvent(event);
        });
    }
};

/**
 * Starts polling the connectivity check endpoint
 * @param {number} delay How long to delay until the first poll.
 *        defaults to a short, randomised interval (to prevent
 *        tightlooping if /versions succeeds but /sync etc. fail).
 * @return {promise}
 */
SyncApi.prototype._startKeepAlives = function(delay) {
    if (delay === undefined) {
        delay = 2000 + Math.floor(Math.random() * 5000);
    }

    if (this._keepAliveTimer !== null) {
        clearTimeout(this._keepAliveTimer);
    }
    var self = this;
    if (delay > 0) {
        self._keepAliveTimer = setTimeout(
            self._pokeKeepAlive.bind(self),
            delay
        );
    } else {
        self._pokeKeepAlive();
    }
    if (!this._connectionReturnedDefer) {
        this._connectionReturnedDefer = q.defer();
    }
    return this._connectionReturnedDefer.promise;
};

/**
 *
 */
SyncApi.prototype._pokeKeepAlive = function() {
    var self = this;
    function success() {
        clearTimeout(self._keepAliveTimer);
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.resolve();
            self._connectionReturnedDefer = null;
        }
    }

    this.client._http.request(
        undefined, // callback
        "GET", "/_matrix/client/versions",
        undefined, // queryParams
        undefined, // data
        {
            prefix: '',
            localTimeoutMs: 15 * 1000,
        }
    ).done(function() {
        success();
    }, function(err) {
        if (err.httpStatus == 400) {
            // treat this as a success because the server probably just doesn't
            // support /versions: point is, we're getting a response.
            // We wait a short time though, just in case somehow the server
            // is in a mode where it 400s /versions responses and sync etc.
            // responses fail, this will mean we don't hammer in a loop.
            self._keepAliveTimer = setTimeout(success, 2000);
        } else {
            self._keepAliveTimer = setTimeout(
                self._pokeKeepAlive.bind(self),
                5000 + Math.floor(Math.random() * 5000)
            );
            // A keepalive has failed, so we emit the
            // error state (whether or not this is the
            // first failure).
            // Note we do this after setting the timer:
            // this lets the unit tests advance the mock
            // clock when the get the error.
            self._updateSyncState("ERROR", { error: err });
        }
    });
};

/**
 * @param {Object} obj
 * @return {Object[]}
 */
SyncApi.prototype._mapSyncResponseToRoomArray = function(obj) {
    // Maps { roomid: {stuff}, roomid: {stuff} }
    // to
    // [{stuff+Room+isBrandNewRoom}, {stuff+Room+isBrandNewRoom}]
    var client = this.client;
    var self = this;
    return utils.keys(obj).map(function(roomId) {
        var arrObj = obj[roomId];
        var room = client.store.getRoom(roomId);
        var isBrandNewRoom = false;
        if (!room) {
            room = self.createRoom(roomId);
            isBrandNewRoom = true;
        }
        arrObj.room = room;
        arrObj.isBrandNewRoom = isBrandNewRoom;
        return arrObj;
    });
};

/**
 * @param {Object} obj
 * @param {Room} room
 * @return {MatrixEvent[]}
 */
SyncApi.prototype._mapSyncEventsFormat = function(obj, room) {
    if (!obj || !utils.isArray(obj.events)) {
        return [];
    }
    var mapper = this.client.getEventMapper();
    return obj.events.map(function(e) {
        if (room) {
            e.room_id = room.roomId;
        }
        return mapper(e);
    });
};

/**
 * @param {Room} room
 */
SyncApi.prototype._resolveInvites = function(room) {
    if (!room || !this.opts.resolveInvitesToProfiles) {
        return;
    }
    var client = this.client;
    // For each invited room member we want to give them a displayname/avatar url
    // if they have one (the m.room.member invites don't contain this).
    room.getMembersWithMembership("invite").forEach(function(member) {
        if (member._requestedProfileInfo) {
            return;
        }
        member._requestedProfileInfo = true;
        // try to get a cached copy first.
        var user = client.getUser(member.userId);
        var promise;
        if (user) {
            promise = q({
                avatar_url: user.avatarUrl,
                displayname: user.displayName
            });
        }
        else {
            promise = client.getProfileInfo(member.userId);
        }
        promise.done(function(info) {
            // slightly naughty by doctoring the invite event but this means all
            // the code paths remain the same between invite/join display name stuff
            // which is a worthy trade-off for some minor pollution.
            var inviteEvent = member.events.member;
            if (inviteEvent.getContent().membership !== "invite") {
                // between resolving and now they have since joined, so don't clobber
                return;
            }
            inviteEvent.getContent().avatar_url = info.avatar_url;
            inviteEvent.getContent().displayname = info.displayname;
            // fire listeners
            member.setMembershipEvent(inviteEvent, room.currentState);
        }, function(err) {
            // OH WELL.
        });
    });
};

/**
 * @param {Room} room
 * @param {MatrixEvent[]} stateEventList A list of state events. This is the state
 * at the *START* of the timeline list if it is supplied.
 * @param {?MatrixEvent[]} timelineEventList A list of timeline events. Lower index
 * is earlier in time. Higher index is later.
 */
SyncApi.prototype._processRoomEvents = function(room, stateEventList,
                                                timelineEventList) {
    timelineEventList = timelineEventList || [];
    var client = this.client;
    // "old" and "current" state are the same initially; they
    // start diverging if the user paginates.
    // We must deep copy otherwise membership changes in old state
    // will leak through to current state!
    var oldStateEvents = utils.map(
        utils.deepCopy(
            stateEventList.map(function(mxEvent) { return mxEvent.event; })
        ), client.getEventMapper()
    );
    var stateEvents = stateEventList;

    // set the state of the room to as it was before the timeline executes
    //
    // XXX: what if we've already seen (some of) the events in the timeline,
    // and they modify some of the state set in stateEvents? In that case we'll
    // end up with the state from stateEvents, instead of the more recent state
    // from the timeline.
    room.oldState.setStateEvents(oldStateEvents);
    room.currentState.setStateEvents(stateEvents);

    this._resolveInvites(room);

    // recalculate the room name at this point as adding events to the timeline
    // may make notifications appear which should have the right name.
    room.recalculate(this.client.credentials.userId);

    // gather our notifications into this._notifEvents
    if (client.getNotifTimelineSet()) {
        for (var i = 0; i < timelineEventList.length; i++) {
            var pushActions = client.getPushActionsForEvent(timelineEventList[i]);
            if (pushActions && pushActions.notify &&
                pushActions.tweaks && pushActions.tweaks.highlight)
            {
                this._notifEvents.push(timelineEventList[i]);
            }
        }
    }

    // execute the timeline events, this will begin to diverge the current state
    // if the timeline has any state events in it.
    room.addLiveEvents(timelineEventList);
};

/**
 * @return {string}
 */
SyncApi.prototype._getGuestFilter = function() {
    var guestRooms = this.client._guestRooms; // FIXME: horrible gut-wrenching
    if (!guestRooms) {
        return "{}";
    }
    // we just need to specify the filter inline if we're a guest because guests
    // can't create filters.
    return JSON.stringify({
        room: {
            timeline: {
                limit: 20
            }
        }
    });
};

/**
 * Sets the sync state and emits an event to say so
 * @param {String} newState The new state string
 * @param {Object} data Object of additional data to emit in the event
 */
SyncApi.prototype._updateSyncState = function(newState, data) {
    var old = this._syncState;
    this._syncState = newState;
    this.client.emit("sync", this._syncState, old, data);
};

/**
 * Event handler for the 'online' event
 * This event is generally unreliable and precise behaviour
 * varies between browsers, so we poll for connectivity too,
 * but this might help us reconnect a little faster.
 */
SyncApi.prototype._onOnline = function() {
    debuglog("Browser thinks we are back online");
    this._startKeepAlives(0);
};

function createNewUser(client, userId) {
    var user = new User(userId);
    reEmit(client, user, [
        "User.avatarUrl", "User.displayName", "User.presence",
        "User.currentlyActive", "User.lastPresenceTs"
    ]);
    return user;
}

function reEmit(reEmitEntity, emittableEntity, eventNames) {
    utils.forEach(eventNames, function(eventName) {
        // setup a listener on the entity (the Room, User, etc) for this event
        emittableEntity.on(eventName, function() {
            // take the args from the listener and reuse them, adding the
            // event name to the arg list so it works with .emit()
            // Transformation Example:
            // listener on "foo" => function(a,b) { ... }
            // Re-emit on "thing" => thing.emit("foo", a, b)
            var newArgs = [eventName];
            for (var i = 0; i < arguments.length; i++) {
                newArgs.push(arguments[i]);
            }
            reEmitEntity.emit.apply(reEmitEntity, newArgs);
        });
    });
}

/** */
module.exports = SyncApi;
