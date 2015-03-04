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
    exports.MatrixClient = MatrixClient;
    exports.createClient = function(credentials) {
        return new MatrixClient(credentials);
    };

    var PREFIX = "/_matrix/client/api/v1";
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

        invite: function(roomId, userId, callback) {
            return this._membershipChange(roomId, userId, "invite", callback);
        },

        leave: function(roomId, callback) {
            return this._membershipChange(roomId, undefined, "leave", callback);
        },

        _membershipChange: function(roomId, userId, membership, callback) {
            var path = encodeUri("/rooms/$room_id/$membership", {
                $room_id: roomId,
                $membership: membership
            });
            var data = {
                user_id: userId  // may be undefined e.g. on leave
            };
            return this._doAuthedRequest(
                callback, "POST", path, undefined, data
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

        // Internals
        // =========

        _doAuthedRequest: function(callback, method, path, params, data) {
            if (!params) { params = {}; }
            params.access_token = this.credentials.accessToken;
            return this._doRequest(callback, method, path, params, data);
        },

        _doRequest: function(callback, method, path, params, data) {
            var fullUri = this.credentials.baseUrl + PREFIX + path;
            console.log(" => %s", fullUri);
            if (!params) { params = {}; }

            return request(
            {
                uri: fullUri,
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
};

if (typeof exports === 'undefined') {
    init(this['matrixcs']={}); // this assigns to "window" on browsers
}
else {
    init(exports);
}