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

    this._initialSyncCompleted = false;
    // userId -> true
    this._pendingUsersWithNewDevices = {};
    // userId -> [promise, ...]
    this._keyDownloadsInProgressByUser = {};

    this._olmDevice = new OlmDevice(sessionStore);

    // EncryptionAlgorithm instance for each room
    this._roomEncryptors = {};

    // map from algorithm to DecryptionAlgorithm instance, for each room
    this._roomDecryptors = {};

    this._supportedAlgorithms = utils.keys(
        algorithms.DECRYPTION_CLASSES
    );

    // build our device keys: these will later be uploaded
    this._deviceKeys = {};
    this._deviceKeys["ed25519:" + this._deviceId] =
        this._olmDevice.deviceEd25519Key;
    this._deviceKeys["curve25519:" + this._deviceId] =
        this._olmDevice.deviceCurve25519Key;

    var myDevices = this._sessionStore.getEndToEndDevicesForUser(
        this._userId
    );

    if (!myDevices) {
        // we don't yet have a list of our own devices; make sure we
        // get one when we flush the pendingUsersWithNewDevices.
        this._pendingUsersWithNewDevices[this._userId] = true;
        myDevices = {};
    }

    if (!myDevices[this._deviceId]) {
        // add our own deviceinfo to the sessionstore
        var deviceInfo = {
            keys: this._deviceKeys,
            algorithms: this._supportedAlgorithms,
            verified: DeviceVerification.VERIFIED,
        };

        myDevices[this._deviceId] = deviceInfo;
        this._sessionStore.storeEndToEndDevicesForUser(
            this._userId, myDevices
        );
    }

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
 * @return {string} The version of Olm.
 */
Crypto.getOlmVersion = function() {
    return OlmDevice.getOlmVersion();
};

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
        // We need to keep a pool of one time public keys on the server so that
        // other devices can start conversations with us. But we can only store
        // a finite number of private keys in the olm Account object.
        // To complicate things further then can be a delay between a device
        // claiming a public one time key from the server and it sending us a
        // message. We need to keep the corresponding private key locally until
        // we receive the message.
        // But that message might never arrive leaving us stuck with duff
        // private keys clogging up our local storage.
        // So we need some kind of enginering compromise to balance all of
        // these factors.

        // We first find how many keys the server has for us.
        var keyCount = res.one_time_key_counts.signed_curve25519 || 0;
        // We then check how many keys we can store in the Account object.
        var maxOneTimeKeys = self._olmDevice.maxNumberOfOneTimeKeys();
        // Try to keep at most half that number on the server. This leaves the
        // rest of the slots free to hold keys that have been claimed from the
        // server but we haven't recevied a message for.
        // If we run out of slots when generating new keys then olm will
        // discard the oldest private keys first. This will eventually clean
        // out stale private keys that won't receive a message.
        var keyLimit = Math.floor(maxOneTimeKeys / 2);
        // We work out how many new keys we need to create to top up the server
        // If there are too many keys on the server then we don't need to
        // create any more keys.
        var numberToGenerate = Math.max(keyLimit - keyCount, 0);
        if (maxKeys !== undefined) {
            // Creating keys can be an expensive operation so we limit the
            // number we generate in one go to avoid blocking the application
            // for too long.
            numberToGenerate = Math.min(numberToGenerate, maxKeys);
        }

        if (numberToGenerate <= 0) {
            // If we don't need to generate any keys then we are done.
            return;
        }

        // Ask olm to generate new one time keys, then upload them to synapse.
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
    crypto._signObject(deviceKeys);

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
            var k = {
                key: oneTimeKeys.curve25519[keyId],
            };
            crypto._signObject(k);
            oneTimeJson["signed_curve25519:" + keyId] = k;
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

    // promises we need to wait for while the download happens
    var promises = [];

    // list of userids we need to download keys for
    var downloadUsers = [];

    function perUserCatch(u) {
        return function(e) {
            console.warn('Error downloading keys for user ' + u + ':', e);
        };
    }

    if (forceDownload) {
        downloadUsers = userIds;
    } else {
        for (var i = 0; i < userIds.length; ++i) {
            var u = userIds[i];

            var inprogress = this._keyDownloadsInProgressByUser[u];
            if (inprogress) {
                // wait for the download to complete
                promises.push(q.any(inprogress).catch(perUserCatch(u)));
            } else if (!this.getStoredDevicesForUser(u)) {
                downloadUsers.push(u);
            }
        }
    }

    if (downloadUsers.length > 0) {
        var r = this._doKeyDownloadForUsers(downloadUsers);
        downloadUsers.map(function(u) {
            promises.push(r[u].catch(perUserCatch(u)));
        });
    }

    return q.all(promises).then(function() {
        return self._getDevicesFromStore(userIds);
    });
};


/**
 * Get the stored device keys for a list of user ids
 *
 * @param {string[]} userIds the list of users to list keys for.
 *
 * @return {Object} userId->deviceId->{@link module:crypto/deviceinfo|DeviceInfo}.
 */
Crypto.prototype._getDevicesFromStore = function(userIds) {
    var stored = {};
    var self = this;
    userIds.map(function(u) {
        stored[u] = {};
        var devices = self.getStoredDevicesForUser(u) || [];
        devices.map(function(dev) {
            stored[u][dev.deviceId] = dev;
        });
    });
    return stored;
};

/**
 * @param {string[]} downloadUsers list of userIds
 *
 * @return {Object a map from userId to a promise for a result for that user
 */
Crypto.prototype._doKeyDownloadForUsers = function(downloadUsers) {
    var self = this;

    console.log('Starting key download for ' + downloadUsers);

    var deferMap = {};
    var promiseMap = {};

    downloadUsers.map(function(u) {
        var deferred = q.defer();
        var promise = deferred.promise.finally(function() {
            var inProgress = self._keyDownloadsInProgressByUser[u];
            utils.removeElement(inProgress, function(e) { return e === promise; });
            if (inProgress.length === 0) {
                // no more downloads for this user; remove the element
                delete self._keyDownloadsInProgressByUser[u];
            }
        });

        if (!self._keyDownloadsInProgressByUser[u]) {
            self._keyDownloadsInProgressByUser[u] = [];
        }
        self._keyDownloadsInProgressByUser[u].push(promise);

        deferMap[u] = deferred;
        promiseMap[u] = promise;
    });

    this._baseApis.downloadKeysForUsers(
        downloadUsers
    ).done(function(res) {
        var dk = res.device_keys || {};

        for (var i = 0; i < downloadUsers.length; ++i) {
            var userId = downloadUsers[i];
            var deviceId;

            console.log('got keys for ' + userId + ':', dk[userId]);

            if (!dk[userId]) {
                // no result for this user
                var err = 'Unknown';
                // TODO: do something with res.failures
                deferMap[userId].reject(err);
                continue;
            }

            // map from deviceid -> deviceinfo for this user
            var userStore = {};
            var devs = self._sessionStore.getEndToEndDevicesForUser(userId);
            if (devs) {
                for (deviceId in devs) {
                    if (devs.hasOwnProperty(deviceId)) {
                        var d = DeviceInfo.fromStorage(devs[deviceId], deviceId);
                        userStore[deviceId] = d;
                    }
                }
            }

            _updateStoredDeviceKeysForUser(
                self._olmDevice, userId, userStore, dk[userId]
            );

            // update the session store
            var storage = {};
            for (deviceId in userStore) {
                if (!userStore.hasOwnProperty(deviceId)) {
                    continue;
                }

                storage[deviceId] = userStore[deviceId].toStorage();
            }
            self._sessionStore.storeEndToEndDevicesForUser(
                userId, storage
            );

            deferMap[userId].resolve();
        }
    }, function(err) {
        downloadUsers.map(function(u) {
            deferMap[u].reject(err);
        });
    });

    return promiseMap;
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

        var deviceResult = userResult[deviceId];

        // check that the user_id and device_id in the response object are
        // correct
        if (deviceResult.user_id !== userId) {
            console.warn("Mismatched user_id " + deviceResult.user_id +
                         " in keys from " + userId + ":" + deviceId);
            continue;
        }
        if (deviceResult.device_id !== deviceId) {
            console.warn("Mismatched device_id " + deviceResult.device_id +
                         " in keys from " + userId + ":" + deviceId);
            continue;
        }

        if (_storeDeviceKeys(_olmDevice, userStore, deviceResult)) {
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
function _storeDeviceKeys(_olmDevice, userStore, deviceResult) {
    if (!deviceResult.keys) {
        // no keys?
        return false;
    }

    var deviceId = deviceResult.device_id;
    var userId = deviceResult.user_id;

    var signKeyId = "ed25519:" + deviceId;
    var signKey = deviceResult.keys[signKeyId];
    if (!signKey) {
        console.log("Device " + userId + ":" + deviceId +
                    " has no ed25519 key");
        return false;
    }

    var unsigned = deviceResult.unsigned || {};

    try {
        olmlib.verifySignature(_olmDevice, deviceResult, userId, deviceId, signKey);
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
 * @return {module:crypto/deviceinfo[]?} list of devices, or null if we haven't
 * managed to get a list of devices for this user yet.
 */
Crypto.prototype.getStoredDevicesForUser = function(userId) {
    var devs = this._sessionStore.getEndToEndDevicesForUser(userId);
    if (!devs) {
        return null;
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
 * Get the stored keys for a single device
 *
 * @param {string} userId
 * @param {string} deviceId
 *
 * @return {module:crypto/deviceinfo?} list of devices, or undefined
 * if we don't know about this device
 */
Crypto.prototype.getStoredDevice = function(userId, deviceId) {
    var devs = this._sessionStore.getEndToEndDevicesForUser(userId);
    if (!devs || !devs[deviceId]) {
        return undefined;
    }
    return DeviceInfo.fromStorage(devs[deviceId], deviceId);
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
    var devices = this.getStoredDevicesForUser(userId) || [];

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
    var devices = this.getStoredDevicesForUser(userId) || [];
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
 * Get the device which sent an event
 *
 * @param {module:models/event.MatrixEvent} event event to be checked
 *
 * @return {module:crypto/deviceinfo?}
 */
Crypto.prototype.getEventSenderDeviceInfo = function(event) {
    var sender_key = event.getSenderKey();
    var algorithm = event.getWireContent().algorithm;

    if (!sender_key || !algorithm) {
        return null;
    }

    // sender_key is the Curve25519 identity key of the device which the event
    // was sent from. In the case of Megolm, it's actually the Curve25519
    // identity key of the device which set up the Megolm session.

    var device = this.getDeviceByIdentityKey(
        event.getSender(), algorithm, sender_key
    );

    if (device === null) {
        // we haven't downloaded the details of this device yet.
        return null;
    }

    // so far so good, but now we need to check that the sender of this event
    // hadn't advertised someone else's Curve25519 key as their own. We do that
    // by checking the Ed25519 claimed by the event (or, in the case of megolm,
    // the event which set up the megolm session), to check that it matches the
    // fingerprint of the purported sending device.
    //
    // (see https://github.com/vector-im/vector-web/issues/2215)

    var claimedKey = event.getKeysClaimed().ed25519;
    if (!claimedKey) {
        console.warn("Event " + event.getId() + " claims no ed25519 key: " +
                     "cannot verify sending device");
        return null;
    }

    if (claimedKey !== device.getFingerprint()) {
        console.warn(
            "Event " + event.getId() + " claims ed25519 key " + claimedKey +
                "but sender device has key " + device.getFingerprint());
        return null;
    }

    return device;
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
        userId: this._userId,
        deviceId: this._deviceId,
        crypto: this,
        olmDevice: this._olmDevice,
        baseApis: this._baseApis,
        roomId: roomId,
        config: config,
    });
    this._roomEncryptors[roomId] = alg;
};


/**
 * @typedef {Object} module:crypto~OlmSessionResult
 * @property {module:crypto/deviceinfo} device  device info
 * @property {string?} sessionId base64 olm session id; null if no session
 *    could be established
 */

/**
 * Try to make sure we have established olm sessions for all known devices for
 * the given users.
 *
 * @param {string[]} users list of user ids
 *
 * @return {module:client.Promise} resolves once the sessions are complete, to
 *    an Object mapping from userId to deviceId to
 *    {@link module:crypto~OlmSessionResult}
 */
Crypto.prototype.ensureOlmSessionsForUsers = function(users) {
    var devicesByUser = {};

    for (var i = 0; i < users.length; ++i) {
        var userId = users[i];
        devicesByUser[userId] = [];

        var devices = this.getStoredDevicesForUser(userId) || [];
        for (var j = 0; j < devices.length; ++j) {
            var deviceInfo = devices[j];

            var key = deviceInfo.getIdentityKey();
            if (key == this._olmDevice.deviceCurve25519Key) {
                // don't bother setting up session to ourself
                continue;
            }
            if (deviceInfo.verified == DeviceVerification.BLOCKED) {
                // don't bother setting up sessions with blocked users
                continue;
            }

            devicesByUser[userId].push(deviceInfo);
        }
    }

    return olmlib.ensureOlmSessionsForDevices(
        this._olmDevice, this._baseApis, devicesByUser
    );
};

/**
 * Whether encryption is enabled for a room.
 * @param {string} roomId the room id to query.
 * @return {bool} whether encryption is enabled.
 */
Crypto.prototype.isRoomEncrypted = function(roomId) {
    return Boolean(this._roomEncryptors[roomId]);
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

    if (!room) {
        throw new Error("Cannot send encrypted messages in unknown rooms");
    }

    var roomId = event.getRoomId();

    var alg = this._roomEncryptors[roomId];
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

    // We can claim and prove ownership of all our device keys in the local
    // echo of the event since we know that all the local echos come from
    // this device.
    var myKeys = {
        curve25519: this._olmDevice.deviceCurve25519Key,
        ed25519: this._olmDevice.deviceEd25519Key,
    };

    return alg.encryptMessage(
        room, event.getType(), event.getContent()
    ).then(function(encryptedContent) {
        event.makeEncrypted("m.room.encrypted", encryptedContent, myKeys);
    });
};

/**
 * Decrypt a received event
 *
 * @param {MatrixEvent} event
 *
 * @raises {algorithms.DecryptionError} if there is a problem decrypting the event
 */
Crypto.prototype.decryptEvent = function(event) {
    var content = event.getWireContent();
    var alg = this._getRoomDecryptor(event.getRoomId(), content.algorithm);
    alg.decryptEvent(event);
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
    this._initialSyncCompleted = true;

    // catch up on any m.new_device events which arrived during the initial sync.
    this._flushNewDeviceRequests();

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
        var alg = this._roomEncryptors[room.roomId];
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

    if (!content.room_id || !content.algorithm) {
        console.error("key event is missing fields");
        return;
    }

    var alg = this._getRoomDecryptor(content.room_id, content.algorithm);
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

    // this event handler is registered on the *client* (as opposed to the room
    // member itself), which means it is only called on changes to the *live*
    // membership state (ie, it is not called when we back-paginate, nor when
    // we load the state in the initialsync).
    //
    // Further, it is automatically registered and called when new members
    // arrive in the room.

    var roomId = member.roomId;

    var alg = this._roomEncryptors[roomId];
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

    console.log("m.new_device event from " + userId + ":" + deviceId +
                " for rooms " + rooms);

    if (this.getStoredDevice(userId, deviceId)) {
        console.log("Known device; ignoring");
        return;
    }

    this._pendingUsersWithNewDevices[userId] = true;

    // we delay handling these until the intialsync has completed, so that we
    // can do all of them together.
    if (this._initialSyncCompleted) {
        this._flushNewDeviceRequests();
    }
};

/**
 * Start device queries for any users who sent us an m.new_device recently
 */
Crypto.prototype._flushNewDeviceRequests = function() {
    var self = this;

    var users = utils.keys(this._pendingUsersWithNewDevices);

    if (users.length === 0) {
        return;
    }

    var r = this._doKeyDownloadForUsers(users);

    // we've kicked off requests to these users: remove their
    // pending flag for now.
    this._pendingUsersWithNewDevices = {};

    users.map(function(u) {
        r[u] = r[u].catch(function(e) {
            console.error(
                'Error updating device keys for user ' + u + ':', e
            );

            // reinstate the pending flags on any users which failed; this will
            // mean that we will do another download in the future, but won't
            // tight-loop.
            //
            self._pendingUsersWithNewDevices[u] = true;
        });
    });

    q.all(utils.values(r)).done();
};

/**
 * Get a decryptor for a given room and algorithm.
 *
 * If we already have a decryptor for the given room and algorithm, return
 * it. Otherwise try to instantiate it.
 *
 * @private
 *
 * @param {string?} roomId   room id for decryptor. If undefined, a temporary
 * decryptor is instantiated.
 *
 * @param {string} algorithm  crypto algorithm
 *
 * @return {module:crypto.algorithms.base.DecryptionAlgorithm}
 *
 * @raises {module:crypto.algorithms.DecryptionError} if the algorithm is
 * unknown
 */
Crypto.prototype._getRoomDecryptor = function(roomId, algorithm) {
    var decryptors;
    var alg;

    roomId = roomId || null;
    if (roomId) {
        decryptors = this._roomDecryptors[roomId];
        if (!decryptors) {
            this._roomDecryptors[roomId] = decryptors = {};
        }

        alg = decryptors[algorithm];
        if (alg) {
            return alg;
        }
    }

    var AlgClass = algorithms.DECRYPTION_CLASSES[algorithm];
    if (!AlgClass) {
        throw new algorithms.DecryptionError(
            'Unknown encryption algorithm "' + algorithm + '".'
        );
    }
    alg = new AlgClass({
        userId: this._userId,
        crypto: this,
        olmDevice: this._olmDevice,
        roomId: roomId,
    });

    if (decryptors) {
        decryptors[algorithm] = alg;
    }
    return alg;
};


/**
 * sign the given object with our ed25519 key
 *
 * @param {Object} obj  Object to which we will add a 'signatures' property
 */
Crypto.prototype._signObject = function(obj) {
    var sigs = {};
    sigs[this._userId] = {};
    sigs[this._userId]["ed25519:" + this._deviceId] =
        this._olmDevice.sign(anotherjson.stringify(obj));
    obj.signatures = sigs;
};

/**
 * @see module:crypto/algorithms/base.DecryptionError
 */
Crypto.DecryptionError = algorithms.DecryptionError;


/** */
module.exports = Crypto;
