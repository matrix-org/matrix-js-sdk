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
import Promise from 'bluebird';
const Filter = require("./filter");
const MatrixError = require("./http-api").MatrixError;

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

    this._awaiting_responses = {};
    this._pendingSend = [];

    if (client.getNotifTimelineSet()) {
        client.reEmitter.reEmit(client.getNotifTimelineSet(),
               ["Room.timeline", "Room.timelineReset"]);
    }
}

WebSocketApi.prototype.reconnectNow = function() {
    console.err("WebSocketApi.reconnectNow() not implemented");
    //TODO Implement
    return false;
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
        client.getPushRules().done((result) => {
            debuglog("Got push rules");
            client.pushRules = result;
            getFilter(); // Now get the filter and start syncing
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
        ).done((filterId) => {
            // reset the notifications timeline to prepare it to paginate from
            // the current point in time.
            // The right solution would be to tie /sync pagination tokens into
            // /notifications API somehow.
            client.resetNotifTimelineSet();

            self._start({ filterId });
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
        // Before fetching push rules, fetching the filter and syncing, check
        // for persisted /sync data and use that if present.
        client.store.getSavedSync().then((savedSync) => {
            if (savedSync) {
                return client._syncApi._syncFromCache(savedSync);
            }
        }).then(() => {
            // Get push rules and start syncing after getting the saved sync
            // to handle the case where we needed the `nextBatch` token to
            // start syncing from.
            getPushRules();
        });
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
    if (this._websocket && this._websocket.readyState == this._websocket.OPEN) {
        //TODO find function to generate id
        this.sendPing();
    }
    this.ws_keepAliveTimer = setTimeout(this.ws_keepAlive.bind(this), this.ws_timeout);
};

WebSocketApi.prototype._handleResponseTimeout = function(messageId) {
    if (! this._awaiting_responses[messageId]) {
        return;
    }
    debuglog("Run MessageTimeout for message", messageId);
    const curObj = this._awaiting_responses[messageId];
    if (curObj == "ping") {
        // only try closing the connection when the browser thinks it is not broken
        if (this._ping_failed_already && this._websocket &&
                this._websocket.readyState == WebSocket.OPEN) {
            console.error("Timeout for sending ping-request. Try reconnecting");
            // as reconnection will be handled in _close this is enough for here
            this._websocket.close();
            this._websocket = null;
        } else {
            // ignore one failed ping but issue a new ping with a short delay
            this._ping_failed_already = true;
            delete this._awaiting_responses[messageId];
            setTimeout(this.sendPing.bind(this), 5);
        }
        return;
    }
    if (this._websocket == null || this._websocket.readyState != WebSocket.OPEN) {
        debuglog("WebSocket is not ready. Postponing", curObj.message);
        if (!curObj.pending) {
            this._awaiting_responses[messageId].pending = true;
            this._pendingSend.push(curObj.message);
        }
        return;
    }
    if (!curObj.retried) {
        // only retry once
        this._websocket.send(JSON.stringify(curObj.message));
        this._awaiting_responses[messageId].retried = true;
        setTimeout(
            this._handleResponseTimeout.bind(this, messageId),
            this._ws_timeout / 2,
        );
        return;
    }

    curObj.defer.reject(new MatrixError({
        error: "Locally timed out waiting for a response",
        errcode: "ORG.MATRIX.JSSDK_TIMEOUT",
        timeout: this.ws_timeout,
    }));
    delete this._awaiting_responses[messageId];
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
WebSocketApi.prototype._start = async function(syncOptions) {
    const client = this.client;
    const self = this;

    if (!this._running) {
        debuglog("WebSocket no longer running: exiting.");
        this._updateSyncState("STOPPED");
        return;
    }

    let filterId = syncOptions.filterId;
    if (client.isGuest() && !filterId) {
        filterId = client._syncApi._getGuestFilter();
    }

    // as the syncToken has to be present for the websocket (which run async)
    // we store it not just function-wide
    self.ws_syncToken = client.store.getSyncToken();

    const qps = {
        filter: filterId,
    };

    if (this.opts.disablePresence) {
        qps.set_presence = "offline";
    }

    // store syncOptions to be there for restart
    self.ws_syncOptions = syncOptions;

    if (self.ws_syncToken) {
        // we are currently reconnecting
        this._start_websocket(qps);
        return;
    }

    // the initial sync might take some more time as the
    // websocket might have to respond. To avoid a connection loss
    // especially on low throughput devices we offload this to a
    // dedicated sync request

    let data;
    try {
        //debuglog('Starting sync since=' + syncToken);
        this._currentSyncRequest = client._http.authedRequest(
            undefined, "GET", "/sync", qps, undefined, this.opts.pollTimeout,
        );
        data = await this._currentSyncRequest;
    } catch (e) {
        client._syncApi._startKeepAlives().done(() => {
            debuglog("Starting with initial sync failed (", e, "). Retries");
            this._start(syncOptions);
        });
        return;
    }

    // NOTE: The following code is just to handle the initial sync
    //       When initial sync is done via websocket as well that part is not needed

    // set the sync token NOW *before* processing the events. We do this so
    // if something barfs on an event we can skip it rather than constantly
    // polling with the same token.
    client.store.setSyncToken(data.next_batch);

    await client.store.setSyncData(data);

    // emit synced events
    const syncEventData = {
        oldSyncToken: this.ws_syncToken,
        nextSyncToken: data.next_batch,
        catchingUp: this._catchingUp,
    };

    if (this.opts.crypto) {
        // tell the crypto module we're about to process a sync
        // response
        await this.opts.crypto.onSyncWillProcess(syncEventData);
    }

    try {
        await client._syncApi._processSyncResponse(
            syncEventData, data,
        );
    } catch (e) {
        // log the exception with stack if we have it, else fall back
        // to the plain description
        console.error("Caught /sync error", e.stack || e);
    }


    if (!this.ws_syncOptions.hasSyncedBefore) {
        this._updateSyncState("PREPARED", syncEventData);
        this.ws_syncOptions.hasSyncedBefore = true;
    }

    this.ws_syncToken = data.next_batch;

    // tell the crypto module to do its processing. It may block (to do a
    // /keys/changes request).
    if (this.opts.crypto) {
        await this.opts.crypto.onSyncCompleted(syncEventData);
    }

    // keep emitting SYNCING -> SYNCING for clients who want to do bulk updates
    this._updateSyncState("SYNCING", syncEventData);

    // tell databases that everything is now in a consistent state and can be saved.
    client.store.save();

    // the initial sync now went through. Now start using the websocket
    this._start_websocket(qps);
};

WebSocketApi.prototype._start_websocket = function(qps) {
    const self = this;
    qps.since = this.ws_syncToken;
    this._websocket = this.client._http.generateWebSocket(qps);
    this._websocket.onopen = _onopen;
    this._websocket.onclose = _onclose;
    this._websocket.onmessage = _onmessage;

    function _onopen(ev) {
        debuglog("Connected to WebSocket: ", ev);
        self.ws_possible = true;
        self._init_keepalive();

        self._pendingSend.forEach((message) => {
            if (self._awaiting_responses[message.id]) {
                debuglog("Send postponed message via WebSocket", message);
                self._websocket.send(JSON.stringify(message));
            }
        });
        self._pendingSend = [];
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

        // reset var to not kill the socket after the first ping timeout
        self._ping_failed_already = false;

        if (self.ws_possible) {
            // assume connection to websocket lost by mistake
            debuglog("Reinit Connection via WebSocket");
            self._updateSyncState("RECONNECTING");
            self.client._syncApi._startKeepAlives().done(function() {
                debuglog("Restart Websocket");
                self._start(self.ws_syncOptions);
            });
        } else {
            debuglog("Connection via WebSocket seems to be not available. "
                + "Fallback to Long-Polling");
            // Fallback /sync Long Polling
            self.client.connectionFallback(self.opts, self.ws_syncOptions);
            // remove variables used by WebSockets
            self.ws_syncOptions = null;
            self.ws_syncToken = null;
        }
    }

    function _onmessage(inData) {
        // Design-TODO: Shall we reset the keepalive-timer when a message receives?
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
            // message is plain /sync-response.
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
    if (this._awaiting_responses[txnId] == "ping") {
        self._ping_failed_already = false;
        return delete this._awaiting_responses[txnId];
    }

    if (response.result) {
        // success
        this._awaiting_responses[txnId].defer.resolve(response.result);
        return delete this._awaiting_responses[txnId];
    } else if (response.error) {
        //error
        this._awaiting_responses[txnId].defer.reject(response.error);
        return delete this._awaiting_responses[txnId];
    } else {
        console.error("response does not contain result nor error", response);
        return false;
    }
};

/**
 * handle message from server which was identified to be a /sync-response
 * @param {Object} data Object that contains the /sync-response
 */
WebSocketApi.prototype.handleSync = async function(data) {
    const client = this.client;
    const self = this;
    //debuglog('Got new data from socket, next_batch=' + data.next_batch);

    // set the sync token NOW *before* processing the events. We do this so
    // if something barfs on an event we can skip it rather than constantly
    // polling with the same token.
    client.store.setSyncToken(data.next_batch);

    await client.store.setSyncData(data);
    try {
        client._syncApi._processSyncResponse(self.ws_syncToken, data, false);
    } catch(e) {
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

WebSocketApi.prototype.sendObject = function(message) {
    const defer = Promise.defer();
    if (!message.method) {
        return defer.reject("No method in sending object");
    }
    message.id = message.id || this.client.makeTxnId();

    this._awaiting_responses[message.id] = {
        message: message,
        defer: defer,
    };

    if (this._websocket == null || this._websocket.readyState != WebSocket.OPEN) {
        debuglog("WebSocket is not ready. Postponing", message);
        this._pendingSend.push(message);
        this._awaiting_responses[message.id].pending = true;
    } else {
        this._websocket.send(JSON.stringify(message));
    }

    setTimeout(this._handleResponseTimeout.bind(this, message.id), this.ws_timeout/2);
    return defer.promise;
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

    return this.sendObject(message);
};

/**
 * Sends ping-message to server
 */
WebSocketApi.prototype.sendPing = function() {
    const txnId = this.client.makeTxnId();
    this._websocket.send(JSON.stringify({
        id: txnId,
        method: "ping",
    }));
    this._awaiting_responses[txnId] = "ping";
    setTimeout(this._handleResponseTimeout.bind(this, txnId), this.ws_timeout);
};

/**
 * @param {Object} opts Options to apply
 * @param {string} opts.presence One of "online", "offline" or "unavailable"
 * @param {string} opts.status_msg The status message to attach.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * @throws If 'presence' isn't a valid presence enum value.
 */
WebSocketApi.prototype.sendPresence = function(opts) {
    const validStates = ["offline", "online", "unavailable"];
    if (validStates.indexOf(opts.presence) == -1) {
        throw new Error("Bad presence value: " + opts.presence);
    }

    const txnId = this.client.makeTxnId();
    const message = {
        id: txnId,
        method: "presence",
        params: {
            "presence": opts.presence,
        },
    };
    if (opts.status_msg) {
        message.params.status_msg = opts.status_msg;
    }

    return this.sendObject(message);
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

    return this.sendObject(message);
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

    return this.sendObject(message);
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

/** */
module.exports = WebSocketApi;
