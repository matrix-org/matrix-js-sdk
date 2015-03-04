"use strict";

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
            return this.credentials.accessToken != undefined;
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