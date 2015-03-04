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

    // entry point
    function MatrixClient(credentials) {
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
        if (credentials.noUserAgent) {
            HEADERS = undefined;
        }
        this.credentials = credentials;
    };
    exports.MatrixClient = MatrixClient;  // expose the class
    exports.createClient = function(credentials) {
        return new MatrixClient(credentials);
    };

    var CLIENT_PREFIX = "/_matrix/client/api/v1";
    var HEADERS = {
        "User-Agent": "matrix-js"
    };

    MatrixClient.prototype = {
        isLoggedIn: function() {
            return this.credentials.accessToken != undefined &&
            this.credentials.userId != undefined;
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
                callback, "GET", "/initialSync", params
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
            return this._doAuthedRequest(callback, "GET", "/events", params);
        },

        // Registration/Login operations
        // =============================

        login: function(loginType, data, callback) {
            data.type = loginType;
            return this._doAuthedRequest(
                callback, "POST", "/login", undefined, data
            );
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

        _doRequest: function(callback, method, path, params, data) {
            var fullUri = this.credentials.baseUrl + CLIENT_PREFIX + path;
            if (!params) { params = {}; }
            return this._request(callback, method, fullUri, params, data);  
        },

        _request: function(callback, method, uri, params, data) {
            console.log(" => %s", uri);
            console.log("    %s", JSON.stringify(data));
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
                headers: HEADERS
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