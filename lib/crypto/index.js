/*
Copyright 2016 OpenMarket Ltd

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
 * @module crypto
 */

var anotherjson = require('another-json');
var q = require("q");

var utils = require("../utils");
var OlmDevice = require("./OlmDevice");
var olmlib = require("./olmlib");
var algorithms = require("./algorithms");
var DeviceInfo = require("./deviceinfo");
var DeviceVerification = DeviceInfo.DeviceVerification;

/**
 * Cryptography bits
 *
 * @constructor
 * @alias module:crypto
 *
 * @param {module:base-apis~MatrixBaseApis} baseApis base matrix api interface
 *
 * @param {external:EventEmitter} eventEmitter event source where we can register
 *    for event notifications
 *
 * @param {module:store/session/webstorage~WebStorageSessionStore} sessionStore
 *    Store to be used for end-to-end crypto session data
 *
 * @param {string} userId The user ID for the local user
 *
 * @param {string} deviceId The identifier for this device.
 */
function Crypto(baseApis, eventEmitter, sessionStore, userId, deviceId) {
    this._baseApis = baseApis;
    this._sessionStore = sessionStore;
    this._userId = userId;
    this._deviceId = deviceId;

    this._olmDevice = new OlmDevice(sessionStore);

    // EncryptionAlgorithm instance for each room
    this._roomAlgorithms = {};

    this._supportedAlgorithms = utils.keys(
        algorithms.DECRYPTION_CLASSES
    );

    // build our device keys: these will later be uploaded
    this._deviceKeys = {};
    this._deviceKeys["ed25519:" + this._deviceId] =
        this._olmDevice.deviceEd25519Key;
    this._deviceKeys["curve25519:" + this._deviceId] =
        this._olmDevice.deviceCurve25519Key;

    // add our own deviceinfo to the sessionstore
    var deviceInfo = {
        keys: this._deviceKeys,
        algorithms: this._supportedAlgorithms,
        verified: DeviceVerification.VERIFIED,
    };
    var myDevices = this._sessionStore.getEndToEndDevicesForUser(
        this._userId
    ) || {};
    myDevices[this._deviceId] = deviceInfo;
    this._sessionStore.storeEndToEndDevicesForUser(
        this._userId, myDevices
    );

    _registerEventHandlers(this, eventEmitter);
}

function _registerEventHandlers(crypto, eventEmitter) {
    eventEmitter.on("sync", function(syncState, oldState, data) {
        try {
            if (syncState == "PREPARED") {
                // XXX ugh. we're assuming the eventEmitter is a MatrixClient.
                // how can we avoid doing so?
                var rooms = eventEmitter.getRooms();
                crypto._onInitialSyncCompleted(rooms);
            }
        } catch (e) {
            console.error("Error handling sync", e);
        }
    });

    eventEmitter.on("RoomMember.membership", function(event, member, oldMembership) {
        try {
            crypto._onRoomMembership(event, member, oldMembership);
        } catch (e) {
             console.error("Error handling membership change:", e);
        }
    });

    eventEmitter.on("toDeviceEvent", function(event) {
        try {
            if (event.getType() == "m.room_key") {
                crypto._onRoomKeyEvent(event);
            } else if (event.getType() == "m.new_device") {
                crypto._onNewDeviceEvent(event);
            }
        } catch (e) {
            console.error("Error handling toDeviceEvent:", e);
        }
    });

    eventEmitter.on("event", function(event) {
        try {
            if (!event.isState() || event.getType() != "m.room.encryption") {
                return;
            }
            crypto._onCryptoEvent(event);
        } catch (e) {
            console.error("Error handling crypto event:", e);
        }
    });
}

/**
 * Get the Ed25519 key for this device
 *
 * @return {string} base64-encoded ed25519 key.
 */
Crypto.prototype.getDeviceEd25519Key = function() {
    return this._olmDevice.deviceEd25519Key;
};

/**
 * Upload the device keys to the homeserver and ensure that the
 * homeserver has enough one-time keys.
 * @param {number} maxKeys The maximum number of keys to generate
 * @return {object} A promise that will resolve when the keys are uploaded.
 */
Crypto.prototype.uploadKeys = function(maxKeys) {
    var self = this;
    return _uploadDeviceKeys(this).then(function(res) {
        var keyCount = res.one_time_key_counts.curve25519 || 0;
        var maxOneTimeKeys = self._olmDevice.maxNumberOfOneTimeKeys();
        var keyLimit = Math.floor(maxOneTimeKeys / 2);
        var numberToGenerate = Math.max(keyLimit - keyCount, 0);
        if (maxKeys !== undefined) {
            numberToGenerate = Math.min(numberToGenerate, maxKeys);
        }

        if (numberToGenerate <= 0) {
            return;
        }

        self._olmDevice.generateOneTimeKeys(numberToGenerate);
        return _uploadOneTimeKeys(self);
    });
};

// returns a promise which resolves to the response
function _uploadDeviceKeys(crypto) {
    var userId = crypto._userId;
    var deviceId = crypto._deviceId;

    var deviceKeys = {
        algorithms: crypto._supportedAlgorithms,
        device_id: deviceId,
        keys: crypto._deviceKeys,
        user_id: userId,
    };

    var sig = crypto._olmDevice.sign(anotherjson.stringify(deviceKeys));
    deviceKeys.signatures = {};
    deviceKeys.signatures[userId] = {};
    deviceKeys.signatures[userId]["ed25519:" + deviceId] = sig;

    return crypto._baseApis.uploadKeysRequest({
        device_keys: deviceKeys,
    }, {
        // for now, we set the device id explicitly, as we may not be using the
        // same one as used in login.
        device_id: deviceId,
    });
}

// returns a promise which resolves to the response
function _uploadOneTimeKeys(crypto) {
    var oneTimeKeys = crypto._olmDevice.getOneTimeKeys();
    var oneTimeJson = {};

    for (var keyId in oneTimeKeys.curve25519) {
        if (oneTimeKeys.curve25519.hasOwnProperty(keyId)) {
            oneTimeJson["curve25519:" + keyId] = oneTimeKeys.curve25519[keyId];
        }
    }
    return crypto._baseApis.uploadKeysRequest({
        one_time_keys: oneTimeJson
    }, {
        // for now, we set the device id explicitly, as we may not be using the
        // same one as used in login.
        device_id: crypto._deviceId,
    }).then(function(res) {
        crypto._olmDevice.markKeysAsPublished();
        return res;
    });
}

/**
 * Download the keys for a list of users and stores the keys in the session
 * store.
 * @param {Array} userIds The users to fetch.
 * @param {bool} forceDownload Always download the keys even if cached.
 *
 * @return {Promise} A promise which resolves to a map userId->deviceId->{@link
 * module:crypto/deviceinfo|DeviceInfo}.
 */
Crypto.prototype.downloadKeys = function(userIds, forceDownload) {
    var self = this;

    // map from userid -> deviceid -> DeviceInfo
    var stored = {};

    // list of userids we need to download keys for
    var downloadUsers = [];

    for (var i = 0; i < userIds.length; ++i) {
        var userId = userIds[i];
        stored[userId] = {};

        var devices = this.getStoredDevicesForUser(userId);
        for (var j = 0; j < devices.length; ++j) {
            var dev = devices[j];
            stored[userId][dev.deviceId] = dev;
        }

        if (devices.length === 0 || forceDownload) {
            downloadUsers.push(userId);
        }
    }

    if (downloadUsers.length === 0) {
        return q(stored);
    }

    return this._baseApis.downloadKeysForUsers(
        downloadUsers
    ).then(function(res) {
        for (var userId in res.device_keys) {
            if (!stored.hasOwnProperty(userId)) {
                // spurious result
                continue;
            }

            // map from deviceid -> deviceinfo for this user
            var userStore = stored[userId];
            var updated = _updateStoredDeviceKeysForUser(
                self._olmDevice, userId, userStore, res.device_keys[userId]
            );

            if (!updated) {
                continue;
            }

            // update the session store
            var storage = {};
            for (var deviceId in userStore) {
                if (!userStore.hasOwnProperty(deviceId)) {
                    continue;
                }

                storage[deviceId] = userStore[deviceId].toStorage();
                self._sessionStore.storeEndToEndDevicesForUser(
                    userId, storage
                );
            }
        }
        return stored;
    });
};

function _updateStoredDeviceKeysForUser(_olmDevice, userId, userStore,
                                        userResult) {
    var updated = false;

    // remove any devices in the store which aren't in the response
    for (var deviceId in userStore) {
        if (!userStore.hasOwnProperty(deviceId)) {
            continue;
        }

        if (!(deviceId in userResult)) {
            console.log("Device " + userId + ":" + deviceId +
                        " has been removed");
            delete userStore[deviceId];
            updated = true;
        }
    }

    for (deviceId in userResult) {
        if (!userResult.hasOwnProperty(deviceId)) {
            continue;
        }

        if (_storeDeviceKeys(
            _olmDevice, userId, deviceId, userStore, userResult[deviceId]
        )) {
            updated = true;
        }
    }

    return updated;
}

/*
 * Process a device in a /query response, and add it to the userStore
 *
 * returns true if a change was made, else false
 */
function _storeDeviceKeys(_olmDevice, userId, deviceId, userStore, deviceResult) {
    if (!deviceResult.keys) {
        // no keys?
        return false;
    }

    var signKeyId = "ed25519:" + deviceId;
    var signKey = deviceResult.keys[signKeyId];
    if (!signKey) {
        console.log("Device " + userId + ":" + deviceId +
                    " has no ed25519 key");
        return false;
    }

    var unsigned = deviceResult.unsigned || {};
    var signatures = deviceResult.signatures || {};
    var userSigs = signatures[userId] || {};
    var signature = userSigs[signKeyId];
    if (!signature) {
        console.log("Device " + userId + ":" + deviceId +
                    " is not signed");
        return false;
    }

    // prepare the canonical json: remove 'unsigned' and signatures, and
    // stringify with anotherjson
    delete deviceResult.unsigned;
    delete deviceResult.signatures;
    var json = anotherjson.stringify(deviceResult);

    try {
        _olmDevice.verifySignature(signKey, json, signature);
    } catch (e) {
        console.log("Unable to verify signature on device " +
                    userId + ":" + deviceId + ":", e);
        return false;
    }

    // DeviceInfo
    var deviceStore;

    if (deviceId in userStore) {
        // already have this device.
        deviceStore = userStore[deviceId];

        if (deviceStore.getFingerprint() != signKey) {
            // this should only happen if the list has been MITMed; we are
            // best off sticking with the original keys.
            //
            // Should we warn the user about it somehow?
            console.warn("Ed25519 key for device" + userId + ": " +
                         deviceId + " has changed");
            return false;
        }
    } else {
        userStore[deviceId] = deviceStore = new DeviceInfo(deviceId);
    }

    deviceStore.keys = deviceResult.keys || {};
    deviceStore.algorithms = deviceResult.algorithms || [];
    deviceStore.unsigned = unsigned;
    return true;
}

/**
 * Get the stored device keys for a user id
 *
 * @param {string} userId the user to list keys for.
 *
 * @return {module:crypto/deviceinfo[]} list of devices
 */
Crypto.prototype.getStoredDevicesForUser = function(userId) {
    var devs = this._sessionStore.getEndToEndDevicesForUser(userId);
    if (!devs) {
        return [];
    }
    var res = [];
    for (var deviceId in devs) {
        if (devs.hasOwnProperty(deviceId)) {
            res.push(DeviceInfo.fromStorage(devs[deviceId], deviceId));
        }
    }
    return res;
};


/**
 * List the stored device keys for a user id
 *
 * @deprecated prefer {@link module:crypto#getStoredDevicesForUser}
 *
 * @param {string} userId the user to list keys for.
 *
 * @return {object[]} list of devices with "id", "verified", "blocked",
 *    "key", and "display_name" parameters.
 */
Crypto.prototype.listDeviceKeys = function(userId) {
    var devices = this.getStoredDevicesForUser(userId);

    var result = [];

    for (var i = 0; i < devices.length; ++i) {
        var device = devices[i];
        var ed25519Key = device.getFingerprint();
        if (ed25519Key) {
            result.push({
                id: device.deviceId,
                key: ed25519Key,
                verified: Boolean(device.isVerified()),
                blocked: Boolean(device.isBlocked()),
                display_name: device.getDisplayName(),
            });
        }
    }

    // sort by deviceid
    result.sort(function(a, b) {
        if (a.deviceId < b.deviceId) { return -1; }
        if (a.deviceId > b.deviceId) { return 1; }
        return 0;
    });

    return result;
};

/**
 * Find a device by curve25519 identity key
 *
 * @param {string} userId     owner of the device
 * @param {string} algorithm  encryption algorithm
 * @param {string} sender_key curve25519 key to match
 *
 * @return {module:crypto/deviceinfo?}
 */
Crypto.prototype.getDeviceByIdentityKey = function(userId, algorithm, sender_key) {
    if (
        algorithm !== olmlib.OLM_ALGORITHM &&
        algorithm !== olmlib.MEGOLM_ALGORITHM
    ) {
        // we only deal in olm keys
        return null;
    }

    var devices = this._sessionStore.getEndToEndDevicesForUser(userId);
    if (!devices) {
        return null;
    }

    for (var deviceId in devices) {
        if (!devices.hasOwnProperty(deviceId)) {
            continue;
        }

        var device = devices[deviceId];
        for (var keyId in device.keys) {
            if (!device.keys.hasOwnProperty(keyId)) {
                continue;
            }
            if (keyId.indexOf("curve25519:") !== 0) {
                continue;
            }
            var deviceKey = device.keys[keyId];
            if (deviceKey == sender_key) {
                return DeviceInfo.fromStorage(device, deviceId);
            }
        }
    }

    // doesn't match a known device
    return null;
};


/**
 * Update the blocked/verified state of the given device
 *
 * @param {string} userId owner of the device
 * @param {string} deviceId unique identifier for the device
 *
 * @param {?boolean} verified whether to mark the device as verified. Null to
 *     leave unchanged.
 *
 * @param {?boolean} blocked whether to mark the device as blocked. Null to
 *      leave unchanged.
 */
Crypto.prototype.setDeviceVerification = function(userId, deviceId, verified, blocked) {
    var devices = this._sessionStore.getEndToEndDevicesForUser(userId);
    if (!devices || !devices[deviceId]) {
        throw new Error("Unknown device " + userId + ":" + deviceId);
    }

    var dev = devices[deviceId];
    var verificationStatus = dev.verified;

    if (verified) {
        verificationStatus = DeviceVerification.VERIFIED;
    } else if (verified !== null && verificationStatus == DeviceVerification.VERIFIED) {
        verificationStatus = DeviceVerification.UNVERIFIED;
    }

    if (blocked) {
        verificationStatus = DeviceVerification.BLOCKED;
    } else if (blocked !== null && verificationStatus == DeviceVerification.BLOCKED) {
        verificationStatus = DeviceVerification.UNVERIFIED;
    }

    if (dev.verified === verificationStatus) {
        return;
    }
    dev.verified = verificationStatus;
    this._sessionStore.storeEndToEndDevicesForUser(userId, devices);
};


/**
 * Get information on the active olm sessions with a user
 * <p>
 * Returns a map from device id to an object with keys 'deviceIdKey' (the
 * device's curve25519 identity key) and 'sessions' (an array of objects in the
 * same format as that returned by
 * {@link module:crypto/OlmDevice#getSessionInfoForDevice}).
 * <p>
 * This method is provided for debugging purposes.
 *
 * @param {string} userId id of user to inspect
 *
 * @return {Object.<string, {deviceIdKey: string, sessions: object[]}>}
 */
Crypto.prototype.getOlmSessionsForUser = function(userId) {
    var devices = this.getStoredDevicesForUser(userId);
    var result = {};
    for (var j = 0; j < devices.length; ++j) {
        var device = devices[j];
        var deviceKey = device.getIdentityKey();
        var sessions = this._olmDevice.getSessionInfoForDevice(deviceKey);

        result[device.deviceId] = {
            deviceIdKey: deviceKey,
            sessions: sessions,
        };
    }
    return result;
};


/**
 * Identify a device by curve25519 identity key and determine its verification state
 *
 * @param {string} userId     owner of the device
 * @param {string} algorithm  encryption algorithm
 * @param {string} sender_key curve25519 key to match
 *
 * @return {boolean} true if the device is verified
 */
Crypto.prototype.isSenderKeyVerified = function(userId, algorithm, sender_key) {

    // sender_key is the curve25519 public key of the device, that the event
    // purports to have been sent from. It's assumed that, by the time we get here,
    // we have already checked that the event was, in fact, sent by that device.
    //
    // In the case of both olm and megolm, that is achieved primarily by the
    // fact that sessions are indexed by the curve25519 key of the device that
    // created the session, and we assume that only that device has the keys
    // necessary to create valid messages in that session.
    //
    // So, all we need to do here is look up the device by sender and
    // curve25519 key and determine the state of the verification flag.

    var device = this.getDeviceByIdentityKey(userId, algorithm, sender_key);
    if (!device) {
        return false;
    }
    return device.verified == DeviceVerification.VERIFIED;
};


/**
 * Configure a room to use encryption (ie, save a flag in the sessionstore).
 *
 * @param {string} roomId The room ID to enable encryption in.
 * @param {object} config The encryption config for the room.
 */
Crypto.prototype.setRoomEncryption = function(roomId, config) {
    // if we already have encryption in this room, we should ignore this event
    // (for now at least. maybe we should alert the user somehow?)
    var existingConfig = this._sessionStore.getEndToEndRoom(roomId);
    if (existingConfig) {
        if (JSON.stringify(existingConfig) != JSON.stringify(config)) {
            console.error("Ignoring m.room.encryption event which requests " +
                          "a change of config in " + roomId);
            return;
        }
    }

    var AlgClass = algorithms.ENCRYPTION_CLASSES[config.algorithm];
    if (!AlgClass) {
        throw new Error("Unable to encrypt with " + config.algorithm);
    }

    // remove spurious keys
    config = {
        algorithm: config.algorithm,
    };
    this._sessionStore.storeEndToEndRoom(roomId, config);

    var alg = new AlgClass({
        deviceId: this._deviceId,
        crypto: this,
        olmDevice: this._olmDevice,
        baseApis: this._baseApis,
        roomId: roomId,
    });
    this._roomAlgorithms[roomId] = alg;
};


/**
 * @typedef {Object} module:crypto~OlmSessionResult
 * @property {module:crypto/deviceinfo} device  device info
 * @property {string?} sessionId base64 olm session id; null if no session
 *    could be established
 */

/**
 * Try to make sure we have established olm sessions for the given users.
 *
 * @param {string[]} users list of user ids
 *
 * @return {module:client.Promise} resolves once the sessions are complete, to
 *    an Object mapping from userId to deviceId to
 *    {@link module:crypto~OlmSessionResult}
 */
Crypto.prototype.ensureOlmSessionsForUsers = function(users) {
    var devicesWithoutSession = [
        // [userId, deviceId, deviceInfo], ...
    ];
    var result = {};

    for (var i = 0; i < users.length; ++i) {
        var userId = users[i];
        result[userId] = {};

        var devices = this.getStoredDevicesForUser(userId);
        for (var j = 0; j < devices.length; ++j) {
            var deviceInfo = devices[j];
            var deviceId = deviceInfo.deviceId;

            var key = deviceInfo.getIdentityKey();
            if (key == this._olmDevice.deviceCurve25519Key) {
                // don't bother setting up session to ourself
                continue;
            }
            if (deviceInfo.verified == DeviceVerification.BLOCKED) {
                // don't bother setting up sessions with blocked users
                continue;
            }

            var sessionId = this._olmDevice.getSessionIdForDevice(key);
            if (sessionId === null) {
                devicesWithoutSession.push([userId, deviceId, deviceInfo]);
            }
            result[userId][deviceId] = {
                device: deviceInfo,
                sessionId: sessionId,
            };
        }
    }

    if (devicesWithoutSession.length === 0) {
        return q(result);
    }

    // TODO: this has a race condition - if we try to send another message
    // while we are claiming a key, we will end up claiming two and setting up
    // two sessions.
    //
    // That should eventually resolve itself, but it's poor form.

    var self = this;
    return this._baseApis.claimOneTimeKeys(
        devicesWithoutSession
    ).then(function(res) {
        for (var i = 0; i < devicesWithoutSession.length; ++i) {
            var device = devicesWithoutSession[i];
            var userId = device[0];
            var deviceId = device[1];
            var deviceInfo = device[2];

            var userRes = res.one_time_keys[userId] || {};
            var deviceRes = userRes[deviceId];
            var oneTimeKey;
            for (var keyId in deviceRes) {
                if (keyId.indexOf("curve25519:") === 0) {
                    oneTimeKey = deviceRes[keyId];
                }
            }
            if (oneTimeKey) {
                var sid = self._olmDevice.createOutboundSession(
                    deviceInfo.getIdentityKey(), oneTimeKey
                );
                console.log("Started new sessionid " + sid +
                            " for device " + userId + ":" + deviceId);

                result[userId][deviceId].sessionId = sid;
            } else {
                console.warn("No one-time keys for device " +
                             userId + ":" + deviceId);
            }
        }
        return result;
    });
};

/**
 * Whether encryption is enabled for a room.
 * @param {string} roomId the room id to query.
 * @return {bool} whether encryption is enabled.
 */
Crypto.prototype.isRoomEncrypted = function(roomId) {
    return Boolean(this._roomAlgorithms[roomId]);
};


/**
 * Encrypt an event according to the configuration of the room, if necessary.
 *
 * @param {module:models/event.MatrixEvent} event  event to be sent
 *
 * @param {module:models/room?} room destination room. Null if the destination
 *     is not a room we have seen over the sync pipe.
 *
 * @return {module:client.Promise?} Promise which resolves when the event has been
 *     encrypted, or null if nothing was needed
 */
Crypto.prototype.encryptEventIfNeeded = function(event, room) {
    if (event.isEncrypted()) {
        // this event has already been encrypted; this happens if the
        // encryption step succeeded, but the send step failed on the first
        // attempt.
        return null;
    }

    if (event.getType() !== "m.room.message") {
        // we only encrypt m.room.message
        return null;
    }

    if (!room) {
        throw new Error("Cannot send encrypted messages in unknown rooms");
    }

    var roomId = event.getRoomId();

    var alg = this._roomAlgorithms[roomId];
    if (!alg) {
        // not encrypting messages in this room

        // check that the HS hasn't hidden the crypto event
        if (this._sessionStore.getEndToEndRoom(roomId)) {
            throw new Error(
                "Room was previously configured to use encryption, but is " +
                "no longer. Perhaps the homeserver is hiding the " +
                "configuration event."
            );
        }
        return null;
    }

    return alg.encryptMessage(
        room, event.getType(), event.getContent()
    ).then(function(encryptedContent) {
        event.makeEncrypted("m.room.encrypted", encryptedContent);
    });
};

/**
 * Decrypt a received event
 *
 * @param {object} event raw event
 *
 * @return {object} decrypted payload (with properties 'type', 'content')
 *
 * @raises {algorithms.DecryptionError} if there is a problem decrypting the event
 */
Crypto.prototype.decryptEvent = function(event) {
    var content = event.content;
    var AlgClass = algorithms.DECRYPTION_CLASSES[content.algorithm];
    if (!AlgClass) {
        throw new algorithms.DecryptionError("Unable to decrypt " + content.algorithm);
    }
    var alg = new AlgClass({
        olmDevice: this._olmDevice,
    });
    var r = alg.decryptEvent(event);
    if (r.sessionExists) {
        return r.result;
    } else {
        // We've got a message for a session we don't have.
        // Maybe the sender forgot to tell us about the session.
        // Remind the sender that we exists so that they might
        // tell us about the sender.
        if (event.getRoomId !== undefined && event.getSender !== undefined) {
            var senderUserId = event.getSender();
            var roomId = event.getRoomId();
            var content = {};
            var senderDeviceId = event.content.device_id;
            if (senderDeviceId !== undefined) {
                content[senderUserId][senderDeviceId] = {
                    device_id: this._deviceId,
                    rooms: [roomId],
                };
            } else {
                content[senderUserId]["*"] = {
                    device_id: this._deviceId,
                    rooms: [roomId],
                };
            }
            // TODO: Ratelimit the "m.new_device" messages to make sure we don't
            // flood the target device with messages if we get lots of encrypted
            // messages from them at once.
            this._baseApis.sendToDevice(
                "m.new_device", // OH HAI!
                content
            ).done(function() {});
        }

        throw new algorithms.DecryptionError("Unknown inbound session id");
    }
};

/**
 * handle an m.room.encryption event
 *
 * @private
 * @param {module:models/event.MatrixEvent} event encryption event
 */
Crypto.prototype._onCryptoEvent = function(event) {
    var roomId = event.getRoomId();
    var content = event.getContent();

    try {
        this.setRoomEncryption(roomId, content);
    } catch (e) {
        console.error("Error configuring encryption in room " + roomId +
                      ":", e);
    }
};

/**
 * handle the completion of the initial sync.
 *
 * Announces the new device.
 *
 * @private
 * @param {module:models/room[]} rooms list of rooms the client knows about
 */
Crypto.prototype._onInitialSyncCompleted = function(rooms) {
    if (this._sessionStore.getDeviceAnnounced()) {
        return;
    }

    // we need to tell all the devices in all the rooms we are members of that
    // we have arrived.
    // build a list of rooms for each user.
    var roomsByUser = {};
    for (var i = 0; i < rooms.length; i++) {
        var room = rooms[i];

        // check for rooms with encryption enabled
        var alg = this._roomAlgorithms[room.roomId];
        if (!alg) {
            continue;
        }

        // ignore any rooms which we have left
        var me = room.getMember(this._userId);
        if (!me || (
            me.membership !== "join" && me.membership !== "invite"
        )) {
            continue;
        }

        var members = room.getJoinedMembers();
        for (var j = 0; j < members.length; j++) {
            var m = members[j];
            if (!roomsByUser[m.userId]) {
                roomsByUser[m.userId] = [];
            }
            roomsByUser[m.userId].push(room.roomId);
        }
    }

    // build a per-device message for each user
    var content = {};
    for (var userId in roomsByUser) {
        if (!roomsByUser.hasOwnProperty(userId)) {
            continue;
        }
        content[userId] = {
            "*": {
                device_id: this._deviceId,
                rooms: roomsByUser[userId],
            },
        };
    }

    var self = this;
    this._baseApis.sendToDevice(
        "m.new_device", // OH HAI!
        content
    ).done(function() {
        self._sessionStore.setDeviceAnnounced();
    });
};

/**
 * Handle a key event
 *
 * @private
 * @param {module:models/event.MatrixEvent} event key event
 */
Crypto.prototype._onRoomKeyEvent = function(event) {
    var content = event.getContent();
    var AlgClass = algorithms.DECRYPTION_CLASSES[content.algorithm];
    if (!AlgClass) {
        throw new algorithms.DecryptionError(
            "Unable to handle keys for " + content.algorithm
        );
    }
    var alg = new AlgClass({
        olmDevice: this._olmDevice,
    });
    alg.onRoomKeyEvent(event);
};

/**
 * Handle a change in the membership state of a member of a room
 *
 * @private
 * @param {module:models/event.MatrixEvent} event  event causing the change
 * @param {module:models/room-member} member  user whose membership changed
 * @param {string=} oldMembership  previous membership
 */
Crypto.prototype._onRoomMembership = function(event, member, oldMembership) {

    // this event handler is registered on the *client* (as opposed to the
    // room member itself), which means it is only called on changes to the
    // *live* membership state (ie, it is not called when we back-paginate).
    //
    // Further, it is automatically registered and called when new members
    // arrive in the room.

    var roomId = member.roomId;

    var alg = this._roomAlgorithms[roomId];
    if (!alg) {
        // not encrypting in this room
        return;
    }

    alg.onRoomMembership(event, member, oldMembership);
};


/**
 * Called when a new device announces itself
 *
 * @private
 * @param {module:models/event.MatrixEvent} event announcement event
 */
Crypto.prototype._onNewDeviceEvent = function(event) {
    var content = event.getContent();
    var userId = event.getSender();
    var deviceId = content.device_id;
    var rooms = content.rooms;

    if (!rooms || !deviceId) {
        console.warn("new_device event missing keys");
        return;
    }

    var self = this;
    this.downloadKeys(
        [userId], true
    ).then(function() {
        for (var i = 0; i < rooms.length; i++) {
            var roomId = rooms[i];
            var alg = self._roomAlgorithms[roomId];
            if (!alg) {
                // not encrypting in this room
                continue;
            }
            alg.onNewDevice(userId, deviceId);
        }
    }).catch(function(e) {
        console.error(
            "Error updating device keys for new device " + userId + ":" +
                deviceId,
            e
        );
    }).done();
};

/**
 * @see module:crypto/algorithms/base.DecryptionError
 */
Crypto.DecryptionError = algorithms.DecryptionError;


/** */
module.exports = Crypto;
