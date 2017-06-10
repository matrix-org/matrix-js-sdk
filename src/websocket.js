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
const utils = require("./utils");
const Filter = require("./filter");

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
 * Construct an entity which is able to use Websockets to comunicate with a homeserver.
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

    this.ws_timeout = 20000;
    this.ws_keepAliveTimer = null;
    this._notifEvents = []; // accumulator of sync events in the current sync response
    this._failedSyncCount = 0; // Number of consecutive failed /sync requests

    this._awaiting_responses = {};

    if (client.getNotifTimelineSet()) {
        reEmit(client, client.getNotifTimelineSet(),
               ["Room.timeline", "Room.timelineReset"]);
    }
}

WebSocketApi.prototype.reconnectNow = function() {
    console.err("WebSocketApi.reconnectNow() not implemented");
    //TODO Implement
    return false;
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
        return;
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
            client._syncApi._startKeepAlives().done(function() {
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
            client._syncApi._startKeepAlives().done(function() {
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
 * Sends ping-messages via WebSocket as connection-keepAlive
 */
WebSocketApi.prototype.ws_keepAlive = function() {
    debuglog("WebSocketApi.ws_keepAlive");
    if (!this._websocket) {
        console.error("this._websocket does not exist", this);
        return;
    }
    if (this._websocket.readyState == this._websocket.OPEN) {
        //TODO find function to generate id
        this.sendPing();
    }
    this.ws_keepAliveTimer = setTimeout(this.ws_keepAlive.bind(this), this.ws_timeout);
};

/**
 * (Re-)inits the timer for the next ping-event
 * So there will only be send a ping-message if there was
 * not send a message in the last ws_timeout milliseconds
 */
WebSocketApi.prototype._init_keepalive = function() {
    if (this.ws_keepAliveTimer) {
        clearTimeout(this.ws_keepAliveTimer);
    }
    this.ws_keepAliveTimer = setTimeout(this.ws_keepAlive.bind(this), this.ws_timeout);
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
        return;
    }

    let filterId = self.ws_syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = client._syncApi._getGuestFilter();
    }

    const qps = {
        filter: filterId,
    };

    client.store.getSavedSync().then((cachedSync) => {
        if (cachedSync) {
            debuglog("Use cached Sync", cachedSync);
            client._syncApi._processSyncResponse(null, {
                    next_batch: cachedSync.nextBatch,
                    rooms: cachedSync.roomsData,
                    account_data: {
                        events: cachedSync.accountData,
                    },
            });
            const syncEventData = {
                oldSyncToken: null,
                nextSyncToken: cachedSync.nextBatch,
                catchingUp: true,
            };
            self._updateSyncState("PREPARED", syncEventData);
            client.store.setSyncToken(cachedSync.nextBatch);
            return cachedSync.nextBatch;
        } else {
            debuglog("No cached Sync");
            return client.store.getSyncToken();
        }
    }).then((syncToken) => {
        if (!syncToken || syncToken === "undefined") {
            // do initial sync via requesting /sync to avoid errors of throttling
            // (initial request is so big that the buffer on the server overflows)
            client._http.authedRequest(
                undefined, "GET", "/sync", qps, undefined, {},
            ).then((data) => {
                client.store.setSyncToken(data.next_batch);
                try {
                    client._syncApi._processSyncResponse(null, data);
                } catch (e) {
                    console.error("Caught /sync error", e.stack || e);
                }
                const syncEventData = {
                    oldSyncToken: syncToken,
                    nextSyncToken: data.next_batch,
                    catchingUp: true,
                };

                if (!syncOptions.hasSyncedBefore) {
                    self._updateSyncState("PREPARED", syncEventData);
                    syncOptions.hasSyncedBefore = true;
                }
                return data.next_batch;
            });
        } else {
            return syncToken;
        }
    }).then((syncToken) => {
        self.ws_syncToken = syncToken;
        qps.since = self.ws_syncToken;
        this._websocket = client._http.generateWebSocket(qps);
        this._websocket.onopen = _onopen;
        this._websocket.onclose = _onclose;
        this._websocket.onerror = _onerror;
        this._websocket.onmessage = _onmessage;
    });

    function _onopen(ev) {
        debuglog("Connected to WebSocket: ", ev);
        self.ws_possible = true;
        self._init_keepalive();
    }

    function _onerror(err) {
        debuglog("WebSocket.onerror() called", err);

        /* debuglog("Starting keep-alive");
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

    function _onclose(ev) {
        if (self.ws_keepAliveTimer) {
            clearTimeout(self.ws_keepAliveTimer);
            self.ws_keepAliveTimer = null;
        }
        if (ev.wasClean) {
            debuglog("Socket closed");
        } else {
            debuglog("Unclean close. Code: "+ev.code+" reason: "+ev.reason,
                "error");
        }

        if (self.ws_possible) {
            // assume connection to websocket lost by mistake
            debuglog("Reinit Connection via WebSocket");
            self._updateSyncState("RECONNECTING");
            client._syncApi._startKeepAlives().done(function() {
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
        //self._running = false;
        //self.ws_syncOptions = null;
        //self.ws_syncToken = null;
    }

    function _onmessage(inData) {
        // TODO: Design
        // as there was a message on the channel reset keepalive-timout
        self._init_keepalive();

        const data = JSON.parse(inData.data);

        if (data.method) {
            switch (data.method) {
                case "ping":
                    self._websocket.send(JSON.stringify({
                        id: data.id,
                    }));
                break;
                case "sync":
                    self.handleSync(data.data);
                    break;
                default:
                    console.error("Received message with unknown method \"" + data.method
                        + "\"", data);
            }
        } else if (data.result || data.error) {
            self.handleResponse(data);
        } else if (data.next_batch) {
            //TODO make this step obsolete
            // message is Update-Message
            self.handleSync(data);
        } else {
            console.error("Unrecognised message format received via WebSocket", data);
        }
    }
};

/**
 * Handle responses from the server
 * @param {Object} response Message from WebSocket that is a response to
 *  previous initiated Request
 * @return {boolean} true if response could be handled successfully; false if not
 */
WebSocketApi.prototype.handleResponse = function(response) {
    if (! response.id) {
        console.error("response id missing", response);
        return false;
    }
    const txnId = response.id;

    if (! this._awaiting_responses[txnId]) {
        console.error("response id unknown", response);
        return false;
    }

    if (response.result) {
        // success
        this._awaiting_responses[txnId].resolve(response.result);
        return delete this._awaiting_responses[txnId];
    } else if (response.error) {
        //error
        this._awaiting_responses[txnId].reject(response.error);
        return delete this._awaiting_responses[txnId];
    } else {
        console.error("response does not contain result or error", response);
        return false;
    }
};

/**
 * handle message from server which was identified to be a /sync-response
 * @param {Object} data Object that contains the /sync-response
 */
WebSocketApi.prototype.handleSync = function(data) {
        const client = this.client;
        const self = this;
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
};

/**
 * Send message to server
 * @param {Object} event The Event to be send to the Server
 * @return {module:client.Promise} Resolves: the event-Id.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * TODO: Handle Timeout
 */
WebSocketApi.prototype.sendEvent = function(event) {
    const txnId = event._txnId ? event._txnId : this.client.makeTxnId();

    const message = {
        id: txnId,
        method: "send",
        params: {
            room_id: event.getRoomId(),
            event_type: event.getWireType(),
            content: event.getWireContent(),
        },
    };

    if (event.isState() && event.getStateKey() && event.getStateKey().length > 0) {
        message.method = "state";
        message.param.state_key = event.getStateKey();
    }

    this._websocket.send(JSON.stringify(message));
    this._init_keepalive();

    const defer = q.defer();
    this._awaiting_responses[txnId] = defer;
    return defer.promise;
};

/**
 * Sends ping-message to server
 */
WebSocketApi.prototype.sendPing = function() {
    this._websocket.send(JSON.stringify({
        id: this.client.makeTxnId(),
        method: "ping",
    }));
};

/**
 * Send ReadMarkers via WebSocket to server
 * @param {string} roomId ID of the room that has been read
 * @param {string} rmEventId ID of the event that has been read
 * @param {string} rrEventId the event tracked by the read receipt. This is here for
 * convenience because the RR and the RM are commonly updated at the same time as each
 * other. The local echo of this receipt will be done if set. Optional.
 * @return {module:client.Promise} Resolves: the empty object, {}.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
WebSocketApi.prototype.sendReadMarkers = function(roomId, rmEventId, rrEventId) {
    const txnId = this.client.makeTxnId();

    const message = {
        id: txnId,
        method: "read_markers",
        params: {
            "room_id": roomId,
            "m.fully_read": rmEventId,
            "m.read": rrEventId,
        },
    };

    this._websocket.send(JSON.stringify(message));
    this._init_keepalive();

    const defer = q.defer();
    this._awaiting_responses[txnId] = defer;
    return defer.promise;
};

/**
 * Send Typing via WebSocket to Server
 * @param {string} roomId
 * @param {boolean} isTyping
 * @param {Number} timeoutMs
 * @param {module:client.callback} callback Optional. TODO: Implement usage
 * @return {module:client.Promise} Resolves: the empty object, {}.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
WebSocketApi.prototype.sendTyping = function(roomId, isTyping, timeoutMs, callback) {
    const txnId = this.client.makeTxnId();

    const message = {
        id: txnId,
        method: "typing",
        params: {
            room_id: roomId,
            typing: isTyping,
        },
    };

    if (isTyping) {
        message.params.timeout = timeoutMs ? timeoutMs : 20000;
    }

    this._websocket.send(JSON.stringify(message));
    this._init_keepalive();

    const defer = q.defer();
    this._awaiting_responses[txnId] = defer;
    return defer.promise;
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
    this.client._syncApi._startKeepAlives(0);
};

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
