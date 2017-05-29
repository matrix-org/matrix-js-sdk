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
    this._updateSyncState("STOPPED");
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
        debuglog("WebSocket no longer running: exiting.");
        if (self._connectionReturnedDefer) {
            self._connectionReturnedDefer.reject();
            self._connectionReturnedDefer = null;
        }
        return;
    }

    let filterId = self.ws_syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = client._syncApi._getGuestFilter();
    }

    self.ws_syncToken = client.store.getSyncToken();

    const qps = {
        filter: filterId,
    };

    if (self.ws_syncToken) {
        qps.since = self.ws_syncToken;
        this._websocket = client._http.generateWebSocket(qps);
        this._websocket.onopen    = _ws_onopen;
        this._websocket.onclose   = _ws_onclose;
        this._websocket.onerror   = _ws_onerror;
        this._websocket.onmessage = _ws_onmessage;
    } else {
        // do initial sync via requesting /sync to avoid errors of throttling
        // (initial request is so big that the buffer on the server overflows)
        //TODO replace 999999 by something appropriate
        client._http.authedRequest(
            undefined, "GET", "/sync", qps, undefined, {
                prefix: "/_matrix/client/v2_alpha", },
        ).then((data) => {
            client.store.setSyncToken(data.next_batch);
            try {
                client._syncApi._processSyncResponse(null, data);
            } catch (e) {
                console.error("Caught /sync error", e.stack || e);
            }
            const syncEventData = {
                oldSyncToken: self.ws_syncToken,
                nextSyncToken: data.next_batch,
                catchingUp: true,
            };

            if (!syncOptions.hasSyncedBefore) {
                self._updateSyncState("PREPARED", syncEventData);
                syncOptions.hasSyncedBefore = true;
            }
            qps.since = data.next_batch;
            this._websocket = client._http.generateWebSocket(qps);
            this._websocket.onopen    = _ws_onopen;
            this._websocket.onclose   = _ws_onclose;
            this._websocket.onerror   = _ws_onerror;
            this._websocket.onmessage = _ws_onmessage;
        });
    }

    function _ws_onopen(ev) {
        debuglog("Connected to WebSocket: ", ev);
        self.ws_possible = true;
    }

    function _ws_onerror(err) {
        debuglog("WebSocket.onerror() called", err);

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

    function _ws_onclose(ev) {
        if (ev.wasClean) {
            debuglog("Socket closed");
            self._updateSyncState("STOPPED");
        } else {
            debuglog("Unclean close. Code: "+ev.code+" reason: "+ev.reason,
                "error");

            if (self.ws_possible) {
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
                client.connectionFallback(self.opts);
            }
        }
        //self._running = false;
        //self.ws_syncOptions = null;
        //self.ws_syncToken = null;
    }

    function _ws_onmessage(in_data) {
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
            client._syncApi._processSyncResponse(self.ws_syncToken, data);
        } catch (e) {
            // log the exception with stack if we have it, else fall back
            // to the plain description
            console.error("Caught /sync error (via WebSocket)", e.stack || e);
        }

        // emit synced events
        const syncEventData = {
            oldSyncToken: self.ws_syncToken,
            nextSyncToken: data.next_batch,
        };

        self._updateSyncState("SYNCING", syncEventData);

        // tell databases that everything is now in a consistent state and can be
        // saved (no point doing so if we only have the data we just got out of the
        // store).
        client.store.save();
        self.ws_syncToken = data.next_batch;
    }
}


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
