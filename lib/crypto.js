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
 * Internal module
 *
 * @module crypto
 */

var anotherjson = require('another-json');
var q = require("q");

var utils = require("./utils");
var OlmDevice = require("./OlmDevice");

var OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

var DeviceVerification = {
    VERIFIED: 1,
    UNVERIFIED: 0,
    BLOCKED: -1,
};

/**
  * Stored information about a user's device
  *
  * @typedef {Object} DeviceInfo
  *
  * @property {string[]} altorithms list of algorithms supported by this device
  *
  * @property {Object} keys a map from &lt;key type&gt;:&lt;id&gt; -> key
  *
  * @property {DeviceVerification} verified whether the device has been
  *     verified by the user
  *
  * @property {Object} unsigned  additional data from the homeserver
  */

/**
 * Cryptography bits
 *
 * @constructor
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

    this._cryptoAlgorithms = [];

    this._olmDevice = new OlmDevice(sessionStore);
    this._cryptoAlgorithms = [OLM_ALGORITHM];

    // build our device keys: these will later be uploaded
    this._deviceKeys = {};
    this._deviceKeys["ed25519:" + this._deviceId] =
        this._olmDevice.deviceEd25519Key;
    this._deviceKeys["curve25519:" + this._deviceId] =
        this._olmDevice.deviceCurve25519Key;

    // add our own deviceinfo to the sessionstore
    var deviceInfo = {
        keys: this._deviceKeys,
        algorithms: this._cryptoAlgorithms,
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
        algorithms: crypto._cryptoAlgorithms,
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
    var stored = {};
    var downloadUsers = [];

    for (var i = 0; i < userIds.length; ++i) {
        var userId = userIds[i];
        var devices = this._sessionStore.getEndToEndDevicesForUser(userId);

        stored[userId] = devices || {};
        if (devices && !forceDownload) {
            continue;
        }
        downloadUsers.push(userId);
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

            var userStore = stored[userId];
            var updated = _updateStoredDeviceKeysForUser(
                userId, userStore, res.device_keys[userId]
            );

            if (updated) {
                self._sessionStore.storeEndToEndDevicesForUser(
                    userId, userStore
                );
            }
        }
        return stored;
    });
};

function _updateStoredDeviceKeysForUser(userId, userStore, userResult) {
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

        var deviceRes = userResult[deviceId];
        var deviceStore;

        if (!deviceRes.keys) {
            // no keys?
            continue;
        }

        var signKey = deviceRes.keys["ed25519:" + deviceId];
        if (!signKey) {
            console.log("Device " + userId + ": " +
                        deviceId + " has no ed25519 key");
            continue;
        }

        if (deviceId in userStore) {
            // already have this device.
            deviceStore = userStore[deviceId];

            if (deviceStore.keys["ed25519:" + deviceId] != signKey) {
                // this should only happen if the list has been MITMed; we are
                // best off sticking with the original keys.
                //
                // Should we warn the user about it somehow?
                console.warn("Ed25519 key for device" + userId + ": " +
                             deviceId + " has changed");
                continue;
            }
        } else {
            userStore[deviceId] = deviceStore = {
                verified: DeviceVerification.UNVERIFIED
            };
        }

        // TODO: check signature. Remember that we need to check for
        // _olmDevice.

        deviceStore.keys = deviceRes.keys;
        deviceStore.algorithms = deviceRes.algorithms;
        deviceStore.unsigned = deviceRes.unsigned;
        updated = true;
    }

    return updated;
}


/**
 * List the stored device keys for a user id
 *
 * @param {string} userId the user to list keys for.
 *
 * @return {object[]} list of devices with "id", "verified", "blocked",
 *    "key", and "display_name" parameters.
 */
Crypto.prototype.listDeviceKeys = function(userId) {
    var devices = this._sessionStore.getEndToEndDevicesForUser(userId);
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
            var unsigned = device.unsigned || {};
            if (ed25519Key) {
                result.push({
                    id: deviceId,
                    key: ed25519Key,
                    verified: Boolean(device.verified == DeviceVerification.VERIFIED),
                    blocked: Boolean(device.verified == DeviceVerification.BLOCKED),
                    display_name: unsigned.device_display_name,
                });
            }
        }
    }
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
                return device;
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
 * @return {Object} A promise that will resolve when encryption is setup.
 */
Crypto.prototype.setRoomEncryption = function(roomId, config, roomMembers) {
    var self = this;

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

    if (config.algorithm !== OLM_ALGORITHM) {
        throw new Error("Unknown algorithm: " + config.algorithm);
    }

    // remove spurious keys
    config = {
        algorithm: OLM_ALGORITHM,
    };
    this._sessionStore.storeEndToEndRoom(roomId, config);

    return self.downloadKeys(roomMembers, true).then(function(res) {
        return self._ensureOlmSessionsForUsers(roomMembers);
    });
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
 *
 * @private
 */
Crypto.prototype._ensureOlmSessionsForUsers = function(users) {
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
    return (this._sessionStore.getEndToEndRoom(roomId) && true) || false;
};


/**
 * Encrypt an event according to the configuration of the room, if necessary.
 *
 * @param {module:models/event.MatrixEvent} event  event to be sent
 * @param {module:models/room.Room} room  destination room
 */
Crypto.prototype.encryptEventIfNeeded = function(event, room) {
    if (event.isEncrypted()) {
        // this event has already been encrypted; this happens if the
        // encryption step succeeded, but the send step failed on the first
        // attempt.
        return;
    }

    if (event.getType() !== "m.room.message") {
        // we only encrypt m.room.message
        return;
    }

    var roomId = event.getRoomId();

    var e2eRoomInfo = this._sessionStore.getEndToEndRoom(roomId);
    if (!e2eRoomInfo || !e2eRoomInfo.algorithm) {
        // not encrypting messages in this room
        return;
    }

    var encryptedContent = this._encryptMessage(
         room, e2eRoomInfo, event.getType(), event.getContent()
    );
    event.makeEncrypted("m.room.encrypted", encryptedContent);
};

/**
 *
 * @param {module:models/room.Room} room
 * @param {object} e2eRoomInfo
 * @param {string} eventType
 * @param {object} content
 *
 * @return {object} new event body
 *
 * @private
 */
Crypto.prototype._encryptMessage = function(room, e2eRoomInfo, eventType, content) {
    if (e2eRoomInfo.algorithm !== OLM_ALGORITHM) {
        throw new Error("Unknown end-to-end algorithm: " + e2eRoomInfo.algorithm);
    }

    if (!room) {
        throw new Error("Cannot send encrypted messages in unknown rooms");
    }

    // pick the list of recipients based on the membership list.
    //
    // TODO: there is a race condition here! What if a new user turns up
    // just as you are sending a secret message?

    var users = utils.map(room.getJoinedMembers(), function(u) {
        return u.userId;
    });

    var participantKeys = [];
    for (var i = 0; i < users.length; ++i) {
        var userId = users[i];
        var devices = this._sessionStore.getEndToEndDevicesForUser(userId);
        for (var deviceId in devices) {
            if (devices.hasOwnProperty(deviceId)) {
                var dev = devices[deviceId];
                if (dev.verified === DeviceVerification.BLOCKED) {
                    continue;
                }

                for (var keyId in dev.keys) {
                    if (keyId.indexOf("curve25519:") === 0) {
                        participantKeys.push(dev.keys[keyId]);
                    }
                }
            }
        }
    }
    participantKeys.sort();
    var participantHash = ""; // Olm.sha256(participantKeys.join());
    var payloadJson = {
        room_id: room.roomId,
        type: eventType,
        fingerprint: participantHash,
        sender_device: this._deviceId,
        content: content
    };
    var ciphertext = {};
    var payloadString = JSON.stringify(payloadJson);
    for (i = 0; i < participantKeys.length; ++i) {
        var deviceKey = participantKeys[i];
        if (deviceKey == this._olmDevice.deviceCurve25519Key) {
            continue;
        }
        var sessionIds = this._olmDevice.getSessionIdsForDevice(deviceKey);
        // Use the session with the lowest ID.
        sessionIds.sort();
        if (sessionIds.length === 0) {
            // If we don't have a session for a device then
            // we can't encrypt a message for it.
            continue;
        }
        var sessionId = sessionIds[0];
        console.log("Using sessionid " + sessionId + " for device " + deviceKey);
        ciphertext[deviceKey] = this._olmDevice.encryptMessage(
            deviceKey, sessionId, payloadString
        );
    }
    var encryptedContent = {
        algorithm: e2eRoomInfo.algorithm,
        sender_key: this._olmDevice.deviceCurve25519Key,
        ciphertext: ciphertext
    };
    return encryptedContent;
};

function DecryptionError(msg) {
    this.message = msg;
}
utils.inherits(DecryptionError, Error);

/**
 * Exception thrown when decryption fails
 */
Crypto.DecryptionError = DecryptionError;

/**
 * Decrypt a received event
 *
 * @param {object} event raw event
 *
 * @return {object} decrypted payload (with properties 'type', 'content')
 *
 * @raises {DecryptionError} if there is a problem decrypting the event
 */
Crypto.prototype.decryptEvent = function(event) {
    var content = event.content;
    if (content.algorithm !== OLM_ALGORITHM) {
        throw new DecryptionError("Unknown algorithm");
    }

    var deviceKey = content.sender_key;
    var ciphertext = content.ciphertext;

    if (!ciphertext) {
        throw new DecryptionError("Missing ciphertext");
    }

    if (!(this._olmDevice.deviceCurve25519Key in content.ciphertext)) {
        throw new DecryptionError("Not included in recipients");
    }

    var message = content.ciphertext[this._olmDevice.deviceCurve25519Key];
    var sessionIds = this._olmDevice.getSessionIdsForDevice(deviceKey);
    var payloadString = null;
    var foundSession = false;
    for (var i = 0; i < sessionIds.length; i++) {
        var sessionId = sessionIds[i];
        var res = this._olmDevice.decryptMessage(
            deviceKey, sessionId, message.type, message.body
        );
        payloadString = res.payload;
        if (payloadString) {
            console.log("decrypted with sessionId " + sessionId);
            break;
        }

        if (res.matchesInbound) {
            // this was a prekey message which matched this session; don't
            // create a new session.
            foundSession = true;
            break;
        }
    }

    if (message.type === 0 && !foundSession && payloadString === null) {
        try {
            payloadString = this._olmDevice.createInboundSession(
                deviceKey, message.type, message.body
            );
            console.log("created new inbound sesion");
        } catch (e) {
            // Failed to decrypt with a new session.
        }
    }

    // TODO: Check the sender user id matches the sender key.
    if (payloadString !== null) {
        return JSON.parse(payloadString);
    } else {
        throw new DecryptionError("Bad Encrypted Message");
    }
};

/** */
module.exports = Crypto;
