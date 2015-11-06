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
var StubStore = require("./store/stub");
var Room = require("./models/room");
var User = require("./models/user");
var webRtcCall = require("./webrtc/call");
var utils = require("./utils");
var contentRepo = require("./content-repo");

var CRYPTO_ENABLED = false;

try {
    var Olm = require("olm");
    if (Olm.Account && Olm.Session) {
        CRYPTO_ENABLED = true;
    }
} catch (e) {
    // Olm not installed.
}

// TODO:
// Internal: rate limiting

var OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

/**
 * Construct a Matrix Client. Only directly construct this if you want to use
 * custom modules. Normally, {@link createClient} should be used
 * as it specifies 'sensible' defaults for these modules.
 * @constructor
 * @extends {external:EventEmitter}
 * @param {Object} opts The configuration options for this client.
 * @param {string} opts.baseUrl Required. The base URL to the client-server
 * HTTP API.
 * @param {string} opts.idBaseUrl Optional. The base identity server URL for
 * identity server requests.
 * @param {Function} opts.request Required. The function to invoke for HTTP
 * requests. The value of this property is typically <code>require("request")
 * </code> as it returns a function which meets the required interface. See
 * {@link requestFunction} for more information.
 * @param {string} opts.accessToken The access_token for this user.
 * @param {string} opts.userId The user ID for this user.
 * @param {Object} opts.store Optional. The data store to use. If not specified,
 * this client will not store any HTTP responses.
 * @param {Object} opts.scheduler Optional. The scheduler to use. If not
 * specified, this client will not retry requests on failure. This client
 * will supply its own processing function to
 * @param {Object} opts.queryParams Optional. Extra query parameters to append
 * to all requests with this client. Useful for application services which require
 * <code>?user_id=</code>.
 * {@link module:scheduler~MatrixScheduler#setProcessFunction}.
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
    this._syncingRooms = {
        // room_id: Promise
    };
    this.callList = {
        // callId: MatrixCall
    };
    this._config = {}; // see startClient()

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
        var room = createNewRoom(self, roomId);
        if (opts.syncRoom) {
            return _syncRoom(self, room);
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
                room.removeEvents([event.getId()]);
            }
            else {
                room.removeEvents([event.getId()]);
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
 * Send a receipt.
 * @param {Event} event The event being acknowledged
 * @param {string} receiptType The kind of receipt e.g. "m.read"
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendReceipt = function(event, receiptType, callback) {
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
 * @param {string} roomId
 * @param {boolean} isTyping
 * @param {Number} timeoutMs
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTyping = function(roomId, isTyping, timeoutMs, callback) {
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
 * @return {?string} the avatar URL or null.
 */
MatrixClient.prototype.mxcUrlToHttp =
        function(mxcUrl, width, height, resizeMethod) {
    return contentRepo.getHttpUriForMxc(
        this.baseUrl, mxcUrl, width, height, resizeMethod
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
    var self = this;
    this._http.authedRequest(callback, "GET", path, params).done(function(res) {
        var matrixEvents = utils.map(res.chunk, _PojoToMatrixEventMapper(self));
        room.addEventsToTimeline(matrixEvents, true);
        room.oldState.paginationToken = res.end;
        if (res.chunk.length === 0) {
            room.oldState.paginationToken = null;
        }
        self.store.storeEvents(room, matrixEvents, res.end, true);
        _resolve(callback, defer, room);
    }, function(err) {
        _reject(callback, defer, err);
    });
    return defer.promise;
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
 * @param {string} username
 * @param {string} password
 * @param {string} sessionId
 * @param {Object} auth
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.register = function(username, password,
                                           sessionId, auth, callback) {
    if (auth === undefined) { auth = {}; }
    if (sessionId) { auth.session = sessionId; }

    var params = {
        auth: auth
    };
    if (username !== undefined) { params.username = username; }
    if (password !== undefined) { params.password = password; }

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
MatrixClient.prototype.pushRules = function(callback) {
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
 * Perform a server-side search.
 * @param {Object} opts
 * @param {Object} opts.body the JSON object to pass to the request body.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.search = function(opts, callback) {
    return this._http.authedRequest(
        callback, "POST", "/search", undefined, opts.body
    );
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
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {integer} historyLen
 * @param {integer} includeArchived
 * @param {integer} attempt
 */
function doInitialSync(client, historyLen, includeArchived, attempt) {
    attempt = attempt || 1;
    var qps = { limit: historyLen };
    if (includeArchived) {
        qps.archived = true;
    }
    client._http.authedRequest(
        undefined, "GET", "/initialSync", qps
    ).done(function(data) {
        var i, j;
        // intercept the results and put them into our store
        if (!(client.store instanceof StubStore)) {
            utils.forEach(
                utils.map(data.presence, _PojoToMatrixEventMapper(client)),
            function(e) {
                var user = createNewUser(client, e.getContent().user_id);
                user.setPresenceEvent(e);
                client.store.storeUser(user);
            });

            // group receipts by room ID.
            var receiptsByRoom = {};
            data.receipts = data.receipts || [];
            utils.forEach(data.receipts.map(_PojoToMatrixEventMapper(client)),
                function(receiptEvent) {
                    if (!receiptsByRoom[receiptEvent.getRoomId()]) {
                        receiptsByRoom[receiptEvent.getRoomId()] = [];
                    }
                    receiptsByRoom[receiptEvent.getRoomId()].push(receiptEvent);
                }
            );

            for (i = 0; i < data.rooms.length; i++) {
                var room = createNewRoom(client, data.rooms[i].room_id);
                if (!data.rooms[i].state) {
                    data.rooms[i].state = [];
                }
                if (data.rooms[i].membership === "invite") {
                    var inviteEvent = data.rooms[i].invite;
                    if (!inviteEvent) {
                        // fallback for servers which don't serve the invite key yet
                        inviteEvent = {
                            event_id: "$fake_" + room.roomId,
                            content: {
                                membership: "invite"
                            },
                            state_key: client.credentials.userId,
                            user_id: data.rooms[i].inviter,
                            room_id: room.roomId,
                            type: "m.room.member"
                        };
                    }
                    data.rooms[i].state.push(inviteEvent);
                }

                _processRoomEvents(
                    client, room, data.rooms[i].state, data.rooms[i].messages
                );

                var receipts = receiptsByRoom[room.roomId] || [];
                for (j = 0; j < receipts.length; j++) {
                    room.addReceipt(receipts[j]);
                }

                // cache the name/summary/etc prior to storage since we don't
                // know how the store will serialise the Room.
                room.recalculate(client.credentials.userId);

                client.store.storeRoom(room);
                client.emit("Room", room);
            }
        }

        if (data) {
            client.store.setSyncToken(data.end);
            var events = [];
            for (i = 0; i < data.presence.length; i++) {
                events.push(new MatrixEvent(data.presence[i]));
            }
            for (i = 0; i < data.rooms.length; i++) {
                if (data.rooms[i].state) {
                    for (j = 0; j < data.rooms[i].state.length; j++) {
                        events.push(new MatrixEvent(data.rooms[i].state[j]));
                    }
                }
                if (data.rooms[i].messages) {
                    for (j = 0; j < data.rooms[i].messages.chunk.length; j++) {
                        events.push(
                            new MatrixEvent(data.rooms[i].messages.chunk[j])
                        );
                    }
                }
            }
            utils.forEach(events, function(e) {
                client.emit("event", e);
            });
        }

        client.clientRunning = true;
        updateSyncState(client, "PREPARED");
        // assume success until we fail which may be 30+ secs
        updateSyncState(client, "SYNCING");
        _pollForEvents(client);
    }, function(err) {
        console.error("/initialSync error (%s attempts): %s", attempt, err);
        attempt += 1;
        startSyncingRetryTimer(client, attempt, function() {
            doInitialSync(client, historyLen, includeArchived, attempt);
        });
        updateSyncState(client, "ERROR", { error: err });
    });
}

/**
 * High level helper method to call initialSync, emit the resulting events,
 * and then start polling the eventStream for new events. To listen for these
 * events, add a listener for {@link module:client~MatrixClient#event:"event"}
 * via {@link module:client~MatrixClient#on}.
 * @param {Object} opts Options to apply when syncing.
 * @param {Number} opts.initialSyncLimit The event <code>limit=</code> to apply
 * to initial sync. Default: 8.
 * @param {Boolean} opts.includeArchivedRooms True to put <code>archived=true</code>
 * on the <code>/initialSync</code> request. Default: false.
 * @param {Boolean} opts.resolveInvitesToProfiles True to do /profile requests
 * on every invite event if the displayname/avatar_url is not known for this user ID.
 * Default: false.
 * @param {Number} opts.pollTimeout The number of milliseconds to wait on /events.
 * Default: 30000 (30 seconds).
 */
MatrixClient.prototype.startClient = function(opts) {
    if (this.clientRunning) {
        // client is already running.
        return;
    }
    // backwards compat for when 'opts' was 'historyLen'.
    if (typeof opts === "number") {
        opts = {
            initialSyncLimit: opts
        };
    }

    opts = opts || {};
    opts.initialSyncLimit = opts.initialSyncLimit || 8;
    opts.includeArchivedRooms = opts.includeArchivedRooms || false;
    opts.resolveInvitesToProfiles = opts.resolveInvitesToProfiles || false;
    opts.pollTimeout = opts.pollTimeout || (30 * 1000);
    this._config = opts;

    if (CRYPTO_ENABLED && this.sessionStore !== null) {
        this.uploadKeys(5);
    }

    if (this.store.getSyncToken()) {
        // resume from where we left off.
        _pollForEvents(this);
        return;
    }

    // periodically poll for turn servers if we support voip
    checkTurnServers(this);

    prepareForSync(this);
};

function prepareForSync(client, attempt) {
    attempt = attempt || 1;
    client.pushRules().done(function(result) {
        client.pushRules = result;
        doInitialSync(
            client,
            client._config.initialSyncLimit,
            client._config.includeArchivedRooms
        );
    }, function(err) {
        attempt += 1;
        startSyncingRetryTimer(client, attempt, function() {
            prepareForSync(client, attempt);
        });
        updateSyncState(client, "ERROR", { error: err });
    });
}

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {Number} attempt The attempt number
 */
function _pollForEvents(client, attempt) {
    attempt = attempt || 1;
    var self = client;
    if (!client.clientRunning) {
        return;
    }
    var discardResult = false;
    var timeoutObj = setTimeout(function() {
        discardResult = true;
        console.error("/events request timed out.");
        _pollForEvents(client);
    }, client._config.pollTimeout + (20 * 1000)); // 20s buffer

    client._http.authedRequest(undefined, "GET", "/events", {
        from: client.store.getSyncToken(),
        timeout: client._config.pollTimeout
    }).done(function(data) {
        if (discardResult) {
            return;
        }
        else {
            clearTimeout(timeoutObj);
        }

        if (self._syncState !== "SYNCING") {
            updateSyncState(self, "SYNCING");
        }

        try {
            var events = [];
            if (data) {
                events = utils.map(data.chunk, _PojoToMatrixEventMapper(self));
            }
            if (!(self.store instanceof StubStore)) {
                var roomIdsWithNewInvites = {};
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
                        if (events[i].getType() === "m.room.member" &&
                                events[i].getContent().membership === "invite") {
                            roomIdsWithNewInvites[roomId] = true;
                        }
                    }
                    else if (events[i].getType() === "m.presence") {
                        var usr = self.store.getUser(events[i].getContent().user_id);
                        if (usr) {
                            usr.setPresenceEvent(events[i]);
                        }
                        else {
                            usr = createNewUser(self, events[i].getContent().user_id);
                            usr.setPresenceEvent(events[i]);
                            self.store.storeUser(usr);
                        }
                    }
                }

                // add events to room
                var roomIds = utils.keys(roomIdToEvents);
                utils.forEach(roomIds, function(roomId) {
                    var room = self.store.getRoom(roomId);
                    var isBrandNewRoom = false;
                    if (!room) {
                        room = createNewRoom(self, roomId);
                        isBrandNewRoom = true;
                    }

                    var wasJoined = room.hasMembershipState(
                        self.credentials.userId, "join"
                    );

                    room.addEvents(roomIdToEvents[roomId], "replace");
                    room.recalculate(self.credentials.userId);

                    // store the Room for things like invite events so developers
                    // can update the UI
                    if (isBrandNewRoom) {
                        self.store.storeRoom(room);
                        self.emit("Room", room);
                    }

                    var justJoined = room.hasMembershipState(
                        self.credentials.userId, "join"
                    );

                    if (!wasJoined && justJoined) {
                        // we've just transitioned into a join state for this room,
                        // so sync state.
                        _syncRoom(self, room);
                    }
                });

                Object.keys(roomIdsWithNewInvites).forEach(function(inviteRoomId) {
                    _resolveInvites(self, self.store.getRoom(inviteRoomId));
                });
            }
            if (data) {
                self.store.setSyncToken(data.end);
                utils.forEach(events, function(e) {
                    self.emit("event", e);
                });
            }
        }
        catch (e) {
            console.error("Event stream error:");
            console.error(e);
        }
        _pollForEvents(self);
    }, function(err) {
        console.error("/events error: %s", JSON.stringify(err));
        if (discardResult) {
            return;
        }
        else {
            clearTimeout(timeoutObj);
        }

        attempt += 1;
        startSyncingRetryTimer(self, attempt, function() {
            _pollForEvents(self, attempt);
        });
        updateSyncState(self, "ERROR", { error: err });
    });
}

function _syncRoom(client, room) {
    if (client._syncingRooms[room.roomId]) {
        return client._syncingRooms[room.roomId];
    }
    var defer = q.defer();
    client._syncingRooms[room.roomId] = defer.promise;
    client.roomInitialSync(room.roomId, client._config.initialSyncLimit).done(
    function(res) {
        room.timeline = []; // blow away any previous messages.
        _processRoomEvents(client, room, res.state, res.messages);
        room.recalculate(client.credentials.userId);
        client.store.storeRoom(room);
        client.emit("Room", room);
        defer.resolve(room);
        client._syncingRooms[room.roomId] = undefined;
    }, function(err) {
        defer.reject(err);
        client._syncingRooms[room.roomId] = undefined;
    });
    return defer.promise;
}

function _processRoomEvents(client, room, stateEventList, messageChunk) {
    // "old" and "current" state are the same initially; they
    // start diverging if the user paginates.
    // We must deep copy otherwise membership changes in old state
    // will leak through to current state!
    var oldStateEvents = utils.map(
        utils.deepCopy(stateEventList), _PojoToMatrixEventMapper(client)
    );
    var stateEvents = utils.map(stateEventList, _PojoToMatrixEventMapper(client));
    room.oldState.setStateEvents(oldStateEvents);
    room.currentState.setStateEvents(stateEvents);

    _resolveInvites(client, room);

    // add events to the timeline *after* setting the state
    // events so messages use the right display names. Initial sync
    // returns messages in chronological order, so we need to reverse
    // it to get most recent -> oldest. We need it in that order in
    // order to diverge old/current state correctly.
    room.addEventsToTimeline(
        utils.map(
            messageChunk ? messageChunk.chunk : [],
            _PojoToMatrixEventMapper(client)
        ).reverse(), true
    );
    if (messageChunk) {
        room.oldState.paginationToken = messageChunk.start;
    }
}

/**
 * High level helper method to stop the client from polling and allow a
 * clean shutdown.
 */
MatrixClient.prototype.stopClient = function() {
    this.clientRunning = false;
    // TODO: f.e. Room => self.store.storeRoom(room) ?
};


function reEmit(reEmitEntity, emittableEntity, eventNames) {
    utils.forEach(eventNames, function(eventName) {
        // setup a listener on the entity (the Room, User, etc) for this event
        emittableEntity.on(eventName, function() {
            // take the args from the listener and reuse them, adding the
            // event name to the arg list so it works with .emit()
            // Transformation Example:
            // listener on "foo" => function(a,b) { ... }
            // Re-emit on "thing" => thing.emit("foo", a, b)
            var newArgs = [eventName];
            for (var i = 0; i < arguments.length; i++) {
                newArgs.push(arguments[i]);
            }
            reEmitEntity.emit.apply(reEmitEntity, newArgs);
        });
    });
}

function _resolveInvites(client, room) {
    if (!room || !client._config.resolveInvitesToProfiles) {
        return;
    }
    // For each invited room member we want to give them a displayname/avatar url
    // if they have one (the m.room.member invites don't contain this).
    room.getMembersWithMembership("invite").forEach(function(member) {
        if (member._requestedProfileInfo) {
            return;
        }
        member._requestedProfileInfo = true;
        // try to get a cached copy first.
        var user = client.getUser(member.userId);
        var promise;
        if (user) {
            promise = q({
                avatar_url: user.avatarUrl,
                displayname: user.displayName
            });
        }
        else {
            promise = client.getProfileInfo(member.userId);
        }
        promise.done(function(info) {
            // slightly naughty by doctoring the invite event but this means all
            // the code paths remain the same between invite/join display name stuff
            // which is a worthy trade-off for some minor pollution.
            var inviteEvent = member.events.member;
            if (inviteEvent.getContent().membership !== "invite") {
                // between resolving and now they have since joined, so don't clobber
                return;
            }
            inviteEvent.getContent().avatar_url = info.avatar_url;
            inviteEvent.getContent().displayname = info.displayname;
            member.setMembershipEvent(inviteEvent, room.currentState); // fire listeners
        }, function(err) {
            // OH WELL.
        });
    });
}

function setupCallEventHandler(client) {
    var candidatesByCall = {
        // callId: [Candidate]
    };
    client.on("event", function(event) {
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
    });
}

function startSyncingRetryTimer(client, attempt, fn) {
    client._syncingRetry = {};
    client._syncingRetry.fn = fn;
    client._syncingRetry.timeoutId = setTimeout(function() {
        fn();
    }, retryTimeMsForAttempt(attempt));
}

function updateSyncState(client, newState, data) {
    var old = client._syncState;
    client._syncState = newState;
    client.emit("sync", client._syncState, old, data);
}

function checkTurnServers(client) {
    if (!client._supportsVoip) {
        return;
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

function createNewUser(client, userId) {
    var user = new User(userId);
    reEmit(client, user, ["User.avatarUrl", "User.displayName", "User.presence"]);
    return user;
}

function createNewRoom(client, roomId) {
    var room = new Room(roomId);
    reEmit(client, room, ["Room.name", "Room.timeline", "Room.receipt"]);

    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember"
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership"
            ]
        );
    });
    return room;
}

function retryTimeMsForAttempt(attempt) {
    // 2,4,8,16,32,64,128,128,128,... seconds
    // max 2^7 secs = 2.1 mins
    return Math.pow(2, Math.min(attempt, 7)) * 1000;
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
 * The client may fire this before or after processing latest events from a sync.</li>
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
 * first time.
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
