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

var OlmDevice = require("./OlmDevice");

var algorithms = require("./crypto-algorithms");

var OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

/**
 * @enum
 */
var DeviceVerification = {
    VERIFIED: 1,
    UNVERIFIED: 0,
    BLOCKED: -1,
};

/**
  * Information about a user's device
  *
  * @constructor
  *
  * @property {string} deviceId the ID of this device
  *
  * @property {string[]} algorithms list of algorithms supported by this device
  *
  * @property {Object.<string,string>} keys a map from
  *      &lt;key type&gt;:&lt;id&gt; -> &lt;base64-encoded key&gt;>
  *
  * @property {module:crypto~DeviceVerification} verified whether the device has been
  *     verified by the user
  *
  * @property {Object} unsigned  additional data from the homeserver
  *
  * @param {string} deviceId id of the device
  */
function DeviceInfo(deviceId) {
    // you can't change the deviceId
    Object.defineProperty(this, 'deviceId', {
        enumerable: true,
        value: deviceId,
    });

    this.algorithms = [];
    this.keys = {};
    this.verified = DeviceVerification.UNVERIFIED;
    this.unsigned = {};
}

/**
 * rehydrate a DeviceInfo from the session store
 *
 * @param {object} obj  raw object from session store
 * @param {string} deviceId id of the device
 *
 * @return {module:crypto~DeviceInfo} new DeviceInfo
 */
DeviceInfo.fromStorage = function(obj, deviceId) {
    var res = new DeviceInfo(deviceId);
    for (var prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            res[prop] = obj[prop];
        }
    }
    return res;
};

/**
 * Prepare a DeviceInfo for JSON serialisation in the session store
 *
 * @return {object} deviceinfo with non-serialised members removed
 */
DeviceInfo.prototype.toStorage = function() {
    return {
        algorithms: this.algorithms,
        keys: this.keys,
        verified: this.verified,
        unsigned: this.unsigned,
    };
};

/**
 * Get the fingerprint for this device (ie, the Ed25519 key)
 *
 * @return {string} base64-encoded fingerprint of this device
 */
DeviceInfo.prototype.getFingerprint = function() {
    return this.keys["ed25519:" + this.deviceId];
};

/**
 * Get the configured display name for this device, if any
 *
 * @return {string?} displayname
 */
DeviceInfo.prototype.getDisplayname = function() {
    return this.unsigned.device_display_name || null;
};

/**
 * Cryptography bits
 *
 * @alias module:crypto.Crypto
 * @constructor
 * @alias module:crypto
 *
 * @param {module:base-apis~MatrixBaseApis} baseApis base matrix api interface
 *
 * @param {module:store/session/webstorage~WebStorageSessionStore} sessionStore
 *    Store to be used for end-to-end crypto session data
 *
 * @param {string} userId The user ID for the local user
 *
 * @param {string} deviceId The identifier for this device.
 */
function Crypto(baseApis, sessionStore, userId, deviceId) {
    this._baseApis = baseApis;
    this._sessionStore = sessionStore;
    this._userId = userId;
    this._deviceId = deviceId;

    this._olmDevice = new OlmDevice(sessionStore);

    // EncryptionAlgorithm instance for each room
    this._roomAlgorithms = {};

    // build our device keys: these will later be uploaded
    this._deviceKeys = {};
    this._deviceKeys["ed25519:" + this._deviceId] =
        this._olmDevice.deviceEd25519Key;
    this._deviceKeys["curve25519:" + this._deviceId] =
        this._olmDevice.deviceCurve25519Key;

    // add our own deviceinfo to the sessionstore
    var deviceInfo = {
        keys: this._deviceKeys,
        algorithms: [OLM_ALGORITHM],
        verified: DeviceVerification.VERIFIED,
    };
    var myDevices = this._sessionStore.getEndToEndDevicesForUser(
        this._userId
    ) || {};
    myDevices[this._deviceId] = deviceInfo;
    this._sessionStore.storeEndToEndDevicesForUser(
        this._userId, myDevices
    );
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
        algorithms: [OLM_ALGORITHM],
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
 * module:crypto~DeviceInfo|DeviceInfo}.
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

    var unsigned = deviceResult.unsigned;
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

    deviceStore.keys = deviceResult.keys;
    deviceStore.algorithms = deviceResult.algorithms;
    deviceStore.unsigned = unsigned;
    return true;
}


/**
 * Get the stored device keys for a user id
 *
 * @param {string} userId the user to list keys for.
 *
 * @return {module:crypto~DeviceInfo[]} list of devices
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
                verified: Boolean(device.verified == DeviceVerification.VERIFIED),
                blocked: Boolean(device.verified == DeviceVerification.BLOCKED),
                display_name: device.getDisplayname(),
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
 * @return {module:crypto~DeviceInfo?}
 */
Crypto.prototype.getDeviceByIdentityKey = function(userId, algorithm, sender_key) {
    if (algorithm !== OLM_ALGORITHM) {
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
 * Identify a device by curve25519 identity key and determine its verification state
 *
 * @param {string} userId     owner of the device
 * @param {string} algorithm  encryption algorithm
 * @param {string} sender_key curve25519 key to match
 *
 * @return {boolean} true if the device is verified
 */
Crypto.prototype.isSenderKeyVerified = function(userId, algorithm, sender_key) {
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
 * @param {string[]} roomMembers userIds of room members to start sessions with
 *
 * @return {module:client.Promise} A promise that will resolve when encryption is setup.
 */
Crypto.prototype.setRoomEncryption = function(roomId, config, roomMembers) {
    // if we already have encryption in this room, we should ignore this event
    // (for now at least. maybe we should alert the user somehow?)
    var existingConfig = this._sessionStore.getEndToEndRoom(roomId);
    if (existingConfig) {
        if (JSON.stringify(existingConfig) != JSON.stringify(config)) {
            console.error("Ignoring m.room.encryption event which requests " +
                          "a change of config in " + roomId);
            return q();
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
        roomId: roomId,
    });
    this._roomAlgorithms[roomId] = alg;
    return alg.initRoomEncryption(roomMembers);
};

/**
 * Try to make sure we have established olm sessions for the given users.
 *
 * @param {string[]} users list of user ids
 *
 * @return {module:client.Promise} resolves once the sessions are complete, to
 *  an object with keys <tt>missingUsers</tt> (a list of users with no known
 *  olm devices), and <tt>missingDevices</tt> a list of olm devices with no
 *  known one-time keys.
 */
Crypto.prototype.ensureOlmSessionsForUsers = function(users) {
    var devicesWithoutSession = [];
    var userWithoutDevices = [];
    for (var i = 0; i < users.length; ++i) {
        var userId = users[i];
        var devices = this._sessionStore.getEndToEndDevicesForUser(userId);
        if (!devices) {
            userWithoutDevices.push(userId);
        } else {
            for (var deviceId in devices) {
                if (devices.hasOwnProperty(deviceId)) {
                    var keys = devices[deviceId];
                    var key = keys.keys["curve25519:" + deviceId];
                    if (key == this._olmDevice.deviceCurve25519Key) {
                        continue;
                    }
                    if (!this._sessionStore.getEndToEndSessions(key)) {
                        devicesWithoutSession.push([userId, deviceId, key]);
                    }
                }
            }
        }
    }

    if (devicesWithoutSession.length === 0) {
        return q({
            missingUsers: userWithoutDevices,
            missingDevices: []
        });
    }

    var self = this;
    return this._baseApis.claimOneTimeKeys(
        devicesWithoutSession
    ).then(function(res) {
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
                var sid = self._olmDevice.createOutboundSession(
                    device[2], oneTimeKey
                );
                console.log("Started new sessionid " + sid +
                            " for device " + device[2]);
            } else {
                missing[device[0]] = missing[device[0]] || [];
                missing[device[0]].push([device[1]]);
            }
        }

        return {
            missingUsers: userWithoutDevices,
            missingDevices: missing
        };
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
    return alg.decryptEvent(event);
};

/**
 * @see module:crypto-algorithms/base.DecryptionError
 */
Crypto.DecryptionError = algorithms.DecryptionError;


/** */
module.exports = Crypto;
