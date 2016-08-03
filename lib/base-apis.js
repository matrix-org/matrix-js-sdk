/*
Copyright 2015, 2016 OpenMarket Ltd

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

/**
 * This is an internal module. MatrixBaseApis is currently only meant to be used
 * by {@link client~MatrixClient}.
 *
 * @module base-apis
 */

var httpApi = require("./http-api");
var utils = require("./utils");

/**
 * Low-level wrappers for the Matrix APIs
 *
 * @constructor
 *
 * @param {Object} opts Configuration options
 *
 * @param {string} opts.baseUrl Required. The base URL to the client-server
 * HTTP API.
 *
 * @param {string} opts.idBaseUrl Optional. The base identity server URL for
 * identity server requests.
 *
 * @param {Function} opts.request Required. The function to invoke for HTTP
 * requests. The value of this property is typically <code>require("request")
 * </code> as it returns a function which meets the required interface. See
 * {@link requestFunction} for more information.
 *
 * @param {string} opts.accessToken The access_token for this user.
 *
 * @param {Object} opts.queryParams Optional. Extra query parameters to append
 * to all requests with this client. Useful for application services which require
 * <code>?user_id=</code>.
 *
 */
function MatrixBaseApis(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);

    this.baseUrl = opts.baseUrl;
    this.idBaseUrl = opts.idBaseUrl;

    var httpOpts = {
        baseUrl: opts.baseUrl,
        idBaseUrl: opts.idBaseUrl,
        accessToken: opts.accessToken,
        request: opts.request,
        prefix: httpApi.PREFIX_R0,
        onlyData: true,
        extraParams: opts.queryParams
    };
    this._http = new httpApi.MatrixHttpApi(this, httpOpts);
}


/**
 * Get the Homeserver URL of this client
 * @return {string} Homeserver URL of this client
 */
MatrixBaseApis.prototype.getHomeserverUrl = function() {
    return this.baseUrl;
};

/**
 * Get the Identity Server URL of this client
 * @return {string} Identity Server URL of this client
 */
MatrixBaseApis.prototype.getIdentityServerUrl = function() {
    return this.idBaseUrl;
};

/**
 * Get the access token associated with this account.
 * @return {?String} The access_token or null
 */
MatrixBaseApis.prototype.getAccessToken = function() {
    return this._http.opts.accessToken || null;
};

/**
 * @return {boolean} true if there is a valid access_token for this client.
 */
MatrixBaseApis.prototype.isLoggedIn = function() {
    return this._http.opts.accessToken !== undefined;
};


// Registration/Login operations
// =============================

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.loginFlows = function(callback) {
    return this._http.request(callback, "GET", "/login");
};

/**
 * Logs out the current session.
 * Obviously, further calls that require authorisation should fail after this
 * method is called. The state of the MatrixClient object is not affected:
 * it is up to the caller to either reset or destroy the MatrixClient after
 * this method succeeds.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: On success, the empty object
 */
MatrixBaseApis.prototype.logout = function(callback) {
    return this._http.authedRequest(
        callback, "POST", '/logout'
    );
};


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
MatrixBaseApis.prototype.createRoom = function(options, callback) {
    // valid options include: room_alias_name, visibility, invite
    return this._http.authedRequest(
        callback, "POST", "/createRoom", undefined, options
    );
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.roomState = function(roomId, callback) {
    var path = utils.encodeUri("/rooms/$roomId/state", {$roomId: roomId});
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * Retrieve a state event.
 * @param {string} roomId
 * @param {string} eventType
 * @param {string} stateKey
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getStateEvent = function(roomId, eventType, stateKey, callback) {
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
};

/**
 * @param {string} roomId
 * @param {string} eventType
 * @param {Object} content
 * @param {string} stateKey
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.sendStateEvent = function(roomId, eventType, content, stateKey,
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
};

/**
 * @param {string} roomId
 * @param {string} eventId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.redactEvent = function(roomId, eventId, callback) {
    var path = utils.encodeUri("/rooms/$roomId/redact/$eventId", {
        $roomId: roomId,
        $eventId: eventId
    });
    return this._http.authedRequest(callback, "POST", path, undefined, {});
};

/**
 * @param {string} roomId
 * @param {Number} limit
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.roomInitialSync = function(roomId, limit, callback) {
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
};


// Room Directory operations
// =========================

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.publicRooms = function(callback) {
    return this._http.authedRequest(callback, "GET", "/publicRooms");
};

/**
 * Create an alias to room ID mapping.
 * @param {string} alias The room alias to create.
 * @param {string} roomId The room ID to link the alias to.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.createAlias = function(alias, roomId, callback) {
    var path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias
    });
    var data = {
        room_id: roomId
    };
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data
    );
};

/**
 * Delete an alias to room ID mapping.  This alias must be on your local server
 * and you must have sufficient access to do this operation.
 * @param {string} alias The room alias to delete.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.deleteAlias = function(alias, callback) {
    var path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias
    });
    return this._http.authedRequest(
        callback, "DELETE", path, undefined, undefined
    );
};

/**
 * Get room info for the given alias.
 * @param {string} alias The room alias to resolve.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Object with room_id and servers.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getRoomIdForAlias = function(alias, callback) {
    // TODO: deprecate this or resolveRoomAlias
    var path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias
    });
    return this._http.authedRequest(
        callback, "GET", path
    );
};

/**
 * @param {string} roomAlias
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.resolveRoomAlias = function(roomAlias, callback) {
    // TODO: deprecate this or getRoomIdForAlias
    var path = utils.encodeUri("/directory/room/$alias", {$alias: roomAlias});
    return this._http.request(callback, "GET", path);
};

/**
 * Get the visibility of a room in the current HS's room directory
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getRoomDirectoryVisibility =
                                function(roomId, callback) {
    var path = utils.encodeUri("/directory/list/room/$roomId", {
        $roomId: roomId
    });
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * Set the visbility of a room in the current HS's room directory
 * @param {string} roomId
 * @param {string} visibility "public" to make the room visible
 *                 in the public directory, or "private" to make
 *                 it invisible.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setRoomDirectoryVisibility =
                                function(roomId, visibility, callback) {
    var path = utils.encodeUri("/directory/list/room/$roomId", {
        $roomId: roomId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, { "visibility": visibility }
    );
};


// Media operations
// ================

/**
 * Upload a file to the media repository on the home server.
 * @param {File} file object
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.uploadContent = function(file, callback) {
    return this._http.uploadContent(file, callback);
};

/**
 * Cancel a file upload in progress
 * @param {module:client.Promise} promise The promise returned from uploadContent
 * @return {boolean} true if canceled, otherwise false
 */
MatrixBaseApis.prototype.cancelUpload = function(promise) {
    return this._http.cancelUpload(promise);
};

/**
 * Get a list of all file uploads in progress
 * @return {array} Array of objects representing current uploads.
 * Currently in progress is element 0. Keys:
 *  - promise: The promise associated with the upload
 *  - loaded: Number of bytes uploaded
 *  - total: Total number of bytes to upload
 */
MatrixBaseApis.prototype.getCurrentUploads = function() {
    return this._http.getCurrentUploads();
};


// Profile operations
// ==================

/**
 * @param {string} userId
 * @param {string} info The kind of info to retrieve (e.g. 'displayname',
 * 'avatar_url').
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getProfileInfo = function(userId, info, callback) {
    if (utils.isFunction(info)) { callback = info; info = undefined; }

    var path = info ?
    utils.encodeUri("/profile/$userId/$info",
             { $userId: userId, $info: info }) :
    utils.encodeUri("/profile/$userId",
             { $userId: userId });
    return this._http.authedRequest(callback, "GET", path);
};


// Account operations
// ==================

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getThreePids = function(callback) {
    var path = "/account/3pid";
    return this._http.authedRequest(
        callback, "GET", path, undefined, undefined
    );
};

/**
 * @param {Object} creds
 * @param {boolean} bind
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.addThreePid = function(creds, bind, callback) {
    var path = "/account/3pid";
    var data = {
        'threePidCreds': creds,
        'bind': bind
    };
    return this._http.authedRequest(
        callback, "POST", path, null, data
    );
};

/**
 * Make a request to change your password.
 * @param {Object} authDict
 * @param {string} newPassword The new desired password.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setPassword = function(authDict, newPassword, callback) {
    var path = "/account/password";
    var data = {
        'auth': authDict,
        'new_password': newPassword
    };

    return this._http.authedRequest(
        callback, "POST", path, null, data
    );
};


// Device operations
// =================

/**
 * Gets all devices recorded for the logged-in user
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getDevices = function() {
    var path = "/devices";
    return this._http.authedRequestWithPrefix(
        undefined, "GET", path, undefined, undefined,
        httpApi.PREFIX_UNSTABLE
    );
};

/**
 * Update the given device
 *
 * @param {string} device_id  device to update
 * @param {Object} body       body of request
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setDeviceDetails = function(device_id, body) {
    var path = utils.encodeUri("/devices/$device_id", {
        $device_id: device_id,
    });


    return this._http.authedRequestWithPrefix(
        undefined, "PUT", path, undefined, body,
        httpApi.PREFIX_UNSTABLE
    );
};

/**
 * Delete the given device
 *
 * @param {string} device_id  device to delete
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.deleteDevice = function(device_id) {
    var path = utils.encodeUri("/devices/$device_id", {
        $device_id: device_id,
    });

    return this._http.authedRequestWithPrefix(
        undefined, "DELETE", path, undefined, undefined,
        httpApi.PREFIX_UNSTABLE
    );
};


// Push operations
// ===============

/**
 * Gets all pushers registered for the logged-in user
 *
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Array of objects representing pushers
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getPushers = function(callback) {
    var path = "/pushers";
    return this._http.authedRequest(
        callback, "GET", path, undefined, undefined
    );
};

/**
 * Adds a new pusher or updates an existing pusher
 *
 * @param {Object} pusher Object representing a pusher
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Empty json object on success
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setPusher = function(pusher, callback) {
    var path = "/pushers/set";
    return this._http.authedRequest(
        callback, "POST", path, null, pusher
    );
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getPushRules = function(callback) {
    return this._http.authedRequest(callback, "GET", "/pushrules/");
};

/**
 * @param {string} scope
 * @param {string} kind
 * @param {string} ruleId
 * @param {Object} body
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.addPushRule = function(scope, kind, ruleId, body, callback) {
    // NB. Scope not uri encoded because devices need the '/'
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, body
    );
};

/**
 * @param {string} scope
 * @param {string} kind
 * @param {string} ruleId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.deletePushRule = function(scope, kind, ruleId, callback) {
    // NB. Scope not uri encoded because devices need the '/'
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(callback, "DELETE", path);
};

/**
 * Enable or disable a push notification rule.
 * @param {string} scope
 * @param {string} kind
 * @param {string} ruleId
 * @param {boolean} enabled
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setPushRuleEnabled = function(scope, kind,
                                                     ruleId, enabled, callback) {
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/enabled", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, {"enabled": enabled}
    );
};

/**
 * Set the actions for a push notification rule.
 * @param {string} scope
 * @param {string} kind
 * @param {string} ruleId
 * @param {array} actions
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setPushRuleActions = function(scope, kind,
                                                     ruleId, actions, callback) {
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/actions", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, {"actions": actions}
    );
};


// Search
// ======

/**
 * Perform a server-side search.
 * @param {Object} opts
 * @param {string} opts.next_batch the batch token to pass in the query string
 * @param {Object} opts.body the JSON object to pass to the request body.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.search = function(opts, callback) {
    var queryparams = {};
    if (opts.next_batch) {
        queryparams.next_batch = opts.next_batch;
    }
    return this._http.authedRequest(
        callback, "POST", "/search", queryparams, opts.body
    );
};


// Identity Server Operations
// ==========================

/**
 * Requests an email verification token directly from an Identity Server.
 *
 * Note that the Home Server offers APIs to proxy this API for specific
 * situations, allowing for better feedback to the user.
 *
 * @param {string} email The email address to request a token for
 * @param {string} clientSecret A secret binary string generated by the client.
 *                 It is recommended this be around 16 ASCII characters.
 * @param {number} sendAttempt If an identity server sees a duplicate request
 *                 with the same sendAttempt, it will not send another email.
 *                 To request another email to be sent, use a larger value for
 *                 the sendAttempt param as was used in the previous request.
 * @param {string} nextLink Optional If specified, the client will be redirected
 *                 to this link after validation.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * @throws Error if No ID server is set
 */
MatrixBaseApis.prototype.requestEmailToken = function(email, clientSecret,
                                                    sendAttempt, nextLink, callback) {
    var params = {
        client_secret: clientSecret,
        email: email,
        send_attempt: sendAttempt,
        next_link: nextLink
    };
    return this._http.idServerRequest(
        callback, "POST", "/validate/email/requestToken",
        params, httpApi.PREFIX_IDENTITY_V1
    );
};

/**
 * Looks up the public Matrix ID mapping for a given 3rd party
 * identifier from the Identity Server
 * @param {string} medium The medium of the threepid, eg. 'email'
 * @param {string} address The textual address of the threepid
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: A threepid mapping
 *                                 object or the empty object if no mapping
 *                                 exists
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.lookupThreePid = function(medium, address, callback) {
    var params = {
        medium: medium,
        address: address,
    };
    return this._http.idServerRequest(
        callback, "GET", "/lookup",
        params, httpApi.PREFIX_IDENTITY_V1
    );
};

/**
 * MatrixBaseApis object
 */
module.exports = MatrixBaseApis;
