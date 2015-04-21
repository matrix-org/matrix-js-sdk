"use strict";

/*
TODO:
- CS: complete register function (doing stages)
- Internal: rate limiting
- Identity server: linkEmail, authEmail, bindEmail, lookup3pid
- uploadContent (?)
*/

// wrap in a closure for browsers
var init = function(exports){
    // expose the underlying request object so different environments can use
    // different request libs (e.g. request or browser-request)
    var request;
    exports.request = function(r) {
        request = r;
    };

    /*
     * Construct a Matrix Client.
     * @param {Object} credentials The credentials for this client
     * @param {Object} config The config (if any) for this client.
     * @param {Object} store The data store (if any) for this client.
     */
    function MatrixClient(credentials, config, store) {
        if (typeof credentials === "string") {
            credentials = {
                "baseUrl": credentials
            };
        }
        var requiredKeys = [
            "baseUrl"
        ];
        for (var i=0; i<requiredKeys.length; i++) {
            if (!credentials.hasOwnProperty(requiredKeys[i])) {
                throw new Error("Missing required key: " + requiredKeys[i]);
            }
        }
        if (config && config.noUserAgent) {
            HEADERS = undefined;
        }
        this.config = config;
        this.credentials = credentials;
        this.store = store;

        // track our position in the overall eventstream
        this.fromToken = undefined;
        this.clientRunning = false;
    };
    exports.MatrixClient = MatrixClient;  // expose the class
    exports.createClient = function(credentials, config, store) {
        return new MatrixClient(credentials, config, store);
    };

    var CLIENT_PREFIX = "/_matrix/client/api/v1";
    var CLIENT_V2_PREFIX = "/_matrix/client/v2_alpha";
    var HEADERS = {
        "User-Agent": "matrix-js"
    };
    
    function MatrixInMemoryStore() {
        this.rooms = {
            // state: { },
            // timeline: [ ],
        };
        
        this.presence = {
            // presence objects keyed by userId
        };
    };
    exports.MatrixInMemoryStore = MatrixInMemoryStore;
    
    MatrixInMemoryStore.prototype = {
        // XXX: this isn't very OOP - we could have Room and User objects etc
        // but instead we deliberately keep the primitives from the line protocol
        // around instead, to avoid lots of unnecessary shuffling.
        
        /*
         * Add an array of one or more state events into the store, overwriting
         * any existing state with the same {room, type, stateKey} tuple.
         */
        setStateEvents: function(stateEvents) {
            // we store stateEvents indexed by room, event type and state key.
            for (var i = 0; i < stateEvents.length; i++) {
                var event = stateEvents[i];
                var roomId = event.room_id;
                if (this.rooms[roomId] === undefined) {
                    this.rooms[roomId] = {};
                }
                if (this.rooms[roomId].state === undefined) {
                    this.rooms[roomId].state = {};
                }
                if (this.rooms[roomId].state[event.type] === undefined) {
                    this.rooms[roomId].state[event.type] = {};
                }
                this.rooms[roomId].state[event.type][event.state_key] = event;
            }
        },
       
        /*
         * Return a list of events from the store, filtered by roomid, type and state key.
         * @param {String} roomId the Room ID whose state is to be returned
         * @param {String} type the type of the state events to be returned (optional)
         * @param {String} stateKey the stateKey of the state events to be returned
         *                 (optional, requires type to be specified)
         */
        getStateEvents: function(roomId, type, stateKey) {
            var stateEvents = [];
            if (stateKey === undefined && type === undefined) {
                for (type in this.rooms[roomId].state) {
                    if (this.rooms[roomId].state.hasOwnProperty(type)) {
                        for (stateKey in this.rooms[roomId].state[type]) {
                            if (this.rooms[roomId].state[type].hasOwnProperty(stateKey)) {
                                stateEvents.push(this.rooms[roomId].state[type][stateKey]);
                            }
                        }
                    }
                }                    
                return stateEvents;
            }
            else if (stateKey === undefined) {
                for (stateKey in this.rooms[roomId].state[type]) {
                    if (this.rooms[roomId].state[type].hasOwnProperty(stateKey)) {
                        stateEvents.push(this.rooms[roomId].state[type][stateKey]);
                    }
                }
                return stateEvents;
            }
            else {
                return [this.rooms[roomId].state[type][stateKey]];
            }
        },
        
        /*
         * Return a single state event from the store for the given roomId
         * and type.  stateKey is optional; if missing, is assumed to be blank.
         */
        getStateEvent: function(roomId, type, stateKey) {
            if (stateKey === undefined) {
                return this.rooms[roomId].state[type][''];
            }
            else {
                return this.rooms[roomId].state[type][stateKey];
            }
        },
        
        /*
         * Adds a list of arbitrary events into the store.
         * If the event is a state event, it is also updates state.
         */
        setEvents: function(events) {
            for (var i = 0; i < events.length; i++) {
                var event = events[i];
                if (event.type === "m.presence") {
                    setPresenceEvents([event]);
                    continue;
                }
                var roomId = event.room_id;
                if (this.rooms[roomId] === undefined) {
                    this.rooms[roomId] = {};
                }                
                if (this.rooms[roomId].timeline === undefined) {
                    this.rooms[roomId].timeline = [];
                }
                if (event.state_key !== undefined) {
                    this.setStateEvents([event]);
                }
                this.rooms[roomId].timeline.push(event);
            }
        },
        
        /*
         * Get the timeline of events for a given room
         * TODO: ordering?
         */
        getEvents: function(roomId) {
            return this.room[roomId].timeline;
        },
        
        setPresenceEvents: function(presenceEvents) {
            for (var i = 0; i < presenceEvents.length; i++) {
                var event = presenceEvents[i];
                this.presence[event.user_id] = event;
            }
        },
        
        getPresenceEvents: function(userId) {
            return this.presence[userId];
        },
        
        getRoomList: function() {
            var roomIds = [];
            for (var roomId in this.rooms) {
                if (this.rooms.hasOwnProperty(roomId)) {
                    roomIds.push(roomId);
                }
            }
            return roomIds;
        },
        
        // TODO
        setMaxHistoryPerRoom: function(maxHistory) {},
        
        // TODO
        reapOldMessages: function() {},
    };

    MatrixClient.prototype = {
        isLoggedIn: function() {
            return this.credentials.accessToken != undefined &&
                   this.credentials.userId != undefined;
        },
        
        // Higher level APIs
        // =================
        
        // stuff to handle:
        //   local echo
        //   disambiguating display names in a room
        //   event dup suppression? - apparently we should still be doing so
        
        /*
         * Helper method for retrieving the name of a room suitable for display in the UI
         * TODO: in future, this should be being generated serverside.
         */
        getRoomFriendlyName: function(roomId) {
            // we need a store to track the inputs for calculating room names
            if (!this.store) return roomId;
            
            // check for an alias, if any. for now, assume first alias is the official one.
            var alias;
            var mRoomAliases = this.store.getStateEvent(roomId, 'm.room.aliases');
            if (mRoomAliases) {
                alias = mRoomAliases['aliases'][0];
            }
            
            var mRoomName = this.store.getStateEvent(roomId, 'm.room.name');
            if (mRoomName) {
                return mRoomName.name + (alias ? " (" + alias + ")": "");
            }
            else if (alias) {
                return alias;
            }
            else {
                var members = this.store.getStateEvents(roomId, 'm.room.member')
                    .filter(function(event) {
                        event.user_id !== this.credentials.userId;
                    });
                
                if (members.length == 1) {
                    return members[0].content.displayname || members[0].user_id;
                }
                else if (members.length == 2) {
                    return (members[0].content.displayname || members[0].user_id) + " and " +
                           (members[1].content.displayname || members[1].user_id);
                }
                else {
                    return (members[0].content.displayname || members[0].user_id) + " and " +
                           (members.length - 1) + " others";
                }
            }
        },
        
        /*
         * High level helper method to call initialSync, emit the resulting events,
         * and then start polling the eventStream for new events.
         */
        startClient: function(callback, historyLen) {
            historyLen = historyLen || 12;
            
            if (!this.fromToken) {
                this.initialSync(historyLen, function(err, data) {
                    if (err) {
                        console.error("err %s", JSON.stringify(err));
                        callback(err);
                    } else {
                        for (var i = 0; i < data.rooms.length; i++) {
                            callback(undefined, data.rooms[i].presence, false);
                            callback(undefined, data.rooms[i].state, false);
                            callback(undefined, data.rooms[i].messages.chunk, false);
                        }
                        this.clientRunning = true;
                        this._pollForEvents(callback);
                    }
                });
            }
            else {
                this._pollForEvents(callback);
            }
        },
        
        _pollForEvents: function(callback) {
            if (!this.clientRunning) return;
            this.eventStream(this.fromToken, 30000, function(err, data) {
                if (err) {
                    console.error("err %s", JSON.stringify(err));
                    callback(err);
                } else {
                    callback(undefined, data.chunk, true);
                    _pollForEvents(callback);
                }
            });
        },
        
        stopClient: function() {
            this.clientRunning = false;
        },

        // Room operations
        // ===============

        createRoom: function(options, callback) {
            // valid options include: room_alias_name, visibility, invite
            return this._doAuthedRequest(
                callback, "POST", "/createRoom", undefined, options
            );
        },

        joinRoom: function(roomIdOrAlias, callback) {
            var path = encodeUri("/join/$roomid", { $roomid: roomIdOrAlias});
            return this._doAuthedRequest(callback, "POST", path, undefined, {});
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
            if (event && event.type == "m.room.power_levels") {
                content = event.content;
            }
            content.users[userId] = powerLevel;
            var path = encodeUri("/rooms/$roomId/state/m.room.power_levels", {
                $roomId: roomId
            });
            return this._doAuthedRequest(
                callback, "PUT", path, undefined, content
            );
        },

        sendStateEvent: function(roomId, eventType, content, stateKey, 
                                 callback) {
            var pathParams = {
                $roomId: roomId,
                $eventType: eventType,
                $stateKey: stateKey
            };
            var path = encodeUri("/rooms/$roomId/state/$eventType", pathParams);
            if (stateKey !== undefined) {
                path = encodeUri(path + "/$stateKey", pathParams);
            }
            return this._doAuthedRequest(
                callback, "PUT", path, undefined, content
            );
        },

        sendEvent: function(roomId, eventType, content, txnId, callback) {
            if (isFunction(txnId)) { callback = txnId; txnId = undefined; }

            if (!txnId) {
                txnId = "m" + new Date().getTime();
            }

            var path = encodeUri("/rooms/$roomId/send/$eventType/$txnId", {
                $roomId: roomId,
                $eventType: eventType,
                $txnId: txnId
            });
            return this._doAuthedRequest(
                callback, "PUT", path, undefined, content
            )
        },

        sendMessage: function(roomId, content, txnId, callback) {
            if (isFunction(txnId)) { callback = txnId; txnId = undefined; }
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
            if (isFunction(text)) { callback = text; text = undefined; }
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
            var path = encodeUri("/rooms/$roomId/typing/$userId", {
                $roomId: roomId,
                $userId: this.credentials.userId
            });
            var data = {
                typing: isTyping
            };
            if (isTyping) {
                data.timeout = timeoutMs ? timeoutMs : 20000
            }
            return this._doAuthedRequest(
                callback, "PUT", path, undefined, data
            );
        },

        redactEvent: function(roomId, eventId, callback) {
            var path = encodeUri("/rooms/$roomId/redact/$eventId", {
                $roomId: roomId,
                $eventId: eventId
            });
            return this._doAuthedRequest(callback, "POST", path, undefined, {});
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
            if (isFunction(reason)) { callback = reason; reason = undefined; }

            var path = encodeUri(
                "/rooms/$roomId/state/m.room.member/$userId",
                { $roomId: roomId, $userId: userId}
            );

            return this._doAuthedRequest(callback, "PUT", path, undefined, {
                membership : membershipValue,
                reason: reason
            });
        },

        _membershipChange: function(roomId, userId, membership, reason, 
                                    callback) {
            if (isFunction(reason)) { callback = reason; reason = undefined; }

            var path = encodeUri("/rooms/$room_id/$membership", {
                $room_id: roomId,
                $membership: membership
            });
            return this._doAuthedRequest(
                callback, "POST", path, undefined, {
                    user_id: userId,  // may be undefined e.g. on leave
                    reason: reason
                }
            );
        },

        // Profile operations
        // ==================

        getProfileInfo: function(userId, info, callback) {
            if (isFunction(info)) { callback = info; info = undefined; }

            var path = info ? 
            encodeUri("/profile/$userId/$info", 
                     { $userId: userId, $info: info } ) :
            encodeUri("/profile/$userId", 
                     { $userId: userId } );
            return this._doAuthedRequest(callback, "GET", path);
        },

        setProfileInfo: function(info, data, callback) {
            var path = encodeUri("/profile/$userId/$info", {
                $userId: this.credentials.userId,
                $info: info
            });
            return this._doAuthedRequest(
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
            return this._doAuthedV2Request(
                callback, "GET", path, undefined, undefined
            );
        },

        addThreePid: function(creds, bind, callback) {
            var path = "/account/3pid";
            var data = {
                'threePidCreds': creds,
                'bind': bind
            };
            return this._doAuthedV2Request(
                callback, "POST", path, undefined, data
            );
        },

        setPresence: function(presence, callback) {
            var path = encodeUri("/presence/$userId/status", {
                $userId: this.credentials.userId
            });
            var validStates = ["offline", "online", "unavailable"];
            if (validStates.indexOf(presence) == -1) {
                throw new Error("Bad presence value: "+presence);
            }
            var content = {
                presence: presence
            };
            return this._doAuthedRequest(
                callback, "PUT", path, undefined, content
            );
        },

        // Public (non-authed) operations
        // ==============================

        publicRooms: function(callback) {
            return this._doRequest(callback, "GET", "/publicRooms");
        },

        registerFlows: function(callback) {
            return this._doRequest(callback, "GET", "/register");
        },

        loginFlows: function(callback) {
            return this._doRequest(callback, "GET", "/login");
        },

        resolveRoomAlias: function(roomAlias, callback) {
            var path = encodeUri("/directory/room/$alias", {$alias: roomAlias});
            return this._doRequest(callback, "GET", path);
        },

        // Syncing operations
        // ==================

        initialSync: function(limit, callback) {
            var params = {
                limit: limit
            };
            return this._doAuthedRequest(
                function(err, data) {
                    if (this.store) {
                        // intercept the results and put them into our store
                        this.store.setPresence(data.presence);
                        for (var i = 0 ; i < data.rooms.length; i++) {
                            this.store.setStateEvents(data.rooms[i].state);
                            this.store.setEvents(data.rooms[i].messages.chunk);
                        }
                    }
                    if (data) this.fromToken = data.end;
                    callback(err, data); // continue with original callback
                }, "GET", "/initialSync", params
            );
        },

        roomInitialSync: function(roomId, limit, callback) {
            if (isFunction(limit)) { callback = limit; limit = undefined; }
            var path = encodeUri("/rooms/$roomId/initialSync", 
                {$roomId: roomId}
            );
            if (!limit) {
                limit = 30;
            }
            return this._doAuthedRequest(
                callback, "GET", path, { limit: limit }
            );
        },

        roomState: function(roomId, callback) {
            var path = encodeUri("/rooms/$roomId/state", {$roomId: roomId});
            return this._doAuthedRequest(callback, "GET", path);
        },

        scrollback: function(roomId, from, limit, callback) {
            if (isFunction(limit)) { callback = limit; limit = undefined; }
            var path = encodeUri("/rooms/$roomId/messages", {$roomId: roomId});
            if (!limit) {
                limit = 30;
            }
            var params = {
                from: from,
                limit: limit,
                dir: 'b'
            }
            return this._doAuthedRequest(callback, "GET", path, params);
        },

        eventStream: function(from, timeout, callback) {
            if (isFunction(timeout)) { callback = timeout; timeout = undefined;}
            if (!timeout) {
                timeout = 30000;
            }

            var params = {
                from: from,
                timeout: timeout
            };
            return this._doAuthedRequest(
                function(err, data) {
                    if (this.store) {
                        this.store.setEvents(data.chunk);
                    }
                    if (data) this.fromToken = data.end;
                    callback(err, data); // continue with original callback
                }, "GET", "/events", params);
        },

        // Registration/Login operations
        // =============================

        login: function(loginType, data, callback) {
            data.type = loginType;
            return this._doAuthedRequest(
                callback, "POST", "/login", undefined, data
            );
            // XXX: surely we should store the results of this into our credentials
        },

        register: function(loginType, data, callback) {
            data.type = loginType;
            return this._doAuthedRequest(
                callback, "POST", "/register", undefined, data
            );
        },

        loginWithPassword: function(user, password, callback) {
            return this.login("m.login.password", {
                user: user,
                password: password
            }, callback)
        },

        // Push operations
        // ===============

        pushRules: function(callback) {
            return this._doAuthedRequest(callback, "GET", "/pushrules/");
        },

        addPushRule: function(scope, kind, ruleId, body, callback) {
            // NB. Scope not uri encoded because devices need the '/'
            var path = encodeUri("/pushrules/"+scope+"/$kind/$ruleId", {
                $kind: kind,
                $ruleId: ruleId
            });
            return this._doAuthedRequest(
                callback, "PUT", path, undefined, body
            );
        },

        deletePushRule: function(scope, kind, ruleId, callback) {
            // NB. Scope not uri encoded because devices need the '/'
            var path = encodeUri("/pushrules/"+scope+"/$kind/$ruleId", {
                $kind: kind,
                $ruleId: ruleId
            });
            return this._doAuthedRequest(callback, "DELETE", path);
        },

        // VoIP operations
        // ===============

        turnServer: function(callback) {
            return this._doAuthedRequest(callback, "GET", "/voip/turnServer");
        },

        // URI functions
        // =============

        getHttpUriForMxc: function(mxc, width, height, resizeMethod) {
            if (!typeof mxc === "string" || !mxc) {
                return mxc;
            }
            if (mxc.indexOf("mxc://") !== 0) {
                return mxc;
            }
            var serverAndMediaId = mxc.slice(6); // strips mxc://
            var prefix = "/_matrix/media/v1/download/";
            var params = {};

            if (width) {
                params.width = width;
            }
            if (height) {
                params.height = height;
            }
            if (resizeMethod) {
                params.method = resizeMethod;
            }
            if (Object.keys(params).length > 0) {
                // these are thumbnailing params so they probably want the
                // thumbnailing API...
                prefix = "/_matrix/media/v1/thumbnail/";
            }

            var fragmentOffset = serverAndMediaId.indexOf("#"),
                fragment = "";
            if (fragmentOffset >= 0) {
                fragment = serverAndMediaId.substr(fragmentOffset);
                serverAndMediaId = serverAndMediaId.substr(0, fragmentOffset);
            }
            return this.credentials.baseUrl + prefix + serverAndMediaId +
                (Object.keys(params).length === 0 ? "" :
                ("?" + encodeParams(params))) + fragment;
        },

        getIdenticonUri: function(identiconString, width, height) {
            if (!identiconString) {
                return;
            }
            if (!width) { width = 96; }
            if (!height) { height = 96; }
            var params = {
                width: width,
                height: height
            };

            var path = encodeUri("/_matrix/media/v1/identicon/$ident", {
                $ident: identiconString
            });
            return this.credentials.baseUrl + path + 
                (Object.keys(params).length === 0 ? "" : 
                    ("?" + encodeParams(params)));
        },

        /**
         * Get the content repository url with query parameters.
         * @returns An object with a 'base', 'path' and 'params' for base URL, 
         *          path and query parameters respectively.
         */
        getContentUri: function() {
            var params = {
                access_token: this.credentials.accessToken
            };
            return {
                base: this.credentials.baseUrl,
                path: "/_matrix/media/v1/upload",
                params: params
            };
        },

        // Internals
        // =========

        _doAuthedRequest: function(callback, method, path, params, data) {
            if (!params) { params = {}; }
            params.access_token = this.credentials.accessToken;
            return this._doRequest(callback, method, path, params, data);
        },

        _doAuthedV2Request: function(callback, method, path, params, data) {
            if (!params) { params = {}; }
            params.access_token = this.credentials.accessToken;
            return this._doV2Request(callback, method, path, params, data);
        },

        _doRequest: function(callback, method, path, params, data) {
            var fullUri = this.credentials.baseUrl + CLIENT_PREFIX + path;
            if (!params) { params = {}; }
            return this._request(callback, method, fullUri, params, data);  
        },

        _doV2Request: function(callback, method, path, params, data) {
            var fullUri = this.credentials.baseUrl + CLIENT_V2_PREFIX + path;
            if (!params) { params = {}; }
            return this._request(callback, method, fullUri, params, data);
        },

        _request: function(callback, method, uri, params, data) {
            if (callback !== undefined && !isFunction(callback)) {
                throw Error("Expected callback to be a function");
            }

            return request(
            {
                uri: uri,
                method: method,
                withCredentials: false,
                qs: params,
                body: data,
                json: true,
                headers: HEADERS,
                _matrix_credentials: this.credentials
            },
            requestCallback(callback)
            );
        }
    };

    var encodeUri = function(pathTemplate, variables) {
        for (var key in variables) {
            if (!variables.hasOwnProperty(key)) { continue; }
            pathTemplate = pathTemplate.replace(
                key, encodeURIComponent(variables[key])
            );
        }
        return pathTemplate;
    };

    // avoiding deps on jquery and co
    var encodeParams = function(params) {
        var qs = "";
        for (var key in params) {
            if (!params.hasOwnProperty(key)) { continue; }
            qs += "&" + encodeURIComponent(key) + "=" +
                    encodeURIComponent(params[key]);
        }
        return qs.substring(1);
    };

    var requestCallback = function(userDefinedCallback) {
        if (!userDefinedCallback) {
            return undefined;
        }
        return function(err, response, body) {
            if (err) {
                return userDefinedCallback(err);
            }
            if (response.statusCode >= 400) {
                return userDefinedCallback(body);
            }
            else {
                userDefinedCallback(null, body);
            }
        };
    };

    var isFunction = function(value) {
        return Object.prototype.toString.call(value) == "[object Function]";
    };
};

if (typeof exports === 'undefined') {
    init(this['matrixcs']={}); // this assigns to "window" on browsers
}
else {
    init(exports);
}
