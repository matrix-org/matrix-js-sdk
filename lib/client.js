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

var PushProcessor = require('./pushprocessor');

/**
 * This is an internal module. See {@link MatrixClient} for the public class.
 * @module client
 */
var EventEmitter = require("events").EventEmitter;
var q = require("q");

var httpApi = require("./http-api");
var MatrixEvent = require("./models/event").MatrixEvent;
var EventStatus = require("./models/event").EventStatus;
var SearchResult = require("./models/search-result");
var StubStore = require("./store/stub");
var webRtcCall = require("./webrtc/call");
var utils = require("./utils");
var contentRepo = require("./content-repo");
var Filter = require("./filter");
var SyncApi = require("./sync");
var MatrixError = httpApi.MatrixError;

var SCROLLBACK_DELAY_MS = 3000;
var CRYPTO_ENABLED = false;

try {
    var Olm = require("olm");
    if (Olm.Account && Olm.Session) {
        CRYPTO_ENABLED = true;
    }
} catch (e) {
    // Olm not installed.
}

var OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

/**
 * Construct a Matrix Client. Only directly construct this if you want to use
 * custom modules. Normally, {@link createClient} should be used
 * as it specifies 'sensible' defaults for these modules.
 * @constructor
 * @extends {external:EventEmitter}
 *
 * @param {Object} opts The configuration options for this client.
 * @param {string} opts.baseUrl Required. The base URL to the client-server
 * HTTP API.
 * @param {string} opts.idBaseUrl Optional. The base identity server URL for
 * identity server requests.
 * @param {Function} opts.request Required. The function to invoke for HTTP
 * requests. The value of this property is typically <code>require("request")
 * </code> as it returns a function which meets the required interface. See
 * {@link requestFunction} for more information.
 *
 * @param {string} opts.accessToken The access_token for this user.
 * @param {string} opts.userId The user ID for this user.
 * @param {Object} opts.store Optional. The data store to use. If not specified,
 * this client will not store any HTTP responses.
 *
 * @param {Object} opts.scheduler Optional. The scheduler to use. If not
 * specified, this client will not retry requests on failure. This client
 * will supply its own processing function to
 * {@link module:scheduler~MatrixScheduler#setProcessFunction}.
 *
 * @param {Object} opts.queryParams Optional. Extra query parameters to append
 * to all requests with this client. Useful for application services which require
 * <code>?user_id=</code>.
 *
 */
function MatrixClient(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);

    this.baseUrl = opts.baseUrl;
    this.idBaseUrl = opts.idBaseUrl;

    this.store = opts.store || new StubStore();
    this.sessionStore = opts.sessionStore || null;
    this.accountKey = "DEFAULT_KEY";
    this.deviceId = opts.deviceId;
    if (CRYPTO_ENABLED && this.sessionStore !== null) {
        var e2eAccount = this.sessionStore.getEndToEndAccount();
        var account = new Olm.Account();
        try {
            if (e2eAccount === null) {
                account.create();
            } else {
                account.unpickle(this.accountKey, e2eAccount);
            }
            var e2eKeys = JSON.parse(account.identity_keys());
            var json = '{"algorithms":["' + OLM_ALGORITHM + '"]';
            json += ',"device_id":"' + this.deviceId + '"';
            json += ',"keys":';
            json += '{"ed25519:' + this.deviceId + '":';
            json += JSON.stringify(e2eKeys.ed25519);
            json += ',"curve25519:' + this.deviceId + '":';
            json += JSON.stringify(e2eKeys.curve25519);
            json += '}';
            json += ',"user_id":' + JSON.stringify(opts.userId);
            json += '}';
            var signature = account.sign(json);
            this.deviceKeys = JSON.parse(json);
            var signatures = {};
            signatures[opts.userId] = {};
            signatures[opts.userId]["ed25519:" + this.deviceId] = signature;
            this.deviceKeys.signatures = signatures;
            this.deviceCurve25519Key = e2eKeys.curve25519;
            var pickled = account.pickle(this.accountKey);
            this.sessionStore.storeEndToEndAccount(pickled);
            var myDevices = this.sessionStore.getEndToEndDevicesForUser(
                opts.userId
            ) || {};
            myDevices[opts.deviceId] = this.deviceKeys;
            this.sessionStore.storeEndToEndDevicesForUser(
                opts.userId, myDevices
            );
        } finally {
            account.free();
        }
    }
    this.scheduler = opts.scheduler;
    if (this.scheduler) {
        var self = this;
        this.scheduler.setProcessFunction(function(eventToSend) {
            eventToSend.status = EventStatus.SENDING;
            return _sendEventHttpRequest(self, eventToSend);
        });
    }
    this.clientRunning = false;

    var httpOpts = {
        baseUrl: opts.baseUrl,
        idBaseUrl: opts.idBaseUrl,
        accessToken: opts.accessToken,
        request: opts.request,
        prefix: httpApi.PREFIX_V1,
        onlyData: true,
        extraParams: opts.queryParams
    };
    this.credentials = {
        userId: (opts.userId || null)
    };
    this._http = new httpApi.MatrixHttpApi(httpOpts);
    this.callList = {
        // callId: MatrixCall
    };

    // try constructing a MatrixCall to see if we are running in an environment
    // which has WebRTC. If we are, listen for and handle m.call.* events.
    var call = webRtcCall.createNewMatrixCall(this);
    this._supportsVoip = false;
    if (call) {
        setupCallEventHandler(this);
        this._supportsVoip = true;
    }
    this._syncState = null;
    this._syncingRetry = null;
    this._peekSync = null;
    this._isGuest = false;
    this._ongoingScrollbacks = {};
}
utils.inherits(MatrixClient, EventEmitter);

/**
 * Get the Homserver URL of this client
 * @return {string} Homeserver URL of this client
 */
MatrixClient.prototype.getHomeserverUrl = function() {
    return this.baseUrl;
};

/**
 * Get the Identity Server URL of this client
 * @return {string} Identity Server URL of this client
 */
MatrixClient.prototype.getIdentityServerUrl = function() {
    return this.idBaseUrl;
};

/**
 * Get the access token associated with this account.
 * @return {?String} The access_token or null
 */
MatrixClient.prototype.getAccessToken = function() {
    return this._http.opts.accessToken || null;
};

/**
 * Get the local part of the current user ID e.g. "foo" in "@foo:bar".
 * @return {?String} The user ID localpart or null.
 */
MatrixClient.prototype.getUserIdLocalpart = function() {
    if (this.credentials && this.credentials.userId) {
        return this.credentials.userId.split(":")[0].substring(1);
    }
    return null;
};

/**
 * Check if the runtime environment supports VoIP calling.
 * @return {boolean} True if VoIP is supported.
 */
MatrixClient.prototype.supportsVoip = function() {
    return this._supportsVoip;
};

/**
 * Get the current sync state.
 * @return {?string} the sync state, which may be null.
 * @see module:client~MatrixClient#event:"sync"
 */
MatrixClient.prototype.getSyncState = function() {
    return this._syncState;
};

/**
 * Return whether the client is configured for a guest account.
 * @return {boolean} True if this is a guest access_token (or no token is supplied).
 */
MatrixClient.prototype.isGuest = function() {
    return this._isGuest;
};

/**
 * Return the provided scheduler, if any.
 * @return {?module:scheduler~MatrixScheduler} The scheduler or null
 */
MatrixClient.prototype.getScheduler = function() {
    return this.scheduler;
};

/**
 * Set whether this client is a guest account. <b>This method is experimental
 * and may change without warning.</b>
 * @param {boolean} isGuest True if this is a guest account.
 */
MatrixClient.prototype.setGuest = function(isGuest) {
    // EXPERIMENTAL:
    // If the token is a macaroon, it should be encoded in it that it is a 'guest'
    // access token, which means that the SDK can determine this entirely without
    // the dev manually flipping this flag.
    this._isGuest = isGuest;
};

/**
 * Retry a backed off syncing request immediately. This should only be used when
 * the user <b>explicitly</b> attempts to retry their lost connection.
 * @return {boolean} True if this resulted in a request being retried.
 */
MatrixClient.prototype.retryImmediately = function() {
    if (!this._syncingRetry) {
        return false;
    }
    // stop waiting
    clearTimeout(this._syncingRetry.timeoutId);
    // invoke immediately
    this._syncingRetry.fn();
    this._syncingRetry = null;
    return true;
};

/**
 * Is end-to-end crypto enabled for this client.
 * @return {boolean} True if end-to-end is enabled.
 */
MatrixClient.prototype.isCryptoEnabled = function() {
    return CRYPTO_ENABLED && this.sessionStore !== null;
};


/**
 * Upload the device keys to the homeserver and ensure that the
 * homeserver has enough one-time keys.
 * @param {number} maxKeys The maximum number of keys to generate
 * @param {object} deferred A deferred to resolve when the keys are uploaded.
 * @return {object} A promise that will resolve when the keys are uploaded.
 */
MatrixClient.prototype.uploadKeys = function(maxKeys, deferred) {
    if (!CRYPTO_ENABLED || this.sessionStore === null) {
        return q.reject(new Error("End-to-end encryption disabled"));
    }
    var first_time = deferred === undefined;
    deferred = deferred || q.defer();
    var path = "/keys/upload/" + this.deviceId;
    var pickled = this.sessionStore.getEndToEndAccount();
    if (!pickled) {
        return q.reject(new Error("End-to-end account not found"));
    }
    var account = new Olm.Account();
    var oneTimeKeys;
    try {
        account.unpickle(this.accountKey, pickled);
        oneTimeKeys = JSON.parse(account.one_time_keys());
        var maxOneTimeKeys = account.max_number_of_one_time_keys();
    } finally {
        account.free();
    }
    var oneTimeJson = {};

    for (var keyId in oneTimeKeys.curve25519) {
        if (oneTimeKeys.curve25519.hasOwnProperty(keyId)) {
            oneTimeJson["curve25519:" + keyId] = oneTimeKeys.curve25519[keyId];
        }
    }
    var content = {
        device_keys: this.deviceKeys,
        one_time_keys: oneTimeJson
    };
    var self = this;
    this._http.authedRequestWithPrefix(
        undefined, "POST", path, undefined, content, httpApi.PREFIX_V2_ALPHA
    ).then(function(res) {
        var keyLimit = Math.floor(maxOneTimeKeys / 2);
        var keyCount = res.one_time_key_counts.curve25519 || 0;
        var generateKeys = (keyCount < keyLimit);
        var pickled = self.sessionStore.getEndToEndAccount();

        var account = new Olm.Account();
        try {
            account.unpickle(self.accountKey, pickled);
            account.mark_keys_as_published();
            if (generateKeys) {
                var numberToGenerate = keyLimit - keyCount;
                if (maxKeys) {
                    numberToGenerate = Math.min(numberToGenerate, maxKeys);
                }
                account.generate_one_time_keys(numberToGenerate);
            }
            pickled = account.pickle(self.accountKey);
            self.sessionStore.storeEndToEndAccount(pickled);
        } finally {
            account.free();
        }
        if (generateKeys && first_time) {
            self.uploadKeys(maxKeys, deferred);
        } else {
            deferred.resolve();
        }
    });
    return deferred.promise;
};


/**
 * Download the keys for a list of users and stores the keys in the session
 * store.
 * @param {Array} userIds The users to fetch.
 * @param {bool} forceDownload Always download the keys even if cached.
 * @return {object} A promise that will resolve when the keys are downloadded.
 */
MatrixClient.prototype.downloadKeys = function(userIds, forceDownload) {
    if (!CRYPTO_ENABLED || this.sessionStore === null) {
        return q.reject(new Error("End-to-end encryption disabled"));
    }
    var stored = {};
    var notStored = {};
    var downloadKeys = false;
    for (var i = 0; i < userIds.length; ++i) {
        var userId = userIds[i];
        if (!forceDownload) {
            var devices = this.sessionStore.getEndToEndDevicesForUser(userId);
            if (devices) {
                stored[userId] = devices;
                continue;
            }
        }
        downloadKeys = true;
        notStored[userId] = {};
    }
    var deferred = q.defer();
    if (downloadKeys) {
        var path = "/keys/query";
        var content = {device_keys: notStored};
        var self = this;
        this._http.authedRequestWithPrefix(
            undefined, "POST", path, undefined, content,
            httpApi.PREFIX_V2_ALPHA
        ).then(function(res) {
            for (var userId in res.device_keys) {
                if (userId in notStored) {
                    self.sessionStore.storeEndToEndDevicesForUser(
                        userId, res.device_keys[userId]
                    );
                    // TODO: validate the ed25519 signature.
                    stored[userId] = res.device_keys[userId];
                }
            }
            deferred.resolve(stored);
        });
    } else {
        deferred.resolve(stored);
    }
    return deferred.promise;
};

/**
 * List the stored device keys for a user id
 * @param {string} userId the user to list keys for.
 * @return {Array} list of devices with "id" and "key" parameters.
 */
MatrixClient.prototype.listDeviceKeys = function(userId) {
    if (!CRYPTO_ENABLED) {
        return [];
    }
    var devices = this.sessionStore.getEndToEndDevicesForUser(userId);
    var result = [];
    if (devices) {
        var deviceId;
        var deviceIds = [];
        for (deviceId in devices) {
            if (devices.hasOwnProperty(deviceId)) {
                deviceIds.push(deviceId);
            }
        }
        deviceIds.sort();
        for (var i = 0; i < deviceIds.length; ++i) {
            deviceId = deviceIds[i];
            var device = devices[deviceId];
            var ed25519Key = device.keys["ed25519:" + deviceId];
            if (ed25519Key) {
                result.push({
                    id: deviceId,
                    key: ed25519Key
                });
            }
        }
    }
    return result;
};

/**
 * Enable end-to-end encryption for a room.
 * @param {string} roomId The room ID to enable encryption in.
 * @param {object} config The encryption config for the room.
 * @return {Object} A promise that will resolve when encryption is setup.
 */
MatrixClient.prototype.setRoomEncryption = function(roomId, config) {
    if (!this.sessionStore || !CRYPTO_ENABLED) {
        return q.reject(new Error("End-to-End encryption disabled"));
    }
    if (config.algorithm === OLM_ALGORITHM) {
        if (!config.members) {
            throw new Error(
                "Config must include a 'members' list with a list of userIds"
            );
        }
        var devicesWithoutSession = [];
        var userWithoutDevices = [];
        for (var i = 0; i < config.members.length; ++i) {
            var userId = config.members[i];
            var devices = this.sessionStore.getEndToEndDevicesForUser(userId);
            if (!devices) {
                userWithoutDevices.push(userId);
            } else {
                for (var deviceId in devices) {
                    if (devices.hasOwnProperty(deviceId)) {
                        var keys = devices[deviceId];
                        var key = keys.keys["curve25519:" + deviceId];
                        if (key == this.deviceCurve25519Key) {
                            continue;
                        }
                        if (!this.sessionStore.getEndToEndSessions(key)) {
                            devicesWithoutSession.push([userId, deviceId, key]);
                        }
                    }
                }
            }
        }
        var deferred = q.defer();
        if (devicesWithoutSession.length > 0) {
            var queries = {};
            for (i = 0; i < devicesWithoutSession.length; ++i) {
                var device = devicesWithoutSession[i];
                var query = queries[device[0]] || {};
                queries[device[0]] = query;
                query[device[1]] = "curve25519";
            }
            var path = "/keys/claim";
            var content = {one_time_keys: queries};
            var self = this;
            this._http.authedRequestWithPrefix(
                undefined, "POST", path, undefined, content,
                httpApi.PREFIX_V2_ALPHA
            ).done(function(res) {
                var missing = {};
                for (i = 0; i < devicesWithoutSession.length; ++i) {
                    var device = devicesWithoutSession[i];
                    var userRes = res.one_time_keys[device[0]] || {};
                    var deviceRes = userRes[device[1]];
                    var oneTimeKey;
                    for (var keyId in deviceRes) {
                        if (keyId.indexOf("curve25519:") === 0) {
                            oneTimeKey = deviceRes[keyId];
                        }
                    }
                    if (oneTimeKey) {
                        var session = new Olm.Session();
                        var account = new Olm.Account();
                        try {
                            var pickled = self.sessionStore.getEndToEndAccount();
                            account.unpickle(self.accountKey, pickled);
                            session.create_outbound(account, device[2], oneTimeKey);
                            var sessionId = session.session_id();
                            pickled = session.pickle(self.accountKey);
                            self.sessionStore.storeEndToEndSession(
                                device[2], sessionId, pickled
                            );
                        } finally {
                            session.free();
                            account.free();
                        }
                    } else {
                        missing[device[0]] = missing[device[0]] || [];
                        missing[device[0]].push([device[1]]);
                    }
                }
                deferred.resolve({
                    missingUsers: userWithoutDevices,
                    missingDevices: missing
                });
            });
        } else {
            deferred.resolve({
                missingUsers: userWithoutDevices,
                missingDevices: []
            });
        }
        this.sessionStore.storeEndToEndRoom(roomId, config);
        return deferred.promise;
    } else {
        throw new Error("Unknown algorithm: " + config.algorithm);
    }
};


/**
 * Disable encryption for a room.
 * @param {string} roomId the room to disable encryption for.
 */
MatrixClient.prototype.disableRoomEncryption = function(roomId) {
    if (this.sessionStore !== null) {
        this.sessionStore.storeEndToEndRoom(roomId, null);
    }
};

/**
 * Whether encryption is enabled for a room.
 * @param {string} roomId the room id to query.
 * @return {bool} whether encryption is enabled.
 */
MatrixClient.prototype.isRoomEncrypted = function(roomId) {
    if (CRYPTO_ENABLED && this.sessionStore !== null) {
        return (this.sessionStore.getEndToEndRoom(roomId) && true) || false;
    } else {
        return false;
    }
};

/**
 * Get the room for the given room ID.
 * @param {string} roomId The room ID
 * @return {Room} The Room or null if it doesn't exist or there is no data store.
 */
MatrixClient.prototype.getRoom = function(roomId) {
    return this.store.getRoom(roomId);
};

/**
 * Retrieve all known rooms.
 * @return {Room[]} A list of rooms, or an empty list if there is no data store.
 */
MatrixClient.prototype.getRooms = function() {
    return this.store.getRooms();
};

/**
 * Retrieve a user.
 * @param {string} userId The user ID to retrieve.
 * @return {?User} A user or null if there is no data store or the user does
 * not exist.
 */
MatrixClient.prototype.getUser = function(userId) {
    return this.store.getUser(userId);
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
MatrixClient.prototype.createRoom = function(options, callback) {
    // valid options include: room_alias_name, visibility, invite
    return this._http.authedRequest(
        callback, "POST", "/createRoom", undefined, options
    );
};

/**
 * Join a room. If you have already joined the room, this will no-op.
 * @param {string} roomIdOrAlias The room ID or room alias to join.
 * @param {Object} opts Options when joining the room.
 * @param {boolean} opts.syncRoom True to do a room initial sync on the resulting
 * room. If false, the <strong>returned Room object will have no current state.
 * </strong> Default: true.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Room object.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.joinRoom = function(roomIdOrAlias, opts, callback) {
    // to help people when upgrading..
    if (utils.isFunction(opts)) {
        throw new Error("Expected 'opts' object, got function.");
    }
    opts = opts || {
        syncRoom: true
    };

    var room = this.getRoom(roomIdOrAlias);
    if (room && room.hasMembershipState(this.credentials.userId, "join")) {
        return q(room);
    }
    var path = utils.encodeUri("/join/$roomid", { $roomid: roomIdOrAlias});
    var defer = q.defer();
    var self = this;
    this._http.authedRequest(undefined, "POST", path, undefined, {}).then(
    function(res) {
        var roomId = res.room_id;
        var syncApi = new SyncApi(self);
        var room = syncApi.createRoom(roomId);
        if (opts.syncRoom) {
            // v2 will do this for us
            // return syncApi.syncRoom(room);
        }
        return q(room);
    }, function(err) {
        _reject(callback, defer, err);
    }).done(function(room) {
        _resolve(callback, defer, room);
    }, function(err) {
        _reject(callback, defer, err);
    });
    return defer.promise;
};

/**
 * Resend an event.
 * @param {MatrixEvent} event The event to resend.
 * @param {Room} room Optional. The room the event is in. Will update the
 * timeline entry if provided.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.resendEvent = function(event, room) {
    event.status = EventStatus.SENDING;
    return _sendEvent(this, room, event);
};

/**
 * @param {string} roomId
 * @param {string} name
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomName = function(roomId, name, callback) {
    return this.sendStateEvent(roomId, "m.room.name", {name: name},
                               undefined, callback);
};

/**
 * @param {string} roomId
 * @param {string} topic
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomTopic = function(roomId, topic, callback) {
    return this.sendStateEvent(roomId, "m.room.topic", {topic: topic},
                               undefined, callback);
};

/**
 * @param {string} roomId
 * @param {string} tagName name of room tag to be set
 * @param {object} metadata associated with that tag to be stored
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomTag = function(roomId, tagName, metadata, callback) {
    var path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/$tag", {
        $userId: this.credentials.userId,
        $roomId: roomId,
        $tag: tagName,
    });
    return this._http.authedRequestWithPrefix(
        callback, "PUT", path, undefined, metadata, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * @param {string} roomId
 * @param {string} tagName name of room tag to be removed
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.deleteRoomTag = function(roomId, tagName, callback) {
    var path = utils.encodeUri("/user/$userId/rooms/$roomId/tags/$tag", {
        $userId: this.credentials.userId,
        $roomId: roomId,
        $tag: tagName,
    });
    return this._http.authedRequestWithPrefix(
        callback, "DELETE", path, undefined, undefined, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * Set a user's power level.
 * @param {string} roomId
 * @param {string} userId
 * @param {Number} powerLevel
 * @param {MatrixEvent} event
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setPowerLevel = function(roomId, userId, powerLevel,
                                                event, callback) {
    var content = {
        users: {}
    };
    if (event && event.getType() === "m.room.power_levels") {
        // take a copy of the content to ensure we don't corrupt
        // existing client state with a failed power level change
        content = utils.deepCopy(event.getContent());
    }
    content.users[userId] = powerLevel;
    var path = utils.encodeUri("/rooms/$roomId/state/m.room.power_levels", {
        $roomId: roomId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content
    );
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
MatrixClient.prototype.getStateEvent = function(roomId, eventType, stateKey, callback) {
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
MatrixClient.prototype.sendStateEvent = function(roomId, eventType, content, stateKey, 
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
 * @param {string} eventType
 * @param {Object} content
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendEvent = function(roomId, eventType, content, txnId,
                                            callback) {
    if (utils.isFunction(txnId)) { callback = txnId; txnId = undefined; }

    if (!txnId) {
        txnId = "m" + new Date().getTime();
    }

    // we always construct a MatrixEvent when sending because the store and
    // scheduler use them. We'll extract the params back out if it turns out
    // the client has no scheduler or store.
    var room = this.getRoom(roomId);
    var localEvent = new MatrixEvent({
        event_id: "~" + roomId + ":" + txnId,
        user_id: this.credentials.userId,
        room_id: roomId,
        type: eventType,
        origin_server_ts: new Date().getTime(),
        content: content
    });
    localEvent._txnId = txnId;

    // add this event immediately to the local store as 'sending'.
    if (room) {
        localEvent.status = EventStatus.SENDING;
        room.addEventsToTimeline([localEvent]);
    }

    if (eventType === "m.room.message" && this.sessionStore && CRYPTO_ENABLED) {
        var e2eRoomInfo = this.sessionStore.getEndToEndRoom(roomId);
        if (e2eRoomInfo) {
            var encryptedContent = _encryptMessage(
                this, roomId, e2eRoomInfo, eventType, content, txnId, callback
            );
            localEvent.encryptedType = "m.room.encrypted";
            localEvent.encryptedContent = encryptedContent;
        }
        // TODO: Specify this in the event constructor rather than fiddling
        // with the event object internals.
        localEvent.encrypted = true;
    }

    return _sendEvent(this, room, localEvent, callback);
};

function _encryptMessage(client, roomId, e2eRoomInfo, eventType, content,
                               txnId, callback) {
    if (!client.sessionStore) {
        throw new Error(
            "Client must have an end-to-end session store to encrypt messages"
        );
    }

    if (e2eRoomInfo.algorithm === OLM_ALGORITHM) {
        var participantKeys = [];
        for (var i = 0; i < e2eRoomInfo.members.length; ++i) {
            var userId = e2eRoomInfo.members[i];
            var devices = client.sessionStore.getEndToEndDevicesForUser(userId);
            for (var deviceId in devices) {
                if (devices.hasOwnProperty(deviceId)) {
                    var keys = devices[deviceId];
                    for (var keyId in keys.keys) {
                        if (keyId.indexOf("curve25519:") === 0) {
                            participantKeys.push(keys.keys[keyId]);
                        }
                    }
                }
            }
        }
        participantKeys.sort();
        var participantHash = ""; // Olm.sha256(participantKeys.join());
        var payloadJson = {
            room_id: roomId,
            type: eventType,
            fingerprint: participantHash,
            sender_device: client.deviceId,
            content: content
        };
        var ciphertext = {};
        var payloadString = JSON.stringify(payloadJson);
        for (i = 0; i < participantKeys.length; ++i) {
            var deviceKey = participantKeys[i];
            if (deviceKey == client.deviceCurve25519Key) {
                continue;
            }
            var sessions = client.sessionStore.getEndToEndSessions(
                deviceKey
            );
            var sessionIds = [];
            for (var sessionId in sessions) {
                if (sessions.hasOwnProperty(sessionId)) {
                    sessionIds.push(sessionId);
                }
            }
            // Use the session with the lowest ID.
            sessionIds.sort();
            if (sessionIds.length === 0) {
                // If we don't have a session for a device then
                // we can't encrypt a message for it.
                continue;
            }
            sessionId = sessionIds[0];
            var session = new Olm.Session();
            try {
                session.unpickle(client.accountKey, sessions[sessionId]);
                ciphertext[deviceKey] = session.encrypt(payloadString);
                var pickled = session.pickle(client.accountKey);
                client.sessionStore.storeEndToEndSession(
                    deviceKey, sessionId, pickled
                );
            } finally {
                session.free();
            }
        }
        var encryptedContent = {
            algorithm: e2eRoomInfo.algorithm,
            sender_key: client.deviceCurve25519Key,
            ciphertext: ciphertext
        };
        return encryptedContent;
    } else {
        throw new Error("Unknown end-to-end algorithm: " + e2eRoomInfo.algorithm);
    }
}

function _decryptMessage(client, event) {
    if (client.sessionStore === null || !CRYPTO_ENABLED) {
        // End to end encryption isn't enabled if we don't have a session
        // store.
        return _badEncryptedMessage(event, "**Encryption not enabled**");
    }

    var content = event.getContent();
    if (content.algorithm === OLM_ALGORITHM) {
        var deviceKey = content.sender_key;
        var ciphertext = content.ciphertext;

        if (!ciphertext) {
            return _badEncryptedMessage(event, "**Missing ciphertext**");
        }
        if (!(client.deviceCurve25519Key in content.ciphertext)) {
            return _badEncryptedMessage(event, "**Not included in recipients**");
        }
        var message = content.ciphertext[client.deviceCurve25519Key];
        var sessions = client.sessionStore.getEndToEndSessions(deviceKey);
        var payloadString = null;
        var foundSession = false;
        var session;
        for (var sessionId in sessions) {
            if (sessions.hasOwnProperty(sessionId)) {
                session = new Olm.Session();
                try {
                    session.unpickle(client.accountKey, sessions[sessionId]);
                    if (message.type === 0 && session.matches_inbound(message.body)) {
                        foundSession = true;
                    }
                    payloadString = session.decrypt(message.type, message.body);
                    var pickled = session.pickle(client.accountKey);
                    client.sessionStore.storeEndToEndSession(
                        deviceKey, sessionId, pickled
                    );
                } catch (e) {
                    // Failed to decrypt with an existing session.
                    console.log(
                        "Failed to decrypt with an existing session: " + e.message
                    );
                } finally {
                    session.free();
                }
            }
        }

        if (message.type === 0 && !foundSession && payloadString === null) {
            var account = new Olm.Account();
            session = new Olm.Session();
            try {
                var account_data = client.sessionStore.getEndToEndAccount();
                account.unpickle(client.accountKey, account_data);
                session.create_inbound_from(account, deviceKey, message.body);
                payloadString = session.decrypt(message.type, message.body);
                account.remove_one_time_keys(session);
                var pickledSession = session.pickle(client.accountKey);
                var pickledAccount = account.pickle(client.accountKey);
                sessionId = session.session_id();
                client.sessionStore.storeEndToEndSession(
                    deviceKey, sessionId, pickledSession
                );
                client.sessionStore.storeEndToEndAccount(pickledAccount);
            } catch (e) {
                // Failed to decrypt with a new session.
            } finally {
                session.free();
                account.free();
            }
        }

        if (payloadString !== null) {
            var payload = JSON.parse(payloadString);
            return new MatrixEvent({
                // TODO: Add a key to indicate that the event was encrypted.
                // TODO: Check the sender user id matches the sender key.
                origin_server_ts: event.getTs(),
                room_id: payload.room_id,
                user_id: event.getSender(),
                event_id: event.getId(),
                type: payload.type,
                content: payload.content
            }, "encrypted");
        } else {
            return _badEncryptedMessage(event, "**Bad Encrypted Message**");
        }
    }
}

function _badEncryptedMessage(event, reason) {
    return new MatrixEvent({
        type: "m.room.message",
        // TODO: Add rest of the event keys.
        origin_server_ts: event.getTs(),
        room_id: event.getRoomId(),
        user_id: event.getSender(),
        event_id: event.getId(),
        content: {
            msgtype: "m.bad.encrypted",
            body: reason,
            content: event.getContent()
        }
    });
}

function _sendEvent(client, room, event, callback) {
    // cache the local event ID here because if /sync returns before /send then
    // event.getId() will return a REAL event ID which we will then incorrectly
    // remove!
    var localEventId = event.getId();

    var defer = q.defer();
    var promise;
    // this event may be queued
    if (client.scheduler) {
        // if this returns a promsie then the scheduler has control now and will
        // resolve/reject when it is done. Internally, the scheduler will invoke
        // processFn which is set to this._sendEventHttpRequest so the same code
        // path is executed regardless.
        promise = client.scheduler.queueEvent(event);
        if (promise && client.scheduler.getQueueForEvent(event).length > 1) {
            // event is processed FIFO so if the length is 2 or more we know
            // this event is stuck behind an earlier event.
            event.status = EventStatus.QUEUED;
        }
    }

    if (!promise) {
        promise = _sendEventHttpRequest(client, event);
    }

    promise.done(function(res) {  // the request was sent OK
        if (room) {
            var eventId = res.event_id;
            // try to find an event with this event_id. If we find it, this is
            // the echo of this event *from the event stream* so we can remove
            // the fake event we made above. If we don't find it, we're still
            // waiting on the real event and so should assign the fake event
            // with the real event_id for matching later.

            // FIXME: This manipulation of the room should probably be done
            // inside the room class, not by the client.
            var matchingEvent = utils.findElement(room.timeline, function(ev) {
                return ev.getId() === eventId;
            }, true);
            if (matchingEvent) {
                if (event.encryptedType) {
                    // Replace the content and type of the event with the
                    // plaintext that we sent to the server.
                    // TODO: Persist the changes if we storing events somewhere
                    // otherthan in memory.
                    matchingEvent.event.content = event.event.content;
                    matchingEvent.event.type = event.event.type;
                }
                room.removeEvents([localEventId]);
                matchingEvent.status = null; // make sure it's still marked as sent
            }
            else {
                room.removeEvents([localEventId]);
                event.event.event_id = res.event_id;
                event.status = null;
                room.addEventsToTimeline([event]);
            }
        }

        _resolve(callback, defer, res);
    }, function(err) {
        // the request failed to send.
        event.status = EventStatus.NOT_SENT;
        _reject(callback, defer, err);
    });

    return defer.promise;
}

function _sendEventHttpRequest(client, event) {
    var pathParams = {
        $roomId: event.getRoomId(),
        $eventType: event.getWireType(),
        $stateKey: event.getStateKey(),
        $txnId: event._txnId ? event._txnId : new Date().getTime()
    };

    var path;

    if (event.isState()) {
        var pathTemplate = "/rooms/$roomId/state/$eventType";
        if (event.getStateKey() && event.getStateKey().length > 0) {
            pathTemplate = "/rooms/$roomId/state/$eventType/$stateKey";
        }
        path = utils.encodeUri(pathTemplate, pathParams);
    }
    else {
        path = utils.encodeUri(
            "/rooms/$roomId/send/$eventType/$txnId", pathParams
        );
    }

    return client._http.authedRequest(
        undefined, "PUT", path, undefined, event.getWireContent()
    );
}

/**
 * @param {string} roomId
 * @param {Object} content
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendMessage = function(roomId, content, txnId, callback) {
    if (utils.isFunction(txnId)) { callback = txnId; txnId = undefined; }
    return this.sendEvent(
        roomId, "m.room.message", content, txnId, callback
    );
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTextMessage = function(roomId, body, txnId, callback) {
    var content = {
         msgtype: "m.text",
         body: body
    };
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendNotice = function(roomId, body, txnId, callback) {
    var content = {
         msgtype: "m.notice",
         body: body
    };
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendEmoteMessage = function(roomId, body, txnId, callback) {
    var content = {
         msgtype: "m.emote",
         body: body
    };
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} url
 * @param {Object} info
 * @param {string} text
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendImageMessage = function(roomId, url, info, text, callback) {
    if (utils.isFunction(text)) { callback = text; text = undefined; }
    if (!text) { text = "Image"; }
    var content = {
         msgtype: "m.image",
         url: url,
         info: info,
         body: text
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlMessage = function(roomId, body, htmlBody, callback) {
    var content = {
        msgtype: "m.text",
        format: "org.matrix.custom.html",
        body: body,
        formatted_body: htmlBody
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlNotice = function(roomId, body, htmlBody, callback) {
    var content = {
        msgtype: "m.notice",
        format: "org.matrix.custom.html",
        body: body,
        formatted_body: htmlBody
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlEmote = function(roomId, body, htmlBody, callback) {
    var content = {
        msgtype: "m.emote",
        format: "org.matrix.custom.html",
        body: body,
        formatted_body: htmlBody
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * Send a receipt.
 * @param {Event} event The event being acknowledged
 * @param {string} receiptType The kind of receipt e.g. "m.read"
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendReceipt = function(event, receiptType, callback) {
    if (this.isGuest()) {
        return q({}); // guests cannot send receipts so don't bother.
    }

    var path = utils.encodeUri("/rooms/$roomId/receipt/$receiptType/$eventId", {
        $roomId: event.getRoomId(),
        $receiptType: receiptType,
        $eventId: event.getId()
    });
    return this._http.authedRequestWithPrefix(
        callback, "POST", path, undefined, {}, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * Send a read receipt.
 * @param {Event} event The event that has been read.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendReadReceipt = function(event, callback) {
    return this.sendReceipt(event, "m.read", callback);
};


/**
 * Upload a file to the media repository on the home server.
 * @param {File} file object
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.uploadContent = function(file, callback) {
    return this._http.uploadContent(file, callback);
};

/**
 * Cancel a file upload in progress
 * @param {module:client.Promise} promise The promise returned from uploadContent
 * @return {boolean} true if canceled, otherwise false
 */
MatrixClient.prototype.cancelUpload = function(promise) {
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
MatrixClient.prototype.getCurrentUploads = function() {
    return this._http.getCurrentUploads();
};

/**
 * @param {string} roomId
 * @param {boolean} isTyping
 * @param {Number} timeoutMs
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTyping = function(roomId, isTyping, timeoutMs, callback) {
    if (this.isGuest()) {
        return q({}); // guests cannot send typing notifications so don't bother.
    }

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
};

/**
 * Create an alias to room ID mapping.
 * @param {string} alias The room alias to create.
 * @param {string} roomId The room ID to link the alias to.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.createAlias = function(alias, roomId, callback) {
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
 * Get room info for the given alias.
 * @param {string} alias The room alias to resolve.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Object with room_id and servers.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getRoomIdForAlias = function(alias, callback) {
    var path = utils.encodeUri("/directory/room/$alias", {
        $alias: alias
    });
    return this._http.authedRequest(
        callback, "GET", path
    );
};

/**
 * @param {string} roomId
 * @param {string} eventId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.redactEvent = function(roomId, eventId, callback) {
    var path = utils.encodeUri("/rooms/$roomId/redact/$eventId", {
        $roomId: roomId,
        $eventId: eventId
    });
    return this._http.authedRequest(callback, "POST", path, undefined, {});
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.invite = function(roomId, userId, callback) {
    return _membershipChange(this, roomId, userId, "invite", undefined,
        callback);
};

/**
 * Invite a user to a room based on their email address.
 * @param {string} roomId The room to invite the user to.
 * @param {string} email The email address to invite.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.inviteByEmail = function(roomId, email, callback) {
    return this.inviteByThreePid(
        roomId, "email", email, callback
    );
};

/**
 * Invite a user to a room based on a third-party identifier.
 * @param {string} roomId The room to invite the user to.
 * @param {string} medium The medium to invite the user e.g. "email".
 * @param {string} address The address for the specified medium.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.inviteByThreePid = function(roomId, medium, address, callback) {
    var path = utils.encodeUri(
        "/rooms/$roomId/invite",
        { $roomId: roomId }
    );

    var identityServerUrl = this.getIdentityServerUrl();
    if (!identityServerUrl) {
        return q.reject(new MatrixError({
            error: "No supplied identity server URL",
            errcode: "ORG.MATRIX.JSSDK_MISSING_PARAM"
        }));
    }
    if (identityServerUrl.indexOf("http://") === 0 ||
            identityServerUrl.indexOf("https://") === 0) {
        // this request must not have the protocol part because reasons
        identityServerUrl = identityServerUrl.split("://")[1];
    }

    return this._http.authedRequest(callback, "POST", path, undefined, {
        id_server: identityServerUrl,
        medium: medium,
        address: address
    });
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.leave = function(roomId, callback) {
    return _membershipChange(this, roomId, undefined, "leave", undefined,
        callback);
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.ban = function(roomId, userId, reason, callback) {
    return _membershipChange(this, roomId, userId, "ban", reason,
        callback);
};

/**
 * @param {string} roomId
 * @param {boolean} deleteRoom True to delete the room from the store on success.
 * Default: true.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.forget = function(roomId, deleteRoom, callback) {
    if (deleteRoom === undefined) {
        deleteRoom = true;
    }
    var promise = _membershipChange(this, roomId, undefined, "forget", undefined,
        callback);
    if (!deleteRoom) {
        return promise;
    }
    var self = this;
    return promise.then(function(response) {
        self.store.removeRoom(roomId);
        self.emit("deleteRoom", roomId);
        return response;
    });
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.unban = function(roomId, userId, callback) {
    // unbanning = set their state to leave
    return _setMembershipState(
        this, roomId, userId, "leave", undefined, callback
    );
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.kick = function(roomId, userId, reason, callback) {
    return _setMembershipState(
        this, roomId, userId, "leave", reason, callback
    );
};

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {string} roomId
 * @param {string} userId
 * @param {string} membershipValue
 * @param {string} reason
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
function _setMembershipState(client, roomId, userId, membershipValue, reason, 
                             callback) {
    if (utils.isFunction(reason)) { callback = reason; reason = undefined; }

    var path = utils.encodeUri(
        "/rooms/$roomId/state/m.room.member/$userId",
        { $roomId: roomId, $userId: userId}
    );

    return client._http.authedRequest(callback, "PUT", path, undefined, {
        membership: membershipValue,
        reason: reason
    });
}

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {string} roomId
 * @param {string} userId
 * @param {string} membership
 * @param {string} reason
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
function _membershipChange(client, roomId, userId, membership, reason, callback) {
    if (utils.isFunction(reason)) { callback = reason; reason = undefined; }

    var path = utils.encodeUri("/rooms/$room_id/$membership", {
        $room_id: roomId,
        $membership: membership
    });
    return client._http.authedRequest(
        callback, "POST", path, undefined, {
            user_id: userId,  // may be undefined e.g. on leave
            reason: reason
        }
    );
}

/**
 * Obtain a dict of actions which should be performed for this event according
 * to the push rules for this user.
 * @param {MatrixEvent} event The event to get push actions for.
 * @return {module:pushprocessor~PushAction} A dict of actions to perform.
 */
MatrixClient.prototype.getPushActionsForEvent = function(event) {
    if (event._pushActions === undefined) {
        var pushProcessor = new PushProcessor(this);
        event._pushActions = pushProcessor.actionsForEvent(event.event);
    }
    return event._pushActions;
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
MatrixClient.prototype.getProfileInfo = function(userId, info, callback) {
    if (utils.isFunction(info)) { callback = info; info = undefined; }

    var path = info ?
    utils.encodeUri("/profile/$userId/$info",
             { $userId: userId, $info: info }) :
    utils.encodeUri("/profile/$userId",
             { $userId: userId });
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * @param {string} info The kind of info to set (e.g. 'avatar_url')
 * @param {Object} data The JSON object to set.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setProfileInfo = function(info, data, callback) {
    var path = utils.encodeUri("/profile/$userId/$info", {
        $userId: this.credentials.userId,
        $info: info
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data
    );
};

/**
 * @param {string} name
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setDisplayName = function(name, callback) {
    return this.setProfileInfo(
        "displayname", { displayname: name }, callback
    );
};

/**
 * @param {string} url
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setAvatarUrl = function(url, callback) {
    return this.setProfileInfo(
        "avatar_url", { avatar_url: url }, callback
    );
};

/**
 * Turn an MXC URL into an HTTP one. <strong>This method is experimental and
 * may change.</strong>
 * @param {string} mxcUrl The MXC URL
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {Boolean} allowDirectLinks If true, return any non-mxc URLs
 * directly. Fetching such URLs will leak information about the user to
 * anyone they share a room with. If false, will return null for such URLs.
 * @return {?string} the avatar URL or null.
 */
MatrixClient.prototype.mxcUrlToHttp =
        function(mxcUrl, width, height, resizeMethod, allowDirectLinks) {
    return contentRepo.getHttpUriForMxc(
        this.baseUrl, mxcUrl, width, height, resizeMethod, allowDirectLinks
    );
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getThreePids = function(callback) {
    var path = "/account/3pid";
    return this._http.authedRequestWithPrefix(
        callback, "GET", path, undefined, undefined, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * @param {Object} creds
 * @param {boolean} bind
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.addThreePid = function(creds, bind, callback) {
    var path = "/account/3pid";
    var data = {
        'threePidCreds': creds,
        'bind': bind
    };
    return this._http.authedRequestWithPrefix(
        callback, "POST", path, null, data, httpApi.PREFIX_V2_ALPHA
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
MatrixClient.prototype.setPassword = function(authDict, newPassword, callback) {
    var path = "/account/password";
    var data = {
        'auth': authDict,
        'new_password': newPassword
    };

    return this._http.authedRequestWithPrefix(
        callback, "POST", path, null, data, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * @param {string} presence
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * @throws If 'presence' isn't a valid presence enum value.
 */
MatrixClient.prototype.setPresence = function(presence, callback) {
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
};

// Public (non-authed) operations
// ==============================

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.publicRooms = function(callback) {
    return this._http.request(callback, "GET", "/publicRooms");
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.loginFlows = function(callback) {
    return this._http.request(callback, "GET", "/login");
};

/**
 * @param {string} roomAlias
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.resolveRoomAlias = function(roomAlias, callback) {
    var path = utils.encodeUri("/directory/room/$alias", {$alias: roomAlias});
    return this._http.request(callback, "GET", path);
};

/**
 * @param {string} roomId
 * @param {Number} limit
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.roomInitialSync = function(roomId, limit, callback) {
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

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.roomState = function(roomId, callback) {
    var path = utils.encodeUri("/rooms/$roomId/state", {$roomId: roomId});
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * Retrieve older messages from the given room and put them in the timeline.
 *
 * If this is called multiple times whilst a request is ongoing, the <i>same</i>
 * Promise will be returned. If there was a problem requesting scrollback, there
 * will be a small delay before another request can be made (to prevent tight-looping
 * when there is no connection).
 *
 * @param {Room} room The room to get older messages in.
 * @param {Integer} limit Optional. The maximum number of previous events to
 * pull in. Default: 30.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: Room. If you are at the beginning
 * of the timeline, <code>Room.oldState.paginationToken</code> will be
 * <code>null</code>.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.scrollback = function(room, limit, callback) {
    if (utils.isFunction(limit)) { callback = limit; limit = undefined; }
    limit = limit || 30;
    var timeToWaitMs = 0;

    var info = this._ongoingScrollbacks[room.roomId] || {};
    if (info.promise) {
        return info.promise;
    }
    else if (info.errorTs) {
        var timeWaitedMs = Date.now() - info.errorTs;
        timeToWaitMs = Math.max(SCROLLBACK_DELAY_MS - timeWaitedMs, 0);
    }

    if (room.oldState.paginationToken === null) {
        return q(room); // already at the start.
    }
    // attempt to grab more events from the store first
    var numAdded = this.store.scrollback(room, limit).length;
    if (numAdded === limit) {
        // store contained everything we needed.
        return q(room);
    }
    // reduce the required number of events appropriately
    limit = limit - numAdded;

    var path = utils.encodeUri(
        "/rooms/$roomId/messages", {$roomId: room.roomId}
    );
    var params = {
        from: room.oldState.paginationToken,
        limit: limit,
        dir: 'b'
    };
    var defer = q.defer();
    info = {
        promise: defer.promise,
        errorTs: null
    };
    var self = this;
    // wait for a time before doing this request
    // (which may be 0 in order not to special case the code paths)
    q.delay(timeToWaitMs).then(function() {
        return self._http.authedRequest(callback, "GET", path, params);
    }).done(function(res) {
        var matrixEvents = utils.map(res.chunk, _PojoToMatrixEventMapper(self));
        room.addEventsToTimeline(matrixEvents, true);
        room.oldState.paginationToken = res.end;
        if (res.chunk.length === 0) {
            room.oldState.paginationToken = null;
        }
        self.store.storeEvents(room, matrixEvents, res.end, true);
        self._ongoingScrollbacks[room.roomId] = null;
        _resolve(callback, defer, room);
    }, function(err) {
        self._ongoingScrollbacks[room.roomId] = {
            errorTs: Date.now()
        };
        _reject(callback, defer, err);
    });
    this._ongoingScrollbacks[room.roomId] = info;
    return defer.promise;
};

/**
 * Take an EventContext, and back/forward-fill results.
 *
 * @param {module:models/event-context.EventContext} eventContext  context
 *    object to be updated
 * @param {Object}  opts
 * @param {boolean} opts.backwards  true to fill backwards, false to go forwards
 * @param {boolean} opts.limit      number of events to request
 *
 * @return {module:client.Promise} Resolves: updated EventContext object
 * @return {Error} Rejects: with an error response.
 */
MatrixClient.prototype.paginateEventContext = function(eventContext, opts) {
    // TODO: we should implement a backoff (as per scrollback()) to deal more
    // nicely with HTTP errors.
    opts = opts || {};
    var backwards = opts.backwards || false;

    var token = eventContext.getPaginateToken(backwards);
    if (!token) {
        // no more results.
        return q.reject(new Error("No paginate token"));
    }

    var dir = backwards ? 'b' : 'f';
    var pendingRequest = eventContext._paginateRequests[dir];

    if (pendingRequest) {
        // already a request in progress - return the existing promise
        return pendingRequest;
    }

    var path = utils.encodeUri(
        "/rooms/$roomId/messages", {$roomId: eventContext.getEvent().getRoomId()}
    );
    var params = {
        from: token,
        limit: ('limit' in opts) ? opts.limit : 30,
        dir: dir
    };

    var self = this;
    var promise =
        self._http.authedRequest(undefined, "GET", path, params
    ).then(function(res) {
        var token = res.end;
        if (res.chunk.length === 0) {
            token = null;
        } else {
            var matrixEvents = utils.map(res.chunk, self.getEventMapper());
            if (backwards) {
                // eventContext expects the events in timeline order, but
                // back-pagination returns them in reverse order.
                matrixEvents.reverse();
            }
            eventContext.addEvents(matrixEvents, backwards);
        }
        eventContext.setPaginateToken(token, backwards);
        return eventContext;
    }).finally(function() {
        eventContext._paginateRequests[dir] = null;
    });
    eventContext._paginateRequests[dir] = promise;

    return promise;
};

// Registration/Login operations
// =============================

/**
 * @param {string} loginType
 * @param {Object} data
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.login = function(loginType, data, callback) {
    data.type = loginType;
    return this._http.authedRequest(
        callback, "POST", "/login", undefined, data
    );
};

/**
 * Register a guest account.
 * @param {Object=} opts Registration options
 * @param {Object} opts.body JSON HTTP body to provide.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.registerGuest = function(opts, callback) {
    opts = opts || {};
    opts.body = opts.body || {};

    return this._http.requestWithPrefix(
        callback, "POST", "/register", {
            kind: "guest"
        },
        opts.body, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * Peek into a room and receive updates about the room. This only works if the
 * history visibility for the room is world_readable.
 * @param {String} roomId The room to attempt to peek into.
 * @return {module:client.Promise} Resolves: Room object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.peekInRoom = function(roomId) {
    if (this._peekSync) {
        this._peekSync.stopPeeking();
    }
    this._peekSync = new SyncApi(this);
    return this._peekSync.peek(roomId);
};

/**
 * Set r/w flags for guest access in a room.
 * @param {string} roomId The room to configure guest access in.
 * @param {Object} opts Options
 * @param {boolean} opts.allowJoin True to allow guests to join this room. This
 * implicitly gives guests write access. If false or not given, guests are
 * explicitly forbidden from joining the room.
 * @param {boolean} opts.allowRead True to set history visibility to
 * be world_readable. This gives guests read access *from this point forward*.
 * If false or not given, history visibility is not modified.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setGuestAccess = function(roomId, opts) {
    var writePromise = this.sendStateEvent(roomId, "m.room.guest_access", {
        guest_access: opts.allowJoin ? "can_join" : "forbidden"
    });

    var readPromise = q();
    if (opts.allowRead) {
        readPromise = this.sendStateEvent(roomId, "m.room.history_visibility", {
            history_visibility: "world_readable"
        });
    }

    return q.all(readPromise, writePromise);
};

/**
 * @param {string} username
 * @param {string} password
 * @param {string} sessionId
 * @param {Object} auth
 * @param {boolean} bindEmail
 * @param {string} guestAccessToken
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.register = function(username, password,
                                           sessionId, auth, bindEmail, guestAccessToken,
                                           callback) {
    if (auth === undefined) { auth = {}; }
    if (sessionId) { auth.session = sessionId; }

    var params = {
        auth: auth
    };
    if (username !== undefined) { params.username = username; }
    if (password !== undefined) { params.password = password; }
    if (bindEmail !== undefined) { params.bind_email = bindEmail; }
    if (guestAccessToken !== undefined) { params.guest_access_token = guestAccessToken; }

    return this._http.requestWithPrefix(
        callback, "POST", "/register", undefined,
        params, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * @param {string} user
 * @param {string} password
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.loginWithPassword = function(user, password, callback) {
    return this.login("m.login.password", {
        user: user,
        password: password
    }, callback);
};

/**
 * @param {string} relayState URL Callback after SAML2 Authentication
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.loginWithSAML2 = function(relayState, callback) {
    return this.login("m.login.saml2", {
        relay_state: relayState
    }, callback);
};

/**
 * @param {string} redirectUrl The URL to redirect to after the HS
 * authenticates with CAS.
 * @return {string} The HS URL to hit to begin the CAS login process.
 */
MatrixClient.prototype.getCasLoginUrl = function(redirectUrl) {
    return this._http.getUrl("/login/cas/redirect", {
        "redirectUrl": redirectUrl
    }, httpApi.PREFIX_V1);
};

/**
 * @param {string} token Login token previously received from homeserver
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.loginWithToken = function(token, callback) {
    return this.login("m.login.token", {
        token: token
    }, callback);
};

// Push operations
// ===============

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getPushRules = function(callback) {
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
MatrixClient.prototype.addPushRule = function(scope, kind, ruleId, body, callback) {
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
MatrixClient.prototype.deletePushRule = function(scope, kind, ruleId, callback) {
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
MatrixClient.prototype.setPushRuleEnabled = function(scope, kind,
                                                     ruleId, enabled, callback) {
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/enabled", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, enabled ? 'true' : 'false'
    );
};

/**
 * Perform a server-side search for messages containing the given text.
 * @param {Object} opts Options for the search.
 * @param {string} opts.query The text to query.
 * @param {string=} opts.keys The keys to search on. Defaults to all keys. One
 * of "content.body", "content.name", "content.topic".
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.searchMessageText = function(opts, callback) {
    return this.search({
        body: {
            search_categories: {
                room_events: {
                    keys: opts.keys,
                    search_term: opts.query
                }
            }
        }
    }, callback);
};

/**
 * Perform a server-side search for room events.
 *
 * The returned promise resolves to an object containing the fields:
 *
 *  * {number}  count:       estimate of the number of results
 *  * {string}  next_batch:  token for back-pagination; if undefined, there are
 *                           no more results
 *  * {Array}   highlights:  a list of words to highlight from the stemming
 *                           algorithm
 *  * {Array}   results:     a list of results
 *
 * Each entry in the results list is a {module:models/search-result.SearchResult}.
 *
 * @param {Object} opts
 * @param {string} opts.term     the term to search for
 * @param {Object} opts.filter   a JSON filter object to pass in the request
 * @return {module:client.Promise} Resolves: result object
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.searchRoomEvents = function(opts) {
    // TODO: support groups

    var body = {
        search_categories: {
            room_events: {
                search_term: opts.term,
                filter: opts.filter,
                order_by: "recent",
                event_context: {
                    before_limit: 1,
                    after_limit: 1,
                    include_profile: true,
                }
            }
        }
    };

    var searchResults = {
        _query: body,
        results: [],
        highlights: [],
    };

    return this.search({body: body}).then(
        this._processRoomEventsSearch.bind(this, searchResults)
    );
};

/**
 * Take a result from an earlier searchRoomEvents call, and backfill results.
 *
 * @param  {object} searchResults  the results object to be updated
 * @return {module:client.Promise} Resolves: updated result object
 * @return {Error} Rejects: with an error response.
 */
MatrixClient.prototype.backPaginateRoomEventsSearch = function(searchResults) {
    // TODO: we should implement a backoff (as per scrollback()) to deal more
    // nicely with HTTP errors.

    if (!searchResults.next_batch) {
        return q.reject(new Error("Cannot backpaginate event search any further"));
    }

    if (searchResults.pendingRequest) {
        // already a request in progress - return the existing promise
        return searchResults.pendingRequest;
    }

    var searchOpts = {
        body: searchResults._query,
        next_batch: searchResults.next_batch,
    };

    var promise = this.search(searchOpts).then(
        this._processRoomEventsSearch.bind(this, searchResults)
    ).finally(function() {
        searchResults.pendingRequest = null;
    });
    searchResults.pendingRequest = promise;

    return promise;
};

/**
 * helper for searchRoomEvents and backPaginateRoomEventsSearch. Processes the
 * response from the API call and updates the searchResults
 *
 * @param {Object} searchResults
 * @param {Object} response
 * @return {Object} searchResults
 * @private
 */
MatrixClient.prototype._processRoomEventsSearch = function(searchResults, response) {
    var room_events = response.search_categories.room_events;

    searchResults.count = room_events.count;
    searchResults.next_batch = room_events.next_batch;

    // combine the highlight list with our existing list; build an object
    // to avoid O(N^2) fail
    var highlights = {};
    room_events.highlights.forEach(function(hl) { highlights[hl] = 1; });
    searchResults.highlights.forEach(function(hl) { highlights[hl] = 1; });

    // turn it back into a list.
    searchResults.highlights = Object.keys(highlights);

    // append the new results to our existing results
    for (var i = 0; i < room_events.results.length; i++) {
        var sr = SearchResult.fromJson(room_events.results[i], this.getEventMapper());
        searchResults.results.push(sr);
    }
    return searchResults;
};

/**
 * Perform a server-side search.
 * @param {Object} opts
 * @param {string} opts.next_batch the batch token to pass in the query string
 * @param {Object} opts.body the JSON object to pass to the request body.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.search = function(opts, callback) {
    var queryparams = {};
    if (opts.next_batch) {
        queryparams.next_batch = opts.next_batch;
    }
    return this._http.authedRequest(
        callback, "POST", "/search", queryparams, opts.body
    );
};


/**
 * Populate the store with rooms the user has left.
 * @return {module:client.Promise} Resolves: TODO - Resolved when the rooms have
 * been added to the data store.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.syncLeftRooms = function() {
    // Guard against multiple calls whilst ongoing and multiple calls post success
    if (this._syncedLeftRooms) {
        return q([]); // don't call syncRooms again if it succeeded.
    }
    if (this._syncLeftRoomsPromise) {
        return this._syncLeftRoomsPromise; // return the ongoing request
    }
    var self = this;
    var syncApi = new SyncApi(this);
    this._syncLeftRoomsPromise = syncApi.syncLeftRooms();

    // cleanup locks
    this._syncLeftRoomsPromise.then(function(res) {
        console.log("Marking success of sync left room request");
        self._syncedLeftRooms = true; // flip the bit on success
    }).finally(function() {
        self._syncLeftRoomsPromise = null; // cleanup ongoing request state
    });

    return this._syncLeftRoomsPromise;
};


/**
 * Create a new filter.
 * @param {Object} content The HTTP body for the request
 * @return {Filter} Resolves to a Filter object.
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.createFilter = function(content) {
    var self = this;
    var path = utils.encodeUri("/user/$userId/filter", {
        $userId: this.credentials.userId
    });
    return this._http.authedRequestWithPrefix(
        undefined, "POST", path, undefined, content, httpApi.PREFIX_V2_ALPHA
    ).then(function(response) {
        // persist the filter
        var filter = Filter.fromJson(
            self.credentials.userId, response.filter_id, content
        );
        self.store.storeFilter(filter);
        return filter;
    });
};

/**
 * Retrieve a filter.
 * @param {string} userId The user ID of the filter owner
 * @param {string} filterId The filter ID to retrieve
 * @param {boolean} allowCached True to allow cached filters to be returned.
 * Default: True.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getFilter = function(userId, filterId, allowCached) {
    if (allowCached) {
        var filter = this.store.getFilter(userId, filterId);
        if (filter) {
            return q(filter);
        }
    }

    var self = this;
    var path = utils.encodeUri("/user/$userId/filter/$filterId", {
        $userId: userId,
        $filterId: filterId
    });

    return this._http.authedRequestWithPrefix(
        undefined, "GET", path, undefined, undefined, httpApi.PREFIX_V2_ALPHA
    ).then(function(response) {
        // persist the filter
        var filter = Filter.fromJson(
            userId, filterId, response
        );
        self.store.storeFilter(filter);
        return filter;
    });
};


// VoIP operations
// ===============

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.turnServer = function(callback) {
    return this._http.authedRequest(callback, "GET", "/voip/turnServer");
};

/**
 * Get the TURN servers for this home server.
 * @return {Array<Object>} The servers or an empty list.
 */
MatrixClient.prototype.getTurnServers = function() {
    return this._turnServers || [];
};

/**
 * @return {boolean} true if there is a valid access_token for this client.
 */
MatrixClient.prototype.isLoggedIn = function() {
    return this._http.opts.accessToken !== undefined;
};


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
 * and then start polling the eventStream for new events. To listen for these
 * events, add a listener for {@link module:client~MatrixClient#event:"event"}
 * via {@link module:client~MatrixClient#on}.
 * @param {Object=} opts Options to apply when syncing.
 * @param {Number=} opts.initialSyncLimit The event <code>limit=</code> to apply
 * to initial sync. Default: 8.
 * @param {Boolean=} opts.includeArchivedRooms True to put <code>archived=true</code>
 * on the <code>/initialSync</code> request. Default: false.
 * @param {Boolean=} opts.resolveInvitesToProfiles True to do /profile requests
 * on every invite event if the displayname/avatar_url is not known for this user ID.
 * Default: false.
 * @param {String=} opts.pendingEventOrdering Controls where pending messages appear
 * in a room's timeline. If "<b>chronological</b>", messages will appear in the timeline
 * when the call to <code>sendEvent</code> was made. If "<b>end</b>", pending messages
 * will always appear at the end of the timeline (multiple pending messages will be sorted
 * chronologically). Default: "chronological".
 * @param {Number=} opts.pollTimeout The number of milliseconds to wait on /events.
 * Default: 30000 (30 seconds).
 */
MatrixClient.prototype.startClient = function(opts) {
    if (this.clientRunning) {
        // client is already running.
        return;
    }
    this.clientRunning = true;
    // backwards compat for when 'opts' was 'historyLen'.
    if (typeof opts === "number") {
        opts = {
            initialSyncLimit: opts
        };
    }

    if (CRYPTO_ENABLED && this.sessionStore !== null) {
        this.uploadKeys(5);
    }

    // periodically poll for turn servers if we support voip
    checkTurnServers(this);

    var syncApi = new SyncApi(this, opts);
    syncApi.sync();
};

/**
 * High level helper method to stop the client from polling and allow a
 * clean shutdown.
 */
MatrixClient.prototype.stopClient = function() {
    this.clientRunning = false;
    // TODO: f.e. Room => self.store.storeRoom(room) ?
    // TODO: Actually stop the SyncApi
};

function setupCallEventHandler(client) {
    var candidatesByCall = {
        // callId: [Candidate]
    };

    // Maintain a buffer of events before the client has synced for the first time.
    // This buffer will be inspected to see if we should send incoming call
    // notifications. It needs to be buffered to correctly determine if an
    // incoming call has had a matching answer/hangup.
    var callEventBuffer = [];
    var isClientPrepared = false;
    client.on("sync", function(state) {
        if (state === "PREPARED") {
            isClientPrepared = true;
            var ignoreCallIds = {}; // Set<String>
            // inspect the buffer and mark all calls which have been answered
            // or hung up before passing them to the call event handler.
            for (var i = callEventBuffer.length - 1; i >= 0; i--) {
                var ev = callEventBuffer[i];
                if (ev.getType() === "m.call.answer" ||
                        ev.getType() === "m.call.hangup") {
                    ignoreCallIds[ev.getContent().call_id] = "yep";
                }
            }
            // now loop through the buffer chronologically and inject them
            callEventBuffer.forEach(function(e) {
                if (ignoreCallIds[e.getContent().call_id]) {
                    return;
                }
                callEventHandler(e);
            });
            callEventBuffer = [];
        }
    });

    client.on("event", function(event) {
        if (!isClientPrepared) {
            if (event.getType().indexOf("m.call.") === 0) {
                callEventBuffer.push(event);
            }
            return;
        }
        callEventHandler(event);
    });

    function callEventHandler(event) {
        if (event.getType().indexOf("m.call.") !== 0) {
            return; // not a call event
        }
        var content = event.getContent();
        var call = content.call_id ? client.callList[content.call_id] : undefined;
        var i;
        //console.log("RECV %s content=%s", event.getType(), JSON.stringify(content));

        if (event.getType() === "m.call.invite") {
            if (event.getSender() === client.credentials.userId) {
                return; // ignore invites you send
            }

            if (event.getAge() > content.lifetime) {
                return; // expired call
            }

            if (call && call.state === "ended") {
                return; // stale/old invite event
            }
            if (call) {
                console.log(
                    "WARN: Already have a MatrixCall with id %s but got an " +
                    "invite. Clobbering.",
                    content.call_id
                );
            }

            call = webRtcCall.createNewMatrixCall(client, event.getRoomId());
            if (!call) {
                console.log(
                    "Incoming call ID " + content.call_id + " but this client " +
                    "doesn't support WebRTC"
                );
                // don't hang up the call: there could be other clients
                // connected that do support WebRTC and declining the
                // the call on their behalf would be really annoying.
                return;
            }

            call.callId = content.call_id;
            call._initWithInvite(event);
            client.callList[call.callId] = call;

            // if we stashed candidate events for that call ID, play them back now
            if (candidatesByCall[call.callId]) {
                for (i = 0; i < candidatesByCall[call.callId].length; i++) {
                    call._gotRemoteIceCandidate(
                        candidatesByCall[call.callId][i]
                    );
                }
            }

            // Were we trying to call that user (room)?
            var existingCall;
            var existingCalls = utils.values(client.callList);
            for (i = 0; i < existingCalls.length; ++i) {
                var thisCall = existingCalls[i];
                if (call.room_id === thisCall.room_id &&
                        thisCall.direction === 'outbound' &&
                        (["wait_local_media", "create_offer", "invite_sent"].indexOf(
                            thisCall.state) !== -1)) {
                    existingCall = thisCall;
                    break;
                }
            }

            if (existingCall) {
                // If we've only got to wait_local_media or create_offer and
                // we've got an invite, pick the incoming call because we know
                // we haven't sent our invite yet otherwise, pick whichever
                // call has the lowest call ID (by string comparison)
                if (existingCall.state === 'wait_local_media' ||
                        existingCall.state === 'create_offer' ||
                        existingCall.callId > call.callId) {
                    console.log(
                        "Glare detected: answering incoming call " + call.callId +
                        " and canceling outgoing call " + existingCall.callId
                    );
                    existingCall._replacedBy(call);
                    call.answer();
                }
                else {
                    console.log(
                        "Glare detected: rejecting incoming call " + call.callId +
                        " and keeping outgoing call " + existingCall.callId
                    );
                    call.hangup();
                }
            }
            else {
                client.emit("Call.incoming", call);
            }
        }
        else if (event.getType() === 'm.call.answer') {
            if (!call) {
                return;
            }
            if (event.getSender() === client.credentials.userId) {
                if (call.state === 'ringing') {
                    call._onAnsweredElsewhere(content);
                }
            }
            else {
                call._receivedAnswer(content);
            }
        }
        else if (event.getType() === 'm.call.candidates') {
            if (event.getSender() === client.credentials.userId) {
                return;
            }
            if (!call) {
                // store the candidates; we may get a call eventually.
                if (!candidatesByCall[content.call_id]) {
                    candidatesByCall[content.call_id] = [];
                }
                candidatesByCall[content.call_id] = candidatesByCall[
                    content.call_id
                ].concat(content.candidates);
            }
            else {
                for (i = 0; i < content.candidates.length; i++) {
                    call._gotRemoteIceCandidate(content.candidates[i]);
                }
            }
        }
        else if (event.getType() === 'm.call.hangup') {
            // Note that we also observe our own hangups here so we can see
            // if we've already rejected a call that would otherwise be valid
            if (!call) {
                // if not live, store the fact that the call has ended because
                // we're probably getting events backwards so
                // the hangup will come before the invite
                call = webRtcCall.createNewMatrixCall(client, event.getRoomId());
                if (call) {
                    call.callId = content.call_id;
                    call._initWithHangup(event);
                    client.callList[content.call_id] = call;
                }
            }
            else {
                if (call.state !== 'ended') {
                    call._onHangupReceived(content);
                    delete client.callList[content.call_id];
                }
            }
        }
    }
}

function checkTurnServers(client) {
    if (!client._supportsVoip) {
        return;
    }
    if (client.isGuest()) {
        return; // guests can't access TURN servers
    }

    client.turnServer().done(function(res) {
        if (res.uris) {
            console.log("Got TURN URIs: " + res.uris + " refresh in " +
                res.ttl + " secs");
            // map the response to a format that can be fed to
            // RTCPeerConnection
            var servers = {
                urls: res.uris,
                username: res.username,
                credential: res.password
            };
            client._turnServers = [servers];
            // re-fetch when we're about to reach the TTL
            setTimeout(function() { checkTurnServers(client); },
                (res.ttl || (60 * 60)) * 1000 * 0.9
            );
        }
    }, function(err) {
        console.error("Failed to get TURN URIs");
        setTimeout(function() { checkTurnServers(client); }, 60000);
    });
}

function _reject(callback, defer, err) {
    if (callback) {
        callback(err);
    }
    defer.reject(err);
}

function _resolve(callback, defer, res) {
    if (callback) {
        callback(null, res);
    }
    defer.resolve(res);
}

function _PojoToMatrixEventMapper(client) {
    function mapper(plainOldJsObject) {
        var event = new MatrixEvent(plainOldJsObject);
        if (event.getType() === "m.room.encrypted") {
            return _decryptMessage(client, event);
        } else {
            return event;
        }
    }
    return mapper;
}

/**
 * @return {Function}
 */
MatrixClient.prototype.getEventMapper = function() {
    return _PojoToMatrixEventMapper(this);
};

// Identity Server Operations
// ==========================

/**
 * @param {string} email
 * @param {string} clientSecret
 * @param {string} sendAttempt
 * @param {string} nextLink Optional
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.requestEmailToken = function(email, clientSecret,
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
 * Generates a random string suitable for use as a client secret. <strong>This
 * method is experimental and may change.</strong>
 * @return {string} A new client secret
 */
MatrixClient.prototype.generateClientSecret = function() {
    var ret = "";
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (var i = 0; i < 32; i++) {
        ret += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return ret;
};

/** */
module.exports.MatrixClient = MatrixClient;
/** */
module.exports.CRYPTO_ENABLED = CRYPTO_ENABLED;

// MatrixClient Event JSDocs

/**
 * Fires whenever the SDK receives a new event.
 * @event module:client~MatrixClient#"event"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @example
 * matrixClient.on("event", function(event){
 *   var sender = event.getSender();
 * });
 */

/**
 * Fires whenever the SDK's syncing state is updated. The state can be one of:
 * <ul>
 * <li>PREPARED : The client has synced with the server at least once and is
 * ready for methods to be called on it. This will be immediately followed by
 * a state of SYNCING. <i>This is the equivalent of "syncComplete" in the
 * previous API.</i></li>
 * <li>SYNCING : The client is currently polling for new events from the server.
 * This will be called <i>after</i> processing latest events from a sync.</li>
 * <li>ERROR : The client has had a problem syncing with the server. If this is
 * called <i>before</i> PREPARED then there was a problem performing the initial
 * sync. If this is called <i>after</i> PREPARED then there was a problem polling
 * the server for updates. This may be called multiple times even if the state is
 * already ERROR. <i>This is the equivalent of "syncError" in the previous
 * API.</i></li>
 * </ul>
 * State transition diagram:
 * <pre>
 *              +----->PREPARED -------> SYNCING <--+
 *              |        ^                  |       |
 *   null ------+        |  +---------------+       |
 *              |        |  V                       |
 *              +------->ERROR ---------------------+
 *
 * NB: 'null' will never be emitted by this event.
 * </pre>
 * Transitions:
 * <ul>
 * <li><code>null -> PREPARED</code> : Occurs when the initial sync is completed
 * first time. This involves setting up filters and obtaining push rules.
 * <li><code>null -> ERROR</code> : Occurs when the initial sync failed first time.
 * <li><code>ERROR -> PREPARED</code> : Occurs when the initial sync succeeds
 * after previously failing.
 * <li><code>PREPARED -> SYNCING</code> : Occurs immediately after transitioning
 * to PREPARED. Starts listening for live updates rather than catching up.
 * <li><code>SYNCING -> ERROR</code> : Occurs the first time a client cannot perform a
 * live update.
 * <li><code>ERROR -> SYNCING</code> : Occurs when the client has performed a
 * live update after having previously failed.
 * <li><code>ERROR -> ERROR</code> : Occurs when the client has failed to sync
 * for a second time or more.</li>
 * <li><code>SYNCING -> SYNCING</code> : Occurs when the client has performed a live
 * update. This is called <i>after</i> processing.</li>
 * </ul>
 *
 * @event module:client~MatrixClient#"sync"
 * @param {string} state An enum representing the syncing state. One of "PREPARED",
 * "SYNCING", "ERROR".
 * @param {?string} prevState An enum representing the previous syncing state.
 * One of "PREPARED", "SYNCING", "ERROR" <b>or null</b>.
 * @param {?Object} data Data about this transition.
 * @param {MatrixError} data.err The matrix error if <code>state=ERROR</code>.
 * @example
 * matrixClient.on("sync", function(state, prevState, data) {
 *   switch (state) {
 *     case "ERROR":
 *       // update UI to say "Connection Lost"
 *       break;
 *     case "SYNCING":
 *       // update UI to remove any "Connection Lost" message
 *       break;
 *     case "PREPARED":
 *       // the client instance is ready to be queried.
 *       var rooms = matrixClient.getRooms();
 *       break;
 *   }
 * });
 */

 /**
 * Fires whenever a new Room is added. This will fire when you are invited to a
 * room, as well as when you join a room. <strong>This event is experimental and
 * may change.</strong>
 * @event module:client~MatrixClient#"Room"
 * @param {Room} room The newly created, fully populated room.
 * @example
 * matrixClient.on("Room", function(room){
 *   var roomId = room.roomId;
 * });
 */

 /**
 * Fires whenever a Room is removed. This will fire when you forget a room.
 * <strong>This event is experimental and may change.</strong>
 * @event module:client~MatrixClient#"deleteRoom"
 * @param {string} roomId The deleted room ID.
 * @example
 * matrixClient.on("deleteRoom", function(roomId){
 *   // update UI from getRooms()
 * });
 */

/**
 * Fires whenever an incoming call arrives.
 * @event module:client~MatrixClient#"Call.incoming"
 * @param {module:webrtc/call~MatrixCall} call The incoming call.
 * @example
 * matrixClient.on("Call.incoming", function(call){
 *   call.answer(); // auto-answer
 * });
 */

// EventEmitter JSDocs

/**
 * The {@link https://nodejs.org/api/events.html|EventEmitter} class.
 * @external EventEmitter
 * @see {@link https://nodejs.org/api/events.html}
 */

/**
 * Adds a listener to the end of the listeners array for the specified event.
 * No checks are made to see if the listener has already been added. Multiple
 * calls passing the same combination of event and listener will result in the
 * listener being added multiple times.
 * @function external:EventEmitter#on
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Alias for {@link external:EventEmitter#on}.
 * @function external:EventEmitter#addListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Adds a <b>one time</b> listener for the event. This listener is invoked only
 * the next time the event is fired, after which it is removed.
 * @function external:EventEmitter#once
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Remove a listener from the listener array for the specified event.
 * <b>Caution:</b> changes array indices in the listener array behind the
 * listener.
 * @function external:EventEmitter#removeListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Removes all listeners, or those of the specified event. It's not a good idea
 * to remove listeners that were added elsewhere in the code, especially when
 * it's on an emitter that you didn't create (e.g. sockets or file streams).
 * @function external:EventEmitter#removeAllListeners
 * @param {string} event Optional. The event to remove listeners for.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Execute each of the listeners in order with the supplied arguments.
 * @function external:EventEmitter#emit
 * @param {string} event The event to emit.
 * @param {Function} listener The function to invoke.
 * @return {boolean} true if event had listeners, false otherwise.
 */

/**
 * By default EventEmitters will print a warning if more than 10 listeners are
 * added for a particular event. This is a useful default which helps finding
 * memory leaks. Obviously not all Emitters should be limited to 10. This
 * function allows that to be increased. Set to zero for unlimited.
 * @function external:EventEmitter#setMaxListeners
 * @param {Number} n The max number of listeners.
 * @return {EventEmitter} for call chaining.
 */

// MatrixClient Callback JSDocs

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
