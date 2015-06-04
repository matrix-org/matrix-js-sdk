"use strict";
/**
 * This is an internal module. See {@link MatrixClient} for the public class.
 * @module client
 */

var httpApi = require("./http-api");
var MatrixEvent = require("./models/event").MatrixEvent;
var utils = require("./utils");

// TODO:
// Internal: rate limiting

/**
 * Construct a Matrix Client.
 * @constructor
 * @param {Object} opts The configuration options for this client.
 * @param {string} opts.baseUrl Required. The base URL to the client-server HTTP API.
 * @param {Function} opts.request Required. The function to invoke for HTTP requests.
 * @param {boolean} opts.usePromises True to use promises rather than callbacks.
 * @param {string} opts.accessToken The access_token for this user.
 * @param {string} opts.userId The user ID for this user.
 * @param {Object} opts.store The data store to use. See {@link store/memory}.
 */
module.exports.MatrixClient = function MatrixClient(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);
    utils.checkObjectHasNoAdditionalKeys(opts,
        ["baseUrl", "request", "usePromises", "accessToken", "userId", "store"]
    );

    this.store = opts.store || null;
    // track our position in the overall eventstream
    this.fromToken = undefined;
    this.clientRunning = false;

    var httpOpts = {
        baseUrl: opts.baseUrl,
        accessToken: opts.accessToken,
        request: opts.request,
        prefix: httpApi.PREFIX_V1
    };
    this.credentials = {
        userId: (opts.userId || null)
    };
    this._http = new httpApi.MatrixHttpApi(httpOpts);
};
module.exports.MatrixClient.prototype = {

    // Room operations
    // ===============

    createRoom: function(options, callback) {
        // valid options include: room_alias_name, visibility, invite
        return this._http.authedRequest(
            callback, "POST", "/createRoom", undefined, options
        );
    },

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

    // Syncing operations
    // ==================

    initialSync: function(limit, callback) {
        var params = {
            limit: limit
        };
        return this._http.authedRequest(
            callback, "GET", "/initialSync", params
        );
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

    eventStream: function(from, timeout, callback) {
        if (utils.isFunction(timeout)) { callback = timeout; timeout = undefined;}
        if (!timeout) {
            timeout = 30000;
        }

        var params = {
            from: from,
            timeout: timeout
        };
        return this._http.authedRequest(callback, "GET", "/events", params);
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

    /*
     * Helper method for retrieving the name of a room suitable for display
     * in the UI
     * TODO: in future, this should be being generated serverside.
     * @param {String} roomId ID of room whose name is to be resolved
     * @return {String} human-readable label for room.
     */
    getFriendlyRoomName: function(roomId) {
        // we need a store to track the inputs for calculating room names
        if (!this.store) {
            return roomId;
        }

        // check for an alias, if any. for now, assume first alias is the
        // official one.
        var alias;
        var mRoomAliases = this.store.getStateEvents(roomId, 'm.room.aliases')[0];
        if (mRoomAliases) {
            alias = mRoomAliases.event.content.aliases[0];
        }

        var mRoomName = this.store.getStateEvent(roomId, 'm.room.name', '');
        if (mRoomName) {
            return mRoomName.event.content.name + (alias ? " (" + alias + ")" : "");
        }
        else if (alias) {
            return alias;
        }
        else {
            var userId = this.credentials.userId;
            var members = this.store.getStateEvents(roomId, 'm.room.member')
                .filter(function(event) {
                    return event.event.user_id !== userId;
                });

            if (members.length === 0) {
                return "Unknown";
            }
            else if (members.length == 1) {
                return (
                    members[0].event.content.displayname ||
                        members[0].event.user_id
                );
            }
            else if (members.length == 2) {
                return (
                    (members[0].event.content.displayname ||
                        members[0].event.user_id) +
                    " and " +
                    (members[1].event.content.displayname ||
                        members[1].event.user_id)
                );
            }
            else {
                return (
                    (members[0].event.content.displayname ||
                        members[0].event.user_id) +
                    " and " +
                    (members.length - 1) + " others"
                );
            }
        }
    },

    /*
     * Helper method for retrieving the name of a user suitable for display
     * in the UI in the context of a room - i.e. disambiguating from any
     * other users in the room.
     * XXX: This could perhaps also be generated serverside, perhaps by just passing
     * a 'disambiguate' flag down on membership entries which have ambiguous
     * displaynames?
     * @param {String} userId ID of the user whose name is to be resolved
     * @param {String} roomId ID of room to be used as the context for
     * resolving the name.
     * @return {String} human-readable name of the user.
     */
    getFriendlyDisplayName: function(userId, roomId) {
        // we need a store to track the inputs for calculating display names
        if (!this.store) { return userId; }

        var displayName;
        var memberEvent = this.store.getStateEvent(roomId, 'm.room.member', userId);
        if (memberEvent && memberEvent.event.content.displayname) {
            displayName = memberEvent.event.content.displayname;
        }
        else {
            return userId;
        }

        var members = this.store.getStateEvents(roomId, 'm.room.member')
            .filter(function(event) {
                return event.event.content.displayname === displayName;
            });

        if (members.length > 1) {
            return displayName + " (" + userId + ")";
        }
        else {
            return displayName;
        }
    },

    /*
     * High level helper method to call initialSync, emit the resulting events,
     * and then start polling the eventStream for new events.
     * @param {function} callback Callback invoked whenever new event are available
     * @param {Number} historyLen amount of historical timeline events to
     * emit during from the initial sync.
     */
    startClient: function(callback, historyLen) {
        historyLen = historyLen || 12;

        var self = this;
        if (!this.fromToken) {
            this._http.initialSync(historyLen, function(err, data) {
                var i, j;
                if (err) {
                    if (this.config && this.config.debug) {
                        console.error(
                            "startClient error on initialSync: %s",
                            JSON.stringify(err)
                        );
                    }
                    callback(err);
                    return;
                }
                if (self.store) {
                    var eventMapper = function(event) {
                        return new MatrixEvent(event);
                    };
                    // intercept the results and put them into our store
                    self.store.setPresenceEvents(
                        utils.map(data.presence, eventMapper)
                    );
                    for (i = 0; i < data.rooms.length; i++) {
                        self.store.setStateEvents(
                            utils.map(data.rooms[i].state, eventMapper)
                        );
                        self.store.setEvents(
                            utils.map(data.rooms[i].messages.chunk, eventMapper)
                        );
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
                    callback(undefined, events, false);
                }

                self.clientRunning = true;
                self._pollForEvents(callback);
            });
        }
        else {
            this._pollForEvents(callback);
        }
    },

    _pollForEvents: function(callback) {
        var self = this;
        if (!this.clientRunning) {
            return;
        }
        this._http.eventStream(this.fromToken, 30000, function(err, data) {
            if (err) {
                if (this.config && this.config.debug) {
                    console.error(
                        "error polling for events via eventStream: %s",
                        JSON.stringify(err)
                    );
                }
                callback(err);
                // retry every few seconds
                // FIXME: this should be exponential backoff with an option to nudge
                setTimeout(function() {
                    self._pollForEvents(callback);
                }, 2000);
                return;
            }

            if (self.store) {
                self.store.setEvents(utils.map(data.chunk,
                    function(event) {
                        return new MatrixEvent(event);
                    }
                ));
            }
            if (data) {
                self.fromToken = data.end;
                var events = [];
                for (var j = 0; j < data.chunk.length; j++) {
                    events.push(new MatrixEvent(data.chunk[j]));
                }
                callback(undefined, events, true);
            }
            self._pollForEvents(callback);
        });
    },

    /*
     * High level helper method to stop the client from polling and allow a
     * clean shutdown.
     */
    stopClient: function() {
        this.clientRunning = false;
    },
};
