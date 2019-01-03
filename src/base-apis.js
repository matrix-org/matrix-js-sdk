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

/**
 * This is an internal module. MatrixBaseApis is currently only meant to be used
 * by {@link client~MatrixClient}.
 *
 * @module base-apis
 */

const httpApi = require("./http-api");
const utils = require("./utils");

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
 * @param {Number=} opts.localTimeoutMs Optional. The default maximum amount of
 * time to wait before timing out HTTP requests. If not specified, there is no
 * timeout.
 *
 * @param {Object} opts.queryParams Optional. Extra query parameters to append
 * to all requests with this client. Useful for application services which require
 * <code>?user_id=</code>.
 *
 * @param {boolean} [opts.useAuthorizationHeader = false] Set to true to use
 * Authorization header instead of query param to send the access token to the server.
 */
function MatrixBaseApis(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);

    this.baseUrl = opts.baseUrl;
    this.idBaseUrl = opts.idBaseUrl;

    const httpOpts = {
        baseUrl: opts.baseUrl,
        idBaseUrl: opts.idBaseUrl,
        accessToken: opts.accessToken,
        request: opts.request,
        prefix: httpApi.PREFIX_R0,
        onlyData: true,
        extraParams: opts.queryParams,
        localTimeoutMs: opts.localTimeoutMs,
        useAuthorizationHeader: opts.useAuthorizationHeader,
    };
    this._http = new httpApi.MatrixHttpApi(this, httpOpts);

    this._txnCtr = 0;
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
 * @param {boolean} stripProto whether or not to strip the protocol from the URL
 * @return {string} Identity Server URL of this client
 */
MatrixBaseApis.prototype.getIdentityServerUrl = function(stripProto=false) {
    if (stripProto && (this.idBaseUrl.startsWith("http://") ||
            this.idBaseUrl.startsWith("https://"))) {
        return this.idBaseUrl.split("://")[1];
    }
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

/**
 * Make up a new transaction id
 *
 * @return {string} a new, unique, transaction id
 */
MatrixBaseApis.prototype.makeTxnId = function() {
    return "m" + new Date().getTime() + "." + (this._txnCtr++);
};


// Registration/Login operations
// =============================

/**
 * Check whether a username is available prior to registration. An error response
 * indicates an invalid/unavailable username.
 * @param {string} username The username to check the availability of.
 * @return {module:client.Promise} Resolves: to `true`.
 */
MatrixBaseApis.prototype.isUsernameAvailable = function(username) {
    return this._http.authedRequest(
        undefined, "GET", '/register/available', { username: username },
    ).then((response) => {
        return response.available;
    });
};

/**
 * @param {string} username
 * @param {string} password
 * @param {string} sessionId
 * @param {Object} auth
 * @param {Object} bindThreepids Set key 'email' to true to bind any email
 *     threepid uses during registration in the ID server. Set 'msisdn' to
 *     true to bind msisdn.
 * @param {string} guestAccessToken
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.register = function(
    username, password,
    sessionId, auth, bindThreepids, guestAccessToken,
    callback,
) {
    // backwards compat
    if (bindThreepids === true) {
        bindThreepids = {email: true};
    } else if (bindThreepids === null || bindThreepids === undefined) {
        bindThreepids = {};
    }

    if (auth === undefined || auth === null) {
        auth = {};
    }
    if (sessionId) {
        auth.session = sessionId;
    }

    const params = {
        auth: auth,
    };
    if (username !== undefined && username !== null) {
        params.username = username;
    }
    if (password !== undefined && password !== null) {
        params.password = password;
    }
    if (bindThreepids.email) {
        params.bind_email = true;
    }
    if (bindThreepids.msisdn) {
        params.bind_msisdn = true;
    }
    if (guestAccessToken !== undefined && guestAccessToken !== null) {
        params.guest_access_token = guestAccessToken;
    }
    // Temporary parameter added to make the register endpoint advertise
    // msisdn flows. This exists because there are clients that break
    // when given stages they don't recognise. This parameter will cease
    // to be necessary once these old clients are gone.
    // Only send it if we send any params at all (the password param is
    // mandatory, so if we send any params, we'll send the password param)
    if (password !== undefined && password !== null) {
        params.x_show_msisdn = true;
    }

    return this.registerRequest(params, undefined, callback);
};

/**
 * Register a guest account.
 * @param {Object=} opts Registration options
 * @param {Object} opts.body JSON HTTP body to provide.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.registerGuest = function(opts, callback) {
    opts = opts || {};
    opts.body = opts.body || {};
    return this.registerRequest(opts.body, "guest", callback);
};

/**
 * @param {Object} data   parameters for registration request
 * @param {string=} kind  type of user to register. may be "guest"
 * @param {module:client.callback=} callback
 * @return {module:client.Promise} Resolves: to the /register response
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.registerRequest = function(data, kind, callback) {
    const params = {};
    if (kind) {
        params.kind = kind;
    }

    return this._http.request(
        callback, "POST", "/register", params, data,
    );
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.loginFlows = function(callback) {
    return this._http.request(callback, "GET", "/login");
};

/**
 * @param {string} loginType
 * @param {Object} data
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.login = function(loginType, data, callback) {
    const login_data = {
        type: loginType,
    };

    // merge data into login_data
    utils.extend(login_data, data);

    return this._http.authedRequest(
        (error, response) => {
            if (loginType === "m.login.password" && response &&
                response.access_token && response.user_id) {
                this._http.opts.accessToken = response.access_token;
                this.credentials = {
                    userId: response.user_id,
                };
            }

            if (callback) {
                callback(error, response);
            }
        }, "POST", "/login", undefined, login_data,
    );
};

/**
 * @param {string} user
 * @param {string} password
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.loginWithPassword = function(user, password, callback) {
    return this.login("m.login.password", {
        user: user,
        password: password,
    }, callback);
};

/**
 * @param {string} relayState URL Callback after SAML2 Authentication
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.loginWithSAML2 = function(relayState, callback) {
    return this.login("m.login.saml2", {
        relay_state: relayState,
    }, callback);
};

/**
 * @param {string} redirectUrl The URL to redirect to after the HS
 * authenticates with CAS.
 * @return {string} The HS URL to hit to begin the CAS login process.
 */
MatrixBaseApis.prototype.getCasLoginUrl = function(redirectUrl) {
    return this.getSsoLoginUrl(redirectUrl, "cas");
};

/**
 * @param {string} redirectUrl The URL to redirect to after the HS
 *     authenticates with the SSO.
 * @param {string} loginType The type of SSO login we are doing (sso or cas).
 *     Defaults to 'sso'.
 * @return {string} The HS URL to hit to begin the SSO login process.
 */
MatrixBaseApis.prototype.getSsoLoginUrl = function(redirectUrl, loginType) {
    if (loginType === undefined) {
        loginType = "sso";
    }
    return this._http.getUrl("/login/"+loginType+"/redirect", {
        "redirectUrl": redirectUrl,
    }, httpApi.PREFIX_R0);
};

/**
 * @param {string} token Login token previously received from homeserver
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.loginWithToken = function(token, callback) {
    return this.login("m.login.token", {
        token: token,
    }, callback);
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
        callback, "POST", '/logout',
    );
};

/**
 * Deactivates the logged-in account.
 * Obviously, further calls that require authorisation should fail after this
 * method is called. The state of the MatrixClient object is not affected:
 * it is up to the caller to either reset or destroy the MatrixClient after
 * this method succeeds.
 * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
 * @param {boolean} erase Optional. If set, send as `erase` attribute in the
 * JSON request body, indicating whether the account should be erased. Defaults
 * to false.
 * @return {module:client.Promise} Resolves: On success, the empty object
 */
MatrixBaseApis.prototype.deactivateAccount = function(auth, erase) {
    if (typeof(erase) === 'function') {
        throw new Error(
            'deactivateAccount no longer accepts a callback parameter',
        );
    }

    const body = {};
    if (auth) {
        body.auth = auth;
    }
    if (erase !== undefined) {
        body.erase = erase;
    }

    return this._http.authedRequestWithPrefix(
        undefined, "POST", '/account/deactivate', undefined, body,
        httpApi.PREFIX_R0,
    );
};

/**
 * Get the fallback URL to use for unknown interactive-auth stages.
 *
 * @param {string} loginType     the type of stage being attempted
 * @param {string} authSessionId the auth session ID provided by the homeserver
 *
 * @return {string} HS URL to hit to for the fallback interface
 */
MatrixBaseApis.prototype.getFallbackAuthUrl = function(loginType, authSessionId) {
    const path = utils.encodeUri("/auth/$loginType/fallback/web", {
        $loginType: loginType,
    });

    return this._http.getUrl(path, {
        session: authSessionId,
    }, httpApi.PREFIX_R0);
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
        callback, "POST", "/createRoom", undefined, options,
    );
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.roomState = function(roomId, callback) {
    const path = utils.encodeUri("/rooms/$roomId/state", {$roomId: roomId});
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * Get an event in a room by its event id.
 * @param {string} roomId
 * @param {string} eventId
 * @param {module:client.callback} callback Optional.
 *
 * @return {Promise} Resolves to an object containing the event.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.fetchRoomEvent = function(roomId, eventId, callback) {
    const path = utils.encodeUri(
        "/rooms/$roomId/event/$eventId", {
            $roomId: roomId,
            $eventId: eventId,
        },
    );
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * @param {string} roomId
 * @param {string} includeMembership the membership type to include in the response
 * @param {string} excludeMembership the membership type to exclude from the response
 * @param {string} atEventId the id of the event for which moment in the timeline the members should be returned for
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: dictionary of userid to profile information
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.members =
function(roomId, includeMembership, excludeMembership, atEventId, callback) {
    const queryParams = {};
    if (includeMembership) {
        queryParams.membership = includeMembership;
    }
    if (excludeMembership) {
        queryParams.not_membership = excludeMembership;
    }
    if (atEventId) {
        queryParams.at = atEventId;
    }

    const queryString = utils.encodeParams(queryParams);

    const path = utils.encodeUri("/rooms/$roomId/members?" + queryString,
        {$roomId: roomId});
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * Upgrades a room to a new protocol version
 * @param {string} roomId
 * @param {string} newVersion The target version to upgrade to
 * @return {module:client.Promise} Resolves: Object with key 'replacement_room'
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.upgradeRoom = function(roomId, newVersion) {
    const path = utils.encodeUri("/rooms/$roomId/upgrade", {$roomId: roomId});
    return this._http.authedRequest(
        undefined, "POST", path, undefined, {new_version: newVersion},
    );
};


/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Group summary object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getGroupSummary = function(groupId) {
    const path = utils.encodeUri("/groups/$groupId/summary", {$groupId: groupId});
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Group profile object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getGroupProfile = function(groupId) {
    const path = utils.encodeUri("/groups/$groupId/profile", {$groupId: groupId});
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * @param {string} groupId
 * @param {Object} profile The group profile object
 * @param {string=} profile.name Name of the group
 * @param {string=} profile.avatar_url MXC avatar URL
 * @param {string=} profile.short_description A short description of the room
 * @param {string=} profile.long_description A longer HTML description of the room
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setGroupProfile = function(groupId, profile) {
    const path = utils.encodeUri("/groups/$groupId/profile", {$groupId: groupId});
    return this._http.authedRequest(
        undefined, "POST", path, undefined, profile,
    );
};

/**
 * @param {string} groupId
 * @param {object} policy The join policy for the group. Must include at
 *     least a 'type' field which is 'open' if anyone can join the group
 *     the group without prior approval, or 'invite' if an invite is
 *     required to join.
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setGroupJoinPolicy = function(groupId, policy) {
    const path = utils.encodeUri(
        "/groups/$groupId/settings/m.join_policy",
        {$groupId: groupId},
    );
    return this._http.authedRequest(
        undefined, "PUT", path, undefined, {
            'm.join_policy': policy,
        },
    );
};

/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Group users list object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getGroupUsers = function(groupId) {
    const path = utils.encodeUri("/groups/$groupId/users", {$groupId: groupId});
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Group users list object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getGroupInvitedUsers = function(groupId) {
    const path = utils.encodeUri("/groups/$groupId/invited_users", {$groupId: groupId});
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Group rooms list object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getGroupRooms = function(groupId) {
    const path = utils.encodeUri("/groups/$groupId/rooms", {$groupId: groupId});
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * @param {string} groupId
 * @param {string} userId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.inviteUserToGroup = function(groupId, userId) {
    const path = utils.encodeUri(
        "/groups/$groupId/admin/users/invite/$userId",
        {$groupId: groupId, $userId: userId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {string} userId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.removeUserFromGroup = function(groupId, userId) {
    const path = utils.encodeUri(
        "/groups/$groupId/admin/users/remove/$userId",
        {$groupId: groupId, $userId: userId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {string} userId
 * @param {string} roleId Optional.
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.addUserToGroupSummary = function(groupId, userId, roleId) {
    const path = utils.encodeUri(
        roleId ?
            "/groups/$groupId/summary/$roleId/users/$userId" :
            "/groups/$groupId/summary/users/$userId",
        {$groupId: groupId, $roleId: roleId, $userId: userId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {string} userId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.removeUserFromGroupSummary = function(groupId, userId) {
    const path = utils.encodeUri(
        "/groups/$groupId/summary/users/$userId",
        {$groupId: groupId, $userId: userId},
    );
    return this._http.authedRequest(undefined, "DELETE", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {string} roomId
 * @param {string} categoryId Optional.
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.addRoomToGroupSummary = function(groupId, roomId, categoryId) {
    const path = utils.encodeUri(
        categoryId ?
            "/groups/$groupId/summary/$categoryId/rooms/$roomId" :
            "/groups/$groupId/summary/rooms/$roomId",
        {$groupId: groupId, $categoryId: categoryId, $roomId: roomId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {string} roomId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.removeRoomFromGroupSummary = function(groupId, roomId) {
    const path = utils.encodeUri(
        "/groups/$groupId/summary/rooms/$roomId",
        {$groupId: groupId, $roomId: roomId},
    );
    return this._http.authedRequest(undefined, "DELETE", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {string} roomId
 * @param {bool} isPublic Whether the room-group association is visible to non-members
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.addRoomToGroup = function(groupId, roomId, isPublic) {
    if (isPublic === undefined) {
        isPublic = true;
    }
    const path = utils.encodeUri(
        "/groups/$groupId/admin/rooms/$roomId",
        {$groupId: groupId, $roomId: roomId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined,
        { "m.visibility": { type: isPublic ? "public" : "private" } },
    );
};

/**
 * Configure the visibility of a room-group association.
 * @param {string} groupId
 * @param {string} roomId
 * @param {bool} isPublic Whether the room-group association is visible to non-members
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.updateGroupRoomVisibility = function(groupId, roomId, isPublic) {
    // NB: The /config API is generic but there's not much point in exposing this yet as synapse
    //     is the only server to implement this. In future we should consider an API that allows
    //     arbitrary configuration, i.e. "config/$configKey".

    const path = utils.encodeUri(
        "/groups/$groupId/admin/rooms/$roomId/config/m.visibility",
        {$groupId: groupId, $roomId: roomId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined,
        { type: isPublic ? "public" : "private" },
    );
};

/**
 * @param {string} groupId
 * @param {string} roomId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.removeRoomFromGroup = function(groupId, roomId) {
    const path = utils.encodeUri(
        "/groups/$groupId/admin/rooms/$roomId",
        {$groupId: groupId, $roomId: roomId},
    );
    return this._http.authedRequest(undefined, "DELETE", path, undefined, {});
};

/**
 * @param {string} groupId
 * @param {Object} opts Additional options to send alongside the acceptance.
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.acceptGroupInvite = function(groupId, opts = null) {
    const path = utils.encodeUri(
        "/groups/$groupId/self/accept_invite",
        {$groupId: groupId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, opts || {});
};

/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.joinGroup = function(groupId) {
    const path = utils.encodeUri(
        "/groups/$groupId/self/join",
        {$groupId: groupId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {});
};

/**
 * @param {string} groupId
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.leaveGroup = function(groupId) {
    const path = utils.encodeUri(
        "/groups/$groupId/self/leave",
        {$groupId: groupId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {});
};

/**
 * @return {module:client.Promise} Resolves: The groups to which the user is joined
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getJoinedGroups = function() {
    const path = utils.encodeUri("/joined_groups");
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * @param {Object} content Request content
 * @param {string} content.localpart The local part of the desired group ID
 * @param {Object} content.profile Group profile object
 * @return {module:client.Promise} Resolves: Object with key group_id: id of the created group
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.createGroup = function(content) {
    const path = utils.encodeUri("/create_group");
    return this._http.authedRequest(
        undefined, "POST", path, undefined, content,
    );
};

/**
 * @param {string[]} userIds List of user IDs
 * @return {module:client.Promise} Resolves: Object as exmaple below
 *
 *     {
 *         "users": {
 *             "@bob:example.com": {
 *                 "+example:example.com"
 *             }
 *         }
 *     }
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getPublicisedGroups = function(userIds) {
    const path = utils.encodeUri("/publicised_groups");
    return this._http.authedRequest(
        undefined, "POST", path, undefined, { user_ids: userIds },
    );
};

/**
 * @param {string} groupId
 * @param {bool} isPublic Whether the user's membership of this group is made public
 * @return {module:client.Promise} Resolves: Empty object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setGroupPublicity = function(groupId, isPublic) {
    const path = utils.encodeUri(
        "/groups/$groupId/self/update_publicity",
        {$groupId: groupId},
    );
    return this._http.authedRequest(undefined, "PUT", path, undefined, {
        publicise: isPublic,
    });
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
    const pathParams = {
        $roomId: roomId,
        $eventType: eventType,
        $stateKey: stateKey,
    };
    let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
    if (stateKey !== undefined) {
        path = utils.encodeUri(path + "/$stateKey", pathParams);
    }
    return this._http.authedRequest(
        callback, "GET", path,
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
    const pathParams = {
        $roomId: roomId,
        $eventType: eventType,
        $stateKey: stateKey,
    };
    let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
    if (stateKey !== undefined) {
        path = utils.encodeUri(path + "/$stateKey", pathParams);
    }
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content,
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
    const path = utils.encodeUri("/rooms/$roomId/redact/$eventId", {
        $roomId: roomId,
        $eventId: eventId,
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
    if (utils.isFunction(limit)) {
        callback = limit; limit = undefined;
    }
    const path = utils.encodeUri("/rooms/$roomId/initialSync",
        {$roomId: roomId},
    );
    if (!limit) {
        limit = 30;
    }
    return this._http.authedRequest(
        callback, "GET", path, { limit: limit },
    );
};

/**
 * Set a marker to indicate the point in a room before which the user has read every
 * event. This can be retrieved from room account data (the event type is `m.fully_read`)
 * and displayed as a horizontal line in the timeline that is visually distinct to the
 * position of the user's own read receipt.
 * @param {string} roomId ID of the room that has been read
 * @param {string} rmEventId ID of the event that has been read
 * @param {string} rrEventId ID of the event tracked by the read receipt. This is here
 * for convenience because the RR and the RM are commonly updated at the same time as
 * each other. Optional.
 * @return {module:client.Promise} Resolves: the empty object, {}.
 */
MatrixBaseApis.prototype.setRoomReadMarkersHttpRequest =
                                function(roomId, rmEventId, rrEventId) {
    const path = utils.encodeUri("/rooms/$roomId/read_markers", {
        $roomId: roomId,
    });

    const content = {
        "m.fully_read": rmEventId,
        "m.read": rrEventId,
    };

    return this._http.authedRequest(
        undefined, "POST", path, undefined, content,
    );
};

/**
 * @return {module:client.Promise} Resolves: A list of the user's current rooms
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getJoinedRooms = function() {
    const path = utils.encodeUri("/joined_rooms");
    return this._http.authedRequest(undefined, "GET", path);
};

/**
 * Retrieve membership info. for a room.
 * @param {string} roomId ID of the room to get membership for
 * @return {module:client.Promise} Resolves: A list of currently joined users
 *                                 and their profile data.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.getJoinedRoomMembers = function(roomId) {
    const path = utils.encodeUri("/rooms/$roomId/joined_members", {
        $roomId: roomId,
    });
    return this._http.authedRequest(undefined, "GET", path);
};

// Room Directory operations
// =========================

/**
 * @param {Object} options Options for this request
 * @param {string} options.server The remote server to query for the room list.
 *                                Optional. If unspecified, get the local home
 *                                server's public room list.
 * @param {number} options.limit Maximum number of entries to return
 * @param {string} options.since Token to paginate from
 * @param {object} options.filter Filter parameters
 * @param {string} options.filter.generic_search_term String to search for
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.publicRooms = function(options, callback) {
    if (typeof(options) == 'function') {
        callback = options;
        options = {};
    }
    if (options === undefined) {
        options = {};
    }

    const query_params = {};
    if (options.server) {
        query_params.server = options.server;
        delete options.server;
    }

    if (Object.keys(options).length === 0 && Object.keys(query_params).length === 0) {
        return this._http.authedRequest(callback, "GET", "/publicRooms");
    } else {
        return this._http.authedRequest(
            callback, "POST", "/publicRooms", query_params, options,
        );
    }
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
    const path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias,
    });
    const data = {
        room_id: roomId,
    };
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data,
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
    const path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias,
    });
    return this._http.authedRequest(
        callback, "DELETE", path, undefined, undefined,
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
    const path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias,
    });
    return this._http.authedRequest(
        callback, "GET", path,
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
    const path = utils.encodeUri("/directory/room/$alias", {$alias: roomAlias});
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
    const path = utils.encodeUri("/directory/list/room/$roomId", {
        $roomId: roomId,
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
    const path = utils.encodeUri("/directory/list/room/$roomId", {
        $roomId: roomId,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, { "visibility": visibility },
    );
};

/**
 * Set the visbility of a room bridged to a 3rd party network in
 * the current HS's room directory.
 * @param {string} networkId the network ID of the 3rd party
 *                 instance under which this room is published under.
 * @param {string} roomId
 * @param {string} visibility "public" to make the room visible
 *                 in the public directory, or "private" to make
 *                 it invisible.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.setRoomDirectoryVisibilityAppService =
                                function(networkId, roomId, visibility, callback) {
    const path = utils.encodeUri("/directory/list/appservice/$networkId/$roomId", {
        $networkId: networkId,
        $roomId: roomId,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, { "visibility": visibility },
    );
};

// User Directory Operations
// =========================

/**
 * Query the user directory with a term matching user IDs, display names and domains.
 * @param {object} opts options
 * @param {string} opts.term the term with which to search.
 * @param {number} opts.limit the maximum number of results to return. The server will
 *                 apply a limit if unspecified.
 * @return {module:client.Promise} Resolves: an array of results.
 */
MatrixBaseApis.prototype.searchUserDirectory = function(opts) {
    const body = {
        search_term: opts.term,
    };

    if (opts.limit !== undefined) {
        body.limit = opts.limit;
    }

    return this._http.authedRequest(
        undefined, "POST", "/user_directory/search", undefined, body,
    );
};


// Media operations
// ================

/**
 * Upload a file to the media repository on the home server.
 *
 * @param {object} file The object to upload. On a browser, something that
 *   can be sent to XMLHttpRequest.send (typically a File).  Under node.js,
 *   a a Buffer, String or ReadStream.
 *
 * @param {object} opts  options object
 *
 * @param {string=} opts.name   Name to give the file on the server. Defaults
 *   to <tt>file.name</tt>.
 *
 * @param {boolean=} opts.includeFilename if false will not send the filename,
 *   e.g for encrypted file uploads where filename leaks are undesirable.
 *   Defaults to true.
 *
 * @param {string=} opts.type   Content-type for the upload. Defaults to
 *   <tt>file.type</tt>, or <tt>applicaton/octet-stream</tt>.
 *
 * @param {boolean=} opts.rawResponse Return the raw body, rather than
 *   parsing the JSON. Defaults to false (except on node.js, where it
 *   defaults to true for backwards compatibility).
 *
 * @param {boolean=} opts.onlyContentUri Just return the content URI,
 *   rather than the whole body. Defaults to false (except on browsers,
 *   where it defaults to true for backwards compatibility). Ignored if
 *   opts.rawResponse is true.
 *
 * @param {Function=} opts.callback Deprecated. Optional. The callback to
 *    invoke on success/failure. See the promise return values for more
 *    information.
 *
 * @param {Function=} opts.progressHandler Optional. Called when a chunk of
 *    data has been uploaded, with an object containing the fields `loaded`
 *    (number of bytes transferred) and `total` (total size, if known).
 *
 * @return {module:client.Promise} Resolves to response object, as
 *    determined by this.opts.onlyData, opts.rawResponse, and
 *    opts.onlyContentUri.  Rejects with an error (usually a MatrixError).
 */
MatrixBaseApis.prototype.uploadContent = function(file, opts) {
    return this._http.uploadContent(file, opts);
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
    if (utils.isFunction(info)) {
        callback = info; info = undefined;
    }

    const path = info ?
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
    const path = "/account/3pid";
    return this._http.authedRequest(
        callback, "GET", path, undefined, undefined,
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
    const path = "/account/3pid";
    const data = {
        'threePidCreds': creds,
        'bind': bind,
    };
    return this._http.authedRequest(
        callback, "POST", path, null, data,
    );
};

/**
 * @param {string} medium The threepid medium (eg. 'email')
 * @param {string} address The threepid address (eg. 'bob@example.com')
 *        this must be as returned by getThreePids.
 * @return {module:client.Promise} Resolves: The server response on success
 *     (generally the empty JSON object)
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.deleteThreePid = function(medium, address) {
    const path = "/account/3pid/delete";
    const data = {
        'medium': medium,
        'address': address,
    };
    return this._http.authedRequestWithPrefix(
        undefined, "POST", path, null, data, httpApi.PREFIX_UNSTABLE,
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
    const path = "/account/password";
    const data = {
        'auth': authDict,
        'new_password': newPassword,
    };

    return this._http.authedRequest(
        callback, "POST", path, null, data,
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
    const path = "/devices";
    return this._http.authedRequestWithPrefix(
        undefined, "GET", path, undefined, undefined,
        httpApi.PREFIX_UNSTABLE,
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
    const path = utils.encodeUri("/devices/$device_id", {
        $device_id: device_id,
    });


    return this._http.authedRequestWithPrefix(
        undefined, "PUT", path, undefined, body,
        httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * Delete the given device
 *
 * @param {string} device_id  device to delete
 * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.deleteDevice = function(device_id, auth) {
    const path = utils.encodeUri("/devices/$device_id", {
        $device_id: device_id,
    });

    const body = {};

    if (auth) {
        body.auth = auth;
    }

    return this._http.authedRequestWithPrefix(
        undefined, "DELETE", path, undefined, body,
        httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * Delete multiple device
 *
 * @param {string[]} devices IDs of the devices to delete
 * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixBaseApis.prototype.deleteMultipleDevices = function(devices, auth) {
    const body = {devices};

    if (auth) {
        body.auth = auth;
    }

    return this._http.authedRequestWithPrefix(
        undefined, "POST", "/delete_devices", undefined, body,
        httpApi.PREFIX_UNSTABLE,
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
    const path = "/pushers";
    return this._http.authedRequest(
        callback, "GET", path, undefined, undefined,
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
    const path = "/pushers/set";
    return this._http.authedRequest(
        callback, "POST", path, null, pusher,
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
    const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
        $kind: kind,
        $ruleId: ruleId,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, body,
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
    const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
        $kind: kind,
        $ruleId: ruleId,
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
    const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/enabled", {
        $kind: kind,
        $ruleId: ruleId,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, {"enabled": enabled},
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
    const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/actions", {
        $kind: kind,
        $ruleId: ruleId,
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, {"actions": actions},
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
    const queryparams = {};
    if (opts.next_batch) {
        queryparams.next_batch = opts.next_batch;
    }
    return this._http.authedRequest(
        callback, "POST", "/search", queryparams, opts.body,
    );
};

// Crypto
// ======

/**
 * Upload keys
 *
 * @param {Object} content  body of upload request
 *
 * @param {Object=} opts
 *
 * @param {string=} opts.device_id  explicit device_id to use for upload
 *    (default is to use the same as that used during auth).
 *
 * @param {module:client.callback=} callback
 *
 * @return {module:client.Promise} Resolves: result object. Rejects: with
 *     an error response ({@link module:http-api.MatrixError}).
 */
MatrixBaseApis.prototype.uploadKeysRequest = function(content, opts, callback) {
    opts = opts || {};
    const deviceId = opts.device_id;
    let path;
    if (deviceId) {
        path = utils.encodeUri("/keys/upload/$deviceId", {
            $deviceId: deviceId,
        });
    } else {
        path = "/keys/upload";
    }
    return this._http.authedRequestWithPrefix(
        callback, "POST", path, undefined, content, httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * Download device keys
 *
 * @param {string[]} userIds  list of users to get keys for
 *
 * @param {Object=} opts
 *
 * @param {string=} opts.token   sync token to pass in the query request, to help
 *   the HS give the most recent results
 *
 * @return {module:client.Promise} Resolves: result object. Rejects: with
 *     an error response ({@link module:http-api.MatrixError}).
 */
MatrixBaseApis.prototype.downloadKeysForUsers = function(userIds, opts) {
    if (utils.isFunction(opts)) {
        // opts used to be 'callback'.
        throw new Error(
            'downloadKeysForUsers no longer accepts a callback parameter',
        );
    }
    opts = opts || {};

    const content = {
        device_keys: {},
    };
    if ('token' in opts) {
        content.token = opts.token;
    }
    userIds.forEach((u) => {
        content.device_keys[u] = {};
    });

    return this._http.authedRequestWithPrefix(
        undefined, "POST", "/keys/query", undefined, content,
        httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * Claim one-time keys
 *
 * @param {string[]} devices  a list of [userId, deviceId] pairs
 *
 * @param {string} [key_algorithm = signed_curve25519]  desired key type
 *
 * @return {module:client.Promise} Resolves: result object. Rejects: with
 *     an error response ({@link module:http-api.MatrixError}).
 */
MatrixBaseApis.prototype.claimOneTimeKeys = function(devices, key_algorithm) {
    const queries = {};

    if (key_algorithm === undefined) {
        key_algorithm = "signed_curve25519";
    }

    for (let i = 0; i < devices.length; ++i) {
        const userId = devices[i][0];
        const deviceId = devices[i][1];
        const query = queries[userId] || {};
        queries[userId] = query;
        query[deviceId] = key_algorithm;
    }
    const content = {one_time_keys: queries};
    return this._http.authedRequestWithPrefix(
        undefined, "POST", "/keys/claim", undefined, content,
        httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * Ask the server for a list of users who have changed their device lists
 * between a pair of sync tokens
 *
 * @param {string} oldToken
 * @param {string} newToken
 *
 * @return {module:client.Promise} Resolves: result object. Rejects: with
 *     an error response ({@link module:http-api.MatrixError}).
 */
MatrixBaseApis.prototype.getKeyChanges = function(oldToken, newToken) {
    const qps = {
        from: oldToken,
        to: newToken,
    };

    return this._http.authedRequestWithPrefix(
        undefined, "GET", "/keys/changes", qps, undefined,
        httpApi.PREFIX_UNSTABLE,
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
    const params = {
        client_secret: clientSecret,
        email: email,
        send_attempt: sendAttempt,
        next_link: nextLink,
    };
    return this._http.idServerRequest(
        callback, "POST", "/validate/email/requestToken",
        params, httpApi.PREFIX_IDENTITY_V1,
    );
};

/**
 * Submits an MSISDN token to the identity server
 *
 * This is used when submitting the code sent by SMS to a phone number.
 * The ID server has an equivalent API for email but the js-sdk does
 * not expose this, since email is normally validated by the user clicking
 * a link rather than entering a code.
 *
 * @param {string} sid The sid given in the response to requestToken
 * @param {string} clientSecret A secret binary string generated by the client.
 *                 This must be the same value submitted in the requestToken call.
 * @param {string} token The token, as enetered by the user.
 *
 * @return {module:client.Promise} Resolves: Object, currently with no parameters.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * @throws Error if No ID server is set
 */
MatrixBaseApis.prototype.submitMsisdnToken = function(sid, clientSecret, token) {
    const params = {
        sid: sid,
        client_secret: clientSecret,
        token: token,
    };
    return this._http.idServerRequest(
        undefined, "POST", "/validate/msisdn/submitToken",
        params, httpApi.PREFIX_IDENTITY_V1,
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
    const params = {
        medium: medium,
        address: address,
    };
    return this._http.idServerRequest(
        callback, "GET", "/lookup",
        params, httpApi.PREFIX_IDENTITY_V1,
    );
};


// Direct-to-device messaging
// ==========================

/**
 * Send an event to a specific list of devices
 *
 * @param {string} eventType  type of event to send
 * @param {Object.<string, Object<string, Object>>} contentMap
 *    content to send. Map from user_id to device_id to content object.
 * @param {string=} txnId     transaction id. One will be made up if not
 *    supplied.
 * @return {module:client.Promise} Resolves to the result object
 */
MatrixBaseApis.prototype.sendToDevice = function(
    eventType, contentMap, txnId,
) {
    const path = utils.encodeUri("/sendToDevice/$eventType/$txnId", {
        $eventType: eventType,
        $txnId: txnId ? txnId : this.makeTxnId(),
    });

    const body = {
        messages: contentMap,
    };

    return this._http.authedRequestWithPrefix(
        undefined, "PUT", path, undefined, body,
        httpApi.PREFIX_UNSTABLE,
    );
};

// Third party Lookup API
// ======================

/**
 * Get the third party protocols that can be reached using
 * this HS
 * @return {module:client.Promise} Resolves to the result object
 */
MatrixBaseApis.prototype.getThirdpartyProtocols = function() {
    return this._http.authedRequestWithPrefix(
        undefined, "GET", "/thirdparty/protocols", undefined, undefined,
        httpApi.PREFIX_UNSTABLE,
    ).then((response) => {
        // sanity check
        if (!response || typeof(response) !== 'object') {
            throw new Error(
                `/thirdparty/protocols did not return an object: ${response}`,
            );
        }
        return response;
    });
};

/**
 * Get information on how a specific place on a third party protocol
 * may be reached.
 * @param {string} protocol The protocol given in getThirdpartyProtocols()
 * @param {object} params Protocol-specific parameters, as given in the
 *                        response to getThirdpartyProtocols()
 * @return {module:client.Promise} Resolves to the result object
 */
MatrixBaseApis.prototype.getThirdpartyLocation = function(protocol, params) {
    const path = utils.encodeUri("/thirdparty/location/$protocol", {
        $protocol: protocol,
    });

    return this._http.authedRequestWithPrefix(
        undefined, "GET", path, params, undefined,
        httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * Get information on how a specific user on a third party protocol
 * may be reached.
 * @param {string} protocol The protocol given in getThirdpartyProtocols()
 * @param {object} params Protocol-specific parameters, as given in the
 *                        response to getThirdpartyProtocols()
 * @return {module:client.Promise} Resolves to the result object
 */
MatrixBaseApis.prototype.getThirdpartyUser = function(protocol, params) {
    const path = utils.encodeUri("/thirdparty/user/$protocol", {
        $protocol: protocol,
    });

    return this._http.authedRequestWithPrefix(
        undefined, "GET", path, params, undefined,
        httpApi.PREFIX_UNSTABLE,
    );
};

/**
 * MatrixBaseApis object
 */
module.exports = MatrixBaseApis;
