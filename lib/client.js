"use strict";
/**
 * This is an internal module. See {@link MatrixClient} for the public class.
 * @module client
 */
var httpApi = require("./http-api");
var MatrixEvent = require("./models/event").MatrixEvent;
var Room = require("./models/room");
var User = require("./models/user");
var MatrixInMemoryStore = require("./store/memory").MatrixInMemoryStore;
var utils = require("./utils");

// TODO:
// Internal: rate limiting

/**
 * Construct a Matrix Client.
 * @constructor
 * @param {Object} opts The configuration options for this client.
 * @param {string} opts.baseUrl Required. The base URL to the client-server HTTP API.
 * @param {Function} opts.request Required. The function to invoke for HTTP requests.
 * @param {string} opts.accessToken The access_token for this user.
 * @param {string} opts.userId The user ID for this user.
 * @param {Object} opts.store Optional. The data store to use. Defaults to
 * {@link module:store/memory.MatrixInMemoryStore}.
 */
module.exports.MatrixClient = function MatrixClient(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);
    utils.checkObjectHasNoAdditionalKeys(opts,
        ["baseUrl", "request", "accessToken", "userId", "store"]
    );
    this.store = opts.store || new MatrixInMemoryStore();
    // track our position in the overall eventstream
    this.fromToken = undefined;
    this.clientRunning = false;

    var httpOpts = {
        baseUrl: opts.baseUrl,
        accessToken: opts.accessToken,
        request: opts.request,
        prefix: httpApi.PREFIX_V1,
        onlyData: true
    };
    this.credentials = {
        userId: (opts.userId || null)
    };
    this._http = new httpApi.MatrixHttpApi(httpOpts);
};
module.exports.MatrixClient.prototype = {

    /**
     * Get the data store for this client.
     * @return {Object} The data store or null if one wasn't set.
     */
    getStore: function() {
        return this.store;
    },

    // Room operations
    // ===============

    /**
     * Create a new room.
     * @param {Object} options a list of options to pass to the /createRoom API.
     * @param {string} options.room_alias_name The alias localpart to assign to
     * this room.
     * @param {string} options.visibility Either 'public' or 'private'.
     * @param {string[]} options.invite A list of user IDs to invite to this room.
     * @param {string} options.name The name to give this room.
     * @param {string} options.topic The topic to give this room.
     * @param {module:client.callback} callback Optional.
     * @return {module:client.Promise} Resolves: <code>{room_id: {string},
     * room_alias: {string(opt)}}</code>
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createRoom: function(options, callback) {
        // valid options include: room_alias_name, visibility, invite
        return this._http.authedRequest(
            callback, "POST", "/createRoom", undefined, options
        );
    },

    /**
     * Join a room.
     * @param {string} roomIdOrAlias The room ID or room alias to join.
     * @param {module:client.callback} callback Optional.
     * @return {module:client.Promise} Resolves: <code>{room_id: {string}}</code>
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    joinRoom: function(roomIdOrAlias, callback) {
        var path = utils.encodeUri("/join/$roomid", { $roomid: roomIdOrAlias});
        return this._http.authedRequest(callback, "POST", path, undefined, {});
    },

    setRoomName: function(roomId, name, callback) {
        return this.sendStateEvent(roomId, "m.room.name", {name: name},
                                   undefined, callback);
    },

    setRoomTopic: function(roomId, topic, callback) {
        return this.sendStateEvent(roomId, "m.room.topic", {topic: topic},
                                   undefined, callback);
    },

    setPowerLevel: function(roomId, userId, powerLevel, event, callback) {
        var content = {
            users: {}
        };
        if (event && event.type === "m.room.power_levels") {
            content = event.content;
        }
        content.users[userId] = powerLevel;
        var path = utils.encodeUri("/rooms/$roomId/state/m.room.power_levels", {
            $roomId: roomId
        });
        return this._http.authedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    getStateEvent: function(roomId, eventType, stateKey, callback) {
        var pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey
        };
        var path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this._http.authedRequest(
            callback, "GET", path
        );
    },

    sendStateEvent: function(roomId, eventType, content, stateKey, 
                             callback) {
        var pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey
        };
        var path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this._http.authedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    sendEvent: function(roomId, eventType, content, txnId, callback) {
        if (utils.isFunction(txnId)) { callback = txnId; txnId = undefined; }

        if (!txnId) {
            txnId = "m" + new Date().getTime();
        }

        var path = utils.encodeUri("/rooms/$roomId/send/$eventType/$txnId", {
            $roomId: roomId,
            $eventType: eventType,
            $txnId: txnId
        });
        return this._http.authedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    sendMessage: function(roomId, content, txnId, callback) {
        if (utils.isFunction(txnId)) { callback = txnId; txnId = undefined; }
        return this.sendEvent(
            roomId, "m.room.message", content, txnId, callback
        );
    },

    sendTextMessage: function(roomId, body, txnId, callback) {
        var content = {
             msgtype: "m.text",
             body: body
        };
        return this.sendMessage(roomId, content, txnId, callback);
    },

    sendEmoteMessage: function(roomId, body, txnId, callback) {
        var content = {
             msgtype: "m.emote",
             body: body
        };
        return this.sendMessage(roomId, content, txnId, callback);
    },

    sendImageMessage: function(roomId, url, info, text, callback) {
        if (utils.isFunction(text)) { callback = text; text = undefined; }
        if (!text) { text = "Image"; }
        var content = {
             msgtype: "m.image",
             url: url,
             info: info,
             body: text
        };
        return this.sendMessage(roomId, content, callback);
    },

    sendHtmlMessage: function(roomId, body, htmlBody, callback) {
        var content = {
            msgtype: "m.text",
            format: "org.matrix.custom.html",
            body: body,
            formatted_body: htmlBody
        };
        return this.sendMessage(roomId, content, callback);
    },

    sendTyping: function(roomId, isTyping, timeoutMs, callback) {
        var path = utils.encodeUri("/rooms/$roomId/typing/$userId", {
            $roomId: roomId,
            $userId: this.credentials.userId
        });
        var data = {
            typing: isTyping
        };
        if (isTyping) {
            data.timeout = timeoutMs ? timeoutMs : 20000;
        }
        return this._http.authedRequest(
            callback, "PUT", path, undefined, data
        );
    },

    redactEvent: function(roomId, eventId, callback) {
        var path = utils.encodeUri("/rooms/$roomId/redact/$eventId", {
            $roomId: roomId,
            $eventId: eventId
        });
        return this._http.authedRequest(callback, "POST", path, undefined, {});
    },

    invite: function(roomId, userId, callback) {
        return this._membershipChange(roomId, userId, "invite", undefined,
            callback);
    },

    leave: function(roomId, callback) {
        return this._membershipChange(roomId, undefined, "leave", undefined,
            callback);
    },

    ban: function(roomId, userId, reason, callback) {
        return this._membershipChange(roomId, userId, "ban", reason,
            callback);
    },

    unban: function(roomId, userId, callback) {
        // unbanning = set their state to leave
        return this._setMembershipState(
            roomId, userId, "leave", undefined, callback
        );
    },

    kick: function(roomId, userId, reason, callback) {
        return this._setMembershipState(
            roomId, userId, "leave", reason, callback
        );
    },

    _setMembershipState: function(roomId, userId, membershipValue, reason, 
                            callback) {
        if (utils.isFunction(reason)) { callback = reason; reason = undefined; }

        var path = utils.encodeUri(
            "/rooms/$roomId/state/m.room.member/$userId",
            { $roomId: roomId, $userId: userId}
        );

        return this._http.authedRequest(callback, "PUT", path, undefined, {
            membership: membershipValue,
            reason: reason
        });
    },

    _membershipChange: function(roomId, userId, membership, reason, 
                                callback) {
        if (utils.isFunction(reason)) { callback = reason; reason = undefined; }

        var path = utils.encodeUri("/rooms/$room_id/$membership", {
            $room_id: roomId,
            $membership: membership
        });
        return this._http.authedRequest(
            callback, "POST", path, undefined, {
                user_id: userId,  // may be undefined e.g. on leave
                reason: reason
            }
        );
    },

    // Profile operations
    // ==================

    getProfileInfo: function(userId, info, callback) {
        if (utils.isFunction(info)) { callback = info; info = undefined; }

        var path = info ?
        utils.encodeUri("/profile/$userId/$info",
                 { $userId: userId, $info: info }) :
        utils.encodeUri("/profile/$userId",
                 { $userId: userId });
        return this._http.authedRequest(callback, "GET", path);
    },

    setProfileInfo: function(info, data, callback) {
        var path = utils.encodeUri("/profile/$userId/$info", {
            $userId: this.credentials.userId,
            $info: info
        });
        return this._http.authedRequest(
            callback, "PUT", path, undefined, data
        );
    },

    setDisplayName: function(name, callback) {
        return this.setProfileInfo(
            "displayname", { displayname: name }, callback
        );
    },

    setAvatarUrl: function(url, callback) {
        return this.setProfileInfo(
            "avatar_url", { avatar_url: url }, callback
        );
    },

    getThreePids: function(creds, bind, callback) {
        var path = "/account/3pid";
        return this._http.authedRequestWithPrefix(
            callback, "GET", path, undefined, undefined, httpApi.PREFIX_V2_ALPHA
        );
    },

    addThreePid: function(creds, bind, callback) {
        var path = "/account/3pid";
        var data = {
            'threePidCreds': creds,
            'bind': bind
        };
        return this._http.authedRequestWithPrefix(
            callback, "POST", path, null, data, httpApi.PREFIX_V2_ALPHA
        );
    },

    setPresence: function(presence, callback) {
        var path = utils.encodeUri("/presence/$userId/status", {
            $userId: this.credentials.userId
        });
        var validStates = ["offline", "online", "unavailable"];
        if (validStates.indexOf(presence) == -1) {
            throw new Error("Bad presence value: " + presence);
        }
        var content = {
            presence: presence
        };
        return this._http.authedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    // Public (non-authed) operations
    // ==============================

    publicRooms: function(callback) {
        return this._http.request(callback, "GET", "/publicRooms");
    },

    registerFlows: function(callback) {
        return this._http.request(callback, "GET", "/register");
    },

    loginFlows: function(callback) {
        return this._http.request(callback, "GET", "/login");
    },

    resolveRoomAlias: function(roomAlias, callback) {
        var path = utils.encodeUri("/directory/room/$alias", {$alias: roomAlias});
        return this._http.request(callback, "GET", path);
    },

    roomInitialSync: function(roomId, limit, callback) {
        if (utils.isFunction(limit)) { callback = limit; limit = undefined; }
        var path = utils.encodeUri("/rooms/$roomId/initialSync",
            {$roomId: roomId}
        );
        if (!limit) {
            limit = 30;
        }
        return this._http.authedRequest(
            callback, "GET", path, { limit: limit }
        );
    },

    roomState: function(roomId, callback) {
        var path = utils.encodeUri("/rooms/$roomId/state", {$roomId: roomId});
        return this._http.authedRequest(callback, "GET", path);
    },

    scrollback: function(roomId, from, limit, callback) {
        if (utils.isFunction(limit)) { callback = limit; limit = undefined; }
        var path = utils.encodeUri("/rooms/$roomId/messages", {$roomId: roomId});
        if (!limit) {
            limit = 30;
        }
        var params = {
            from: from,
            limit: limit,
            dir: 'b'
        };
        return this._http.authedRequest(callback, "GET", path, params);
    },

    // Registration/Login operations
    // =============================

    login: function(loginType, data, callback) {
        data.type = loginType;
        return this._http.authedRequest(
            callback, "POST", "/login", undefined, data
        );
    },

    register: function(loginType, data, callback) {
        data.type = loginType;
        return this._http.authedRequest(
            callback, "POST", "/register", undefined, data
        );
    },

    loginWithPassword: function(user, password, callback) {
        return this.login("m.login.password", {
            user: user,
            password: password
        }, callback);
    },

    // Push operations
    // ===============

    pushRules: function(callback) {
        return this._http.authedRequest(callback, "GET", "/pushrules/");
    },

    addPushRule: function(scope, kind, ruleId, body, callback) {
        // NB. Scope not uri encoded because devices need the '/'
        var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId
        });
        return this._http.authedRequest(
            callback, "PUT", path, undefined, body
        );
    },

    deletePushRule: function(scope, kind, ruleId, callback) {
        // NB. Scope not uri encoded because devices need the '/'
        var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId
        });
        return this._http.authedRequest(callback, "DELETE", path);
    },

    // VoIP operations
    // ===============

    turnServer: function(callback) {
        return this._http.authedRequest(callback, "GET", "/voip/turnServer");
    },

    isLoggedIn: function() {
        return this._http.opts.accessToken !== undefined;
    },






    // Higher level APIs
    // =================

    // TODO: stuff to handle:
    //   local echo
    //   event dup suppression? - apparently we should still be doing this
    //   tracking current display name / avatar per-message
    //   pagination
    //   re-sending (including persisting pending messages to be sent)
    //   - Need a nice way to callback the app for arbitrary events like
    //     displayname changes
    //   due to ambiguity (or should this be on a chat-specific layer)?
    //   reconnect after connectivity outages

    /**
     * High level helper method to call initialSync, emit the resulting events,
     * and then start polling the eventStream for new events.
     * @param {module:client.streamCallback} callback Callback invoked whenever
     * new events are available.
     * @param {Number} historyLen amount of historical timeline events to
     * emit during from the initial sync. Default: 12.
     */
    startClient: function(callback, historyLen) {
        if (this.clientRunning) {
            // client is already running.
            return;
        }
        if (this.fromToken) {
            // resume from where we left off.
            this._pollForEvents(callback);
            return;
        }

        var self = this;
        this._http.authedRequest(
            undefined, "GET", "/initialSync", { limit: (historyLen || 12) }
        ).done(function(data) {
            var i, j;
            // intercept the results and put them into our store
            if (self.store) {
                var eventMapper = function(event) {
                    return new MatrixEvent(event);
                };
                utils.forEach(utils.map(data.presence, eventMapper), function(e) {
                    var user = new User(e.getContent().user_id, {
                        presence: e
                    });
                    self.store.storeUser(user);
                });
                for (i = 0; i < data.rooms.length; i++) {
                    var room = new Room(data.rooms[i].room_id);

                    // "old" and "current" state are the same initially; they
                    // start diverging if the user paginates.
                    var stateEvents = utils.map(data.rooms[i].state, eventMapper);
                    room.oldState.setStateEvents(stateEvents);
                    room.currentState.setStateEvents(stateEvents);

                    // add events to the timeline *after* setting the state
                    // events so messages use the right display names.
                    room.addEventsToTimeline(
                        utils.map(data.rooms[i].messages.chunk, eventMapper)
                    );

                    // cache the name/summary/etc prior to storage since we don't
                    // know how the store will serialise the Room.
                    room.recalculate(self.credentials.userId);

                    self.store.storeRoom(room);
                }
            }

            if (data) {
                self.fromToken = data.end;
                var events = [];
                for (i = 0; i < data.presence.length; i++) {
                    events.push(new MatrixEvent(data.presence[i]));
                }
                for (i = 0; i < data.rooms.length; i++) {
                    for (j = 0; j < data.rooms[i].state.length; j++) {
                        events.push(new MatrixEvent(data.rooms[i].state[j]));
                    }
                    for (j = 0; j < data.rooms[i].messages.chunk.length; j++) {
                        events.push(
                            new MatrixEvent(data.rooms[i].messages.chunk[j])
                        );
                    }
                }
                callback(null, events, false);
            }

            self.clientRunning = true;
            self._pollForEvents(callback);
        }, function(err) {
            callback(err);
            // TODO: Retries.
        });
    },

    _pollForEvents: function(callback) {
        var self = this;
        if (!this.clientRunning) {
            return;
        }
        this._http.authedRequest(undefined, "GET", "/events", {
            from: this.fromToken,
            timeout: 30000
        }).done(function(data) {
            var events = [];
            if (data) {
                events = utils.map(data.chunk, function(event) {
                    return new MatrixEvent(event);
                });
            }
            if (self.store) {
                // bucket events based on room.
                var i = 0;
                var roomIdToEvents = {};
                for (i = 0; i < events.length; i++) {
                    var roomId = events[i].getRoomId();
                    // possible to have no room ID e.g. for presence events.
                    if (roomId) {
                        if (!roomIdToEvents[roomId]) {
                            roomIdToEvents[roomId] = [];
                        }
                        roomIdToEvents[roomId].push(events[i]);
                    }
                }
                // add events to room
                var roomIds = utils.keys(roomIdToEvents);
                for (i = 0; i < roomIds.length; i++) {
                    var room = self.store.getRoom(roomIds[i]);
                    if (!room) {
                        // TODO: whine about this. We got an event for a room
                        // we don't know about (we should really be doing a
                        // roomInitialSync at this point to pull in state).
                        room = new Room(roomIds[i]);
                    }
                    room.addEvents(roomIdToEvents[roomIds[i]]);
                    room.recalculate(self.credentials.userId);
                }
            }
            if (data) {
                self.fromToken = data.end;
                callback(undefined, events, true);
            }
            self._pollForEvents(callback);
        }, function(err) {
            callback(err);
            // retry every few seconds
            // FIXME: this should be exponential backoff with an option to nudge
            setTimeout(function() {
                self._pollForEvents(callback);
            }, 2000);
        });
    },

    /**
     * High level helper method to stop the client from polling and allow a
     * clean shutdown.
     */
    stopClient: function() {
        this.clientRunning = false;
        // TODO: f.e. Room => self.store.storeRoom(room) ?
    }
};

/**
 * The standard MatrixClient callback interface. Functions which accept this
 * will specify 2 return arguments. These arguments map to the 2 parameters
 * specified in this callback.
 * @callback module:client.callback
 * @param {Object} err The error value, the "rejected" value or null.
 * @param {Object} data The data returned, the "resolved" value.
 */

 /**
  * {@link https://github.com/kriskowal/q|A promise implementation (Q)}. Functions
  * which return this will specify 2 return arguments. These arguments map to the
  * "onFulfilled" and "onRejected" values of the Promise.
  * @typedef {Object} Promise
  * @static
  * @property {Function} then promise.then(onFulfilled, onRejected, onProgress)
  * @property {Function} catch promise.catch(onRejected)
  * @property {Function} finally promise.finally(callback)
  * @property {Function} done promise.done(onFulfilled, onRejected, onProgress)
  */

/**
 * The event stream callback interface.
 * @callback module:client.streamCallback
 * @param {Object} err The error value, or null.
 * @param {Array<MatrixEvent>} data A list of events.
 * @param {boolean} isLive True if the events are from the event stream.
 */
