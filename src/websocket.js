/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

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
const q = require("q");
const User = require("./models/user");
const Room = require("./models/room");
const utils = require("./utils");
const Filter = require("./filter");
const EventTimeline = require("./models/event-timeline");

const DEBUG = true;

function getFilterName(userId, suffix) {
    // scope this on the user ID because people may login on many accounts
    // and they all need to be stored!
    return "FILTER_SYNC_" + userId + (suffix ? "_" + suffix : "");
}

function debuglog() {
    if (!DEBUG) {
        return;
    }
    console.log(...arguments);
}


/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @constructor
 * @param {MatrixClient} client The matrix client instance to use.
 * @param {Object} opts Config options
 * @param {module:crypto=} opts.crypto Crypto manager
 * @param {Function=} opts.canResetEntireTimeline A function which is called
 * with a room ID and returns a boolean. It should return 'true' if the SDK can
 * SAFELY remove events from this room. It may not be safe to remove events if
 * there are other references to the timelines for this room.
 * Default: returns false.
 */
function WebSocketApi(client, opts) {
    this.client = client;
    opts = opts || {};
    opts.initialSyncLimit = (
        opts.initialSyncLimit === undefined ? 8 : opts.initialSyncLimit
    );
    opts.resolveInvitesToProfiles = opts.resolveInvitesToProfiles || false;
    opts.pendingEventOrdering = opts.pendingEventOrdering || "chronological";
    if (!opts.canResetEntireTimeline) {
        opts.canResetEntireTimeline = function(roomId) {
            return false;
        };
    }
    this.opts = opts;
    this._websocket = null;
    this._syncState = null;
    this._catchingUp = false;
    this._running = false;
    this._keepAliveTimer = null;
    this._connectionReturnedDefer = null;
    this._notifEvents = []; // accumulator of sync events in the current sync response
    this._failedSyncCount = 0; // Number of consecutive failed /sync requests

    if (client.getNotifTimelineSet()) {
        reEmit(client, client.getNotifTimelineSet(),
               ["Room.timeline", "Room.timelineReset"]);
    }
}

WebSocketApi.prototype.reconnectNow = function() {
    console.err("WebSocketApi.reconnectNow() not implemented");
    //TODO Implement
    return false;
}

/**
 * @param {string} roomId
 * @return {Room}
 */
WebSocketApi.prototype.createRoom = function(roomId) {
    const client = this.client;
    const room = new Room(roomId, {
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
WebSocketApi.prototype._registerStateListeners = function(room) {
    const client = this.client;
    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember",
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership",
            ],
        );
    });
};

/**
 * @param {Room} room
 * @private
 */
WebSocketApi.prototype._deregisterStateListeners = function(room) {
    // could do with a better way of achieving this.
    room.currentState.removeAllListeners("RoomState.events");
    room.currentState.removeAllListeners("RoomState.members");
    room.currentState.removeAllListeners("RoomState.newMember");
};

/**
 * Returns the current state of this sync object
 * @see module:client~MatrixClient#event:"sync"
 * @return {?String}
 */
WebSocketApi.prototype.getSyncState = function() {
    return this._syncState;
};

/**
 * Main entry point
 */
WebSocketApi.prototype.start = function() {
    const client = this.client;
    const self = this;

    if (this._running) {
        console.log("WebSocketApi is already running. Do nothing");
        return false;
    }
    this._running = true;

    if (this._websocket) {
        debuglog("Websocket already existing. Killing it");
        this._websocket.close();
        this._websocket = null;
    }

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
        let filter;
        if (self.opts.filter) {
            filter = self.opts.filter;
        } else {
            filter = new Filter(client.credentials.userId);
            filter.setTimelineLimit(self.opts.initialSyncLimit);
        }

        client.getOrCreateFilter(
            getFilterName(client.credentials.userId), filter,
        ).done(function(filterId) {
            // reset the notifications timeline to prepare it to paginate from
            // the current point in time.
            // The right solution would be to tie /sync pagination tokens into
            // /notifications API somehow.
            client.resetNotifTimelineSet();

            self._start({ filterId: filterId });

        }, function(err) {
            self._startKeepAlives().done(function() {
                getFilter();
            });
            self._updateSyncState("ERROR", { error: err });
        });
    }

    if (client.isGuest()) {
        // no push rules for guests, no access to POST filter for guests.
        self._start({});
    } else {
        getPushRules();
    }
};

/**
 * Stops the sync object from syncing.
 */
WebSocketApi.prototype.stop = function() {
    debuglog("WebSocketApi.stop");
    if (global.document) {
        global.document.removeEventListener("online", this._onOnlineBound, false);
        this._onOnlineBound = undefined;
    }
    this._running = false;
    if (this._keepAliveTimer) {
        clearTimeout(this._keepAliveTimer);
        this._keepAliveTimer = null;
    }
    if (this._websocket) {
        this._websocket.close();
        this._websocket = null;
    }
    self._updateSyncState("STOPPED");
};

/**
 * Retry a backed off syncing request immediately. This should only be used when
 * the user <b>explicitly</b> attempts to retry their lost connection.
 * @return {boolean} True if this resulted in a request being retried.
 */
WebSocketApi.prototype.retryImmediately = function() {
    if (!this._connectionReturnedDefer) {
        return false;
    }
    this._startKeepAlives(0);
    return true;
};

/**
 * Alternative to use WebSockets instead of _sync (Long Polling) *
 * Invoke me as alternative to avoid /sync calls but use WebSocket instead
 * @param {Object} syncOptions
 * @param {string} syncOptions.filterId
 * @param {boolean} syncOptions.hasSyncedBefore
 */
WebSocketApi.prototype._start = function(syncOptions) {
    const client = this.client;
    const self = this;

    self.ws_syncOptions = syncOptions;

    if (!this._running) {
        debuglog("Sync no longer running: exiting.");
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.reject();
            self._connectionReturnedDefer = null;
        }
        return;
    }

    let filterId = self.ws_syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = this._getGuestFilter();
    }

    self.ws_syncToken = client.store.getSyncToken();

    if (this.getSyncState() !== 'SYNCING' || this._catchingUp) {
        // unless we are happily syncing already, we want the server to return
        // as quickly as possible, even if there are no events queued. This
        // serves two purposes:
        //
        // * When the connection dies, we want to know asap when it comes back,
        //   so that we can hide the error from the user. (We don't want to
        //   have to wait for an event or a timeout).
        //
        // * We want to know if the server has any to_device messages queued up
        //   for us. We do that by calling it with a zero timeout until it
        //   doesn't give us any more to_device messages.
        this._catchingUp = true;
    }

    const qps = {
        filter: filterId,
    };

    if (self.ws_syncToken) {
        qps.since = self.ws_syncToken;
    }

    this._websocket = client._http.generateWebSocket(qps);
    this._websocket.onopen = function(ev) {
        debuglog("Connected to WebSocket: ", ev);
    }
    this._websocket.onclose = function(ev) {
        if (ev.wasClean) {
            debuglog("Socket closed");
            self._updateSyncState("STOPPED");
        } else {
            debuglog("Unclean close. Code: "+ev.code+" reason: "+ev.reason,
                "error");

            if (self.ws_syncOptions.hasSyncedBefore) {
                // assume connection to websocket lost by mistake
                debuglog("Reinit Connection via WebSocket");
                self._updateSyncState("RECONNECTING");
                self._startKeepAlives().done(function() {
                    debuglog("Restart Websocket");
                    self._start(self.ws_syncOptions);
                });
            } else {
                debuglog("Connection via WebSocket seems to be not available. "
                    + "Fallback to Long-Polling");
                // remove variables used by WebSockets
                self.ws_syncOptions = null;
                self.ws_syncToken = null;
                // Fallback /sync Long Polling
                client.connFallback(self.opts);
            }
        }
        //self._running = false;
        //self.ws_syncOptions = null;
        //self.ws_syncToken = null;
    }

    this._websocket.onmessage = function(in_data) {
        let data = JSON.parse(in_data.data);
        //debuglog('Got new data from socket, next_batch=' + data.next_batch);

        // set the sync token NOW *before* processing the events. We do this so
        // if something barfs on an event we can skip it rather than constantly
        // polling with the same token.
        client.store.setSyncData(data);
        client.store.setSyncToken(data.next_batch);

        // Reset after a successful sync
        self._failedSyncCount = 0;

        try {
            self._processSyncResponse(self.ws_syncToken, data);
        } catch (e) {
            // log the exception with stack if we have it, else fall back
            // to the plain description
            console.error("Caught /sync error (via WebSocket)", e.stack || e);
        }

        // emit synced events
        const syncEventData = {
            oldSyncToken: self.ws_syncToken,
            nextSyncToken: data.next_batch,
            catchingUp: self._catchingUp,
        };

        if (!self.ws_syncOptions.hasSyncedBefore) {
            self._updateSyncState("PREPARED", syncEventData);
            self.ws_syncOptions.hasSyncedBefore = true;
	} else {
            self._updateSyncState("SYNCING", syncEventData);

            // tell databases that everything is now in a consistent state and can be
            // saved (no point doing so if we only have the data we just got out of the
            // store).
            client.store.save();
        }
        self.ws_syncToken = data.next_batch;
    }

    this._websocket.onerror = function(err) {
        debuglog("WebSocket.onerror() called", err);

//      console.log('Number of consecutive failed sync requests:', self._failedSyncCount);

        if (self.ws_syncOptions.hasSyncedBefore) {
            // assume connection to websocket lost by mistake
            debuglog("Reinit Connection via WebSocket");
            self._updateSyncState("RECONNECTING");
            self._start(self.ws_syncOptions);
        } else {
            debuglog("Connection via WebSocket seems to be not available. "
                + "Fallback to Long-Polling");
            // remove variables used by WebSockets
            self.ws_syncOptions = null;
            self.ws_syncToken = null;
            // Fallback /sync Long Polling
            client.connFallback(self.opts);
        }

/*        debuglog("Starting keep-alive");
        // Note that we do *not* mark the sync connection as
        // lost yet: we only do this if a keepalive poke
        // fails, since long lived HTTP connections will
        // go away sometimes and we shouldn't treat this as
        // erroneous. We set the state to 'reconnecting'
        // instead, so that clients can onserve this state
        // if they wish.
        self._updateSyncState("RECONNECTING");
        self._startKeepAlives().done(function() {
            debuglog("Restart Websocket");
            self._start(self.ws_syncOptions);
        });
        // Transition from RECONNECTING to ERROR after a given number of failed syncs
        self._updateSyncState(
            self._failedSyncCount >= FAILED_SYNC_ERROR_THRESHOLD ?
                "ERROR" : "RECONNECTING",
        );*/
    }
}

/**
 * Process data returned from a sync response and propagate it
 * into the model objects
 *
 * @param {string} syncToken the old next_batch token sent to this
 *    sync request.
 * @param {Object} data The response from /sync
 */
WebSocketApi.prototype._processSyncResponse = function(syncToken, data) {
    const client = this.client;
    const self = this;

    // data looks like:
    // {
    //    next_batch: $token,
    //    presence: { events: [] },
    //    account_data: { events: [] },
    //    device_lists: { changed: ["@user:server", ... ]},
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
            let user = client.store.getUser(presenceEvent.getSender());
            if (user) {
                user.setPresenceEvent(presenceEvent);
            } else {
                user = createNewUser(client, presenceEvent.getSender());
                user.setPresenceEvent(presenceEvent);
                client.store.storeUser(user);
            }
            client.emit("event", presenceEvent);
        });
    }

    // handle non-room account_data
    if (data.account_data && utils.isArray(data.account_data.events)) {
        const events = data.account_data.events.map(client.getEventMapper());
        client.store.storeAccountDataEvents(events);
        events.forEach(
            function(accountDataEvent) {
                if (accountDataEvent.getType() == 'm.push_rules') {
                    client.pushRules = accountDataEvent.getContent();
                }
                client.emit("accountData", accountDataEvent);
                return accountDataEvent;
            },
        );
    }

    // handle to-device events
    if (data.to_device && utils.isArray(data.to_device.events) &&
        data.to_device.events.length > 0
       ) {
        data.to_device.events
            .map(client.getEventMapper())
            .forEach(
                function(toDeviceEvent) {
                    const content = toDeviceEvent.getContent();
                    if (
                        toDeviceEvent.getType() == "m.room.message" &&
                            content.msgtype == "m.bad.encrypted"
                    ) {
                        // the mapper already logged a warning.
                        console.log(
                            'Ignoring undecryptable to-device event from ' +
                                toDeviceEvent.getSender(),
                        );
                        return;
                    }

                    client.emit("toDeviceEvent", toDeviceEvent);
                },
            );
    } else {
        // no more to-device events: we can stop polling with a short timeout.
        this._catchingUp = false;
    }

    // the returned json structure is a bit crap, so make it into a
    // nicer form (array) after applying sanity to make sure we don't fail
    // on missing keys (on the off chance)
    let inviteRooms = [];
    let joinRooms = [];
    let leaveRooms = [];

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
        const room = inviteObj.room;
        const stateEvents =
            self._mapSyncEventsFormat(inviteObj.invite_state, room);
        self._processRoomEvents(room, stateEvents);
        if (inviteObj.isBrandNewRoom) {
            room.recalculate(client.credentials.userId);
            client.store.storeRoom(room);
            client.emit("Room", room);
        }
        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
    });

    // Handle joins
    joinRooms.forEach(function(joinObj) {
        const room = joinObj.room;
        const stateEvents = self._mapSyncEventsFormat(joinObj.state, room);
        const timelineEvents = self._mapSyncEventsFormat(joinObj.timeline, room);
        const ephemeralEvents = self._mapSyncEventsFormat(joinObj.ephemeral);
        const accountDataEvents = self._mapSyncEventsFormat(joinObj.account_data);

        // we do this first so it's correct when any of the events fire
        if (joinObj.unread_notifications) {
            room.setUnreadNotificationCount(
                'total', joinObj.unread_notifications.notification_count,
            );
            room.setUnreadNotificationCount(
                'highlight', joinObj.unread_notifications.highlight_count,
            );
        }

        joinObj.timeline = joinObj.timeline || {};

        if (joinObj.isBrandNewRoom) {
            // set the back-pagination token. Do this *before* adding any
            // events so that clients can start back-paginating.
            room.getLiveTimeline().setPaginationToken(
                joinObj.timeline.prev_batch, EventTimeline.BACKWARDS);
        } else if (joinObj.timeline.limited) {
            let limited = true;

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
            for (let i = timelineEvents.length - 1; i >= 0; i--) {
                const eventId = timelineEvents[i].getId();
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
                room.resetLiveTimeline(
                    joinObj.timeline.prev_batch,
                    self.opts.canResetEntireTimeline(room.roomId),
                );

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
        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
        timelineEvents.forEach(function(e) {
            client.emit("event", e);
        });
        ephemeralEvents.forEach(function(e) {
            client.emit("event", e);
        });
        accountDataEvents.forEach(function(e) {
            client.emit("event", e);
        });
    });

    // Handle leaves (e.g. kicked rooms)
    leaveRooms.forEach(function(leaveObj) {
        const room = leaveObj.room;
        const stateEvents =
            self._mapSyncEventsFormat(leaveObj.state, room);
        const timelineEvents =
            self._mapSyncEventsFormat(leaveObj.timeline, room);
        const accountDataEvents =
            self._mapSyncEventsFormat(leaveObj.account_data);

        self._processRoomEvents(room, stateEvents, timelineEvents);
        room.addAccountData(accountDataEvents);

        room.recalculate(client.credentials.userId);
        if (leaveObj.isBrandNewRoom) {
            client.store.storeRoom(room);
            client.emit("Room", room);
        }

        stateEvents.forEach(function(e) {
            client.emit("event", e);
        });
        timelineEvents.forEach(function(e) {
            client.emit("event", e);
        });
        accountDataEvents.forEach(function(e) {
            client.emit("event", e);
        });
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

    // Handle device list updates
    if (this.opts.crypto && data.device_lists && data.device_lists.changed) {
        data.device_lists.changed.forEach((u) => {
            this.opts.crypto.userDeviceListChanged(u);
        });
    }
};

/**
 * Starts polling the connectivity check endpoint
 * @param {number} delay How long to delay until the first poll.
 *        defaults to a short, randomised interval (to prevent
 *        tightlooping if /versions succeeds but /sync etc. fail).
 * @return {promise} which resolves once the connection returns
 */
WebSocketApi.prototype._startKeepAlives = function(delay) {
    if (delay === undefined) {
        delay = 2000 + Math.floor(Math.random() * 5000);
    }

    if (this._keepAliveTimer !== null) {
        clearTimeout(this._keepAliveTimer);
    }
    const self = this;
    if (delay > 0) {
        self._keepAliveTimer = setTimeout(
            self._pokeKeepAlive.bind(self),
            delay,
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
 * Make a dummy call to /_matrix/client/versions, to see if the HS is
 * reachable.
 *
 * On failure, schedules a call back to itself. On success, resolves
 * this._connectionReturnedDefer.
 */
WebSocketApi.prototype._pokeKeepAlive = function() {
    const self = this;
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
        },
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
                5000 + Math.floor(Math.random() * 5000),
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
WebSocketApi.prototype._mapSyncResponseToRoomArray = function(obj) {
    // Maps { roomid: {stuff}, roomid: {stuff} }
    // to
    // [{stuff+Room+isBrandNewRoom}, {stuff+Room+isBrandNewRoom}]
    const client = this.client;
    const self = this;
    return utils.keys(obj).map(function(roomId) {
        const arrObj = obj[roomId];
        let room = client.store.getRoom(roomId);
        let isBrandNewRoom = false;
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
WebSocketApi.prototype._mapSyncEventsFormat = function(obj, room) {
    if (!obj || !utils.isArray(obj.events)) {
        return [];
    }
    const mapper = this.client.getEventMapper();
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
WebSocketApi.prototype._resolveInvites = function(room) {
    if (!room || !this.opts.resolveInvitesToProfiles) {
        return;
    }
    const client = this.client;
    // For each invited room member we want to give them a displayname/avatar url
    // if they have one (the m.room.member invites don't contain this).
    room.getMembersWithMembership("invite").forEach(function(member) {
        if (member._requestedProfileInfo) {
            return;
        }
        member._requestedProfileInfo = true;
        // try to get a cached copy first.
        const user = client.getUser(member.userId);
        let promise;
        if (user) {
            promise = q({
                avatar_url: user.avatarUrl,
                displayname: user.displayName,
            });
        } else {
            promise = client.getProfileInfo(member.userId);
        }
        promise.done(function(info) {
            // slightly naughty by doctoring the invite event but this means all
            // the code paths remain the same between invite/join display name stuff
            // which is a worthy trade-off for some minor pollution.
            const inviteEvent = member.events.member;
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
 * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
 * is earlier in time. Higher index is later.
 */
WebSocketApi.prototype._processRoomEvents = function(room, stateEventList,
                                                timelineEventList) {
    timelineEventList = timelineEventList || [];
    const client = this.client;
    // "old" and "current" state are the same initially; they
    // start diverging if the user paginates.
    // We must deep copy otherwise membership changes in old state
    // will leak through to current state!
    const oldStateEvents = utils.map(
        utils.deepCopy(
            stateEventList.map(function(mxEvent) {
                return mxEvent.event;
            }),
        ), client.getEventMapper(),
    );
    const stateEvents = stateEventList;

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
        for (let i = 0; i < timelineEventList.length; i++) {
            const pushActions = client.getPushActionsForEvent(timelineEventList[i]);
            if (pushActions && pushActions.notify &&
                pushActions.tweaks && pushActions.tweaks.highlight) {
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
WebSocketApi.prototype._getGuestFilter = function() {
    const guestRooms = this.client._guestRooms; // FIXME: horrible gut-wrenching
    if (!guestRooms) {
        return "{}";
    }
    // we just need to specify the filter inline if we're a guest because guests
    // can't create filters.
    return JSON.stringify({
        room: {
            timeline: {
                limit: 20,
            },
        },
    });
};

/**
 * Sets the sync state and emits an event to say so
 * @param {String} newState The new state string
 * @param {Object} data Object of additional data to emit in the event
 */
WebSocketApi.prototype._updateSyncState = function(newState, data) {
    const old = this._syncState;
    this._syncState = newState;
    this.client.emit("sync", this._syncState, old, data);
};

/**
 * Event handler for the 'online' event
 * This event is generally unreliable and precise behaviour
 * varies between browsers, so we poll for connectivity too,
 * but this might help us reconnect a little faster.
 */
WebSocketApi.prototype._onOnline = function() {
    debuglog("Browser thinks we are back online");
    this._startKeepAlives(0);
};

function createNewUser(client, userId) {
    const user = new User(userId);
    reEmit(client, user, [
        "User.avatarUrl", "User.displayName", "User.presence",
        "User.currentlyActive", "User.lastPresenceTs",
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
            const newArgs = [eventName];
            for (let i = 0; i < arguments.length; i++) {
                newArgs.push(arguments[i]);
            }
            reEmitEntity.emit(...newArgs);
        });
    });
}

/** */
module.exports = WebSocketApi;
