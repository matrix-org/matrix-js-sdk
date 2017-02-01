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

const anotherjson = require('another-json');
const q = require("q");

const utils = require("../utils");
const OlmDevice = require("./OlmDevice");
const olmlib = require("./olmlib");
const algorithms = require("./algorithms");
const DeviceInfo = require("./deviceinfo");
const DeviceVerification = DeviceInfo.DeviceVerification;
const DeviceList = require('./DeviceList').default;

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
 *
 * @param {Object} clientStore the MatrixClient data store.
 */
function Crypto(baseApis, eventEmitter, sessionStore, userId, deviceId,
                clientStore) {
    this._baseApis = baseApis;
    this._sessionStore = sessionStore;
    this._userId = userId;
    this._deviceId = deviceId;
    this._clientStore = clientStore;

    this._olmDevice = new OlmDevice(sessionStore);
    this._deviceList = new DeviceList(baseApis, sessionStore, this._olmDevice);

    // EncryptionAlgorithm instance for each room
    this._roomEncryptors = {};

    // map from algorithm to DecryptionAlgorithm instance, for each room
    this._roomDecryptors = {};

    this._supportedAlgorithms = utils.keys(
        algorithms.DECRYPTION_CLASSES,
    );

    // build our device keys: these will later be uploaded
    this._deviceKeys = {};
    this._deviceKeys["ed25519:" + this._deviceId] =
        this._olmDevice.deviceEd25519Key;
    this._deviceKeys["curve25519:" + this._deviceId] =
        this._olmDevice.deviceCurve25519Key;

    let myDevices = this._sessionStore.getEndToEndDevicesForUser(
        this._userId,
    );

    if (!myDevices) {
        // we don't yet have a list of our own devices; make sure we
        // get one when we flush the pendingUsersWithNewDevices.
        this._deviceList.invalidateUserDeviceList(this._userId);
        myDevices = {};
    }

    if (!myDevices[this._deviceId]) {
        // add our own deviceinfo to the sessionstore
        const deviceInfo = {
            keys: this._deviceKeys,
            algorithms: this._supportedAlgorithms,
            verified: DeviceVerification.VERIFIED,
            known: true,
        };

        myDevices[this._deviceId] = deviceInfo;
        this._sessionStore.storeEndToEndDevicesForUser(
            this._userId, myDevices,
        );
    }

    _registerEventHandlers(this, eventEmitter);
}

function _registerEventHandlers(crypto, eventEmitter) {
    eventEmitter.on("sync", function(syncState, oldState, data) {
        try {
            if (syncState === "SYNCING") {
                crypto._onSyncCompleted(data);
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
    const self = this;
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
        const keyCount = res.one_time_key_counts.signed_curve25519 || 0;
        // We then check how many keys we can store in the Account object.
        const maxOneTimeKeys = self._olmDevice.maxNumberOfOneTimeKeys();
        // Try to keep at most half that number on the server. This leaves the
        // rest of the slots free to hold keys that have been claimed from the
        // server but we haven't recevied a message for.
        // If we run out of slots when generating new keys then olm will
        // discard the oldest private keys first. This will eventually clean
        // out stale private keys that won't receive a message.
        const keyLimit = Math.floor(maxOneTimeKeys / 2);
        // We work out how many new keys we need to create to top up the server
        // If there are too many keys on the server then we don't need to
        // create any more keys.
        let numberToGenerate = Math.max(keyLimit - keyCount, 0);
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
    const userId = crypto._userId;
    const deviceId = crypto._deviceId;

    const deviceKeys = {
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
    const oneTimeKeys = crypto._olmDevice.getOneTimeKeys();
    const oneTimeJson = {};

    for (const keyId in oneTimeKeys.curve25519) {
        if (oneTimeKeys.curve25519.hasOwnProperty(keyId)) {
            const k = {
                key: oneTimeKeys.curve25519[keyId],
            };
            crypto._signObject(k);
            oneTimeJson["signed_curve25519:" + keyId] = k;
        }
    }

    return crypto._baseApis.uploadKeysRequest({
        one_time_keys: oneTimeJson,
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
    return this._deviceList.downloadKeys(userIds, forceDownload);
};

/**
 * Get the stored device keys for a user id
 *
 * @param {string} userId the user to list keys for.
 *
 * @return {module:crypto/deviceinfo[]|null} list of devices, or null if we haven't
 * managed to get a list of devices for this user yet.
 */
Crypto.prototype.getStoredDevicesForUser = function(userId) {
    return this._deviceList.getStoredDevicesForUser(userId);
};

/**
 * Get the stored keys for a single device
 *
 * @param {string} userId
 * @param {string} deviceId
 *
 * @return {module:crypto/deviceinfo?} device, or undefined
 * if we don't know about this device
 */
Crypto.prototype.getStoredDevice = function(userId, deviceId) {
    return this._deviceList.getStoredDevice(userId, deviceId);
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
    const devices = this.getStoredDevicesForUser(userId) || [];

    const result = [];

    for (let i = 0; i < devices.length; ++i) {
        const device = devices[i];
        const ed25519Key = device.getFingerprint();
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
        if (a.deviceId < b.deviceId) {
            return -1;
        }
        if (a.deviceId > b.deviceId) {
            return 1;
        }
        return 0;
    });

    return result;
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
 *
 * @param {?boolean} known whether to mark that the user has been made aware of
 *      the existence of this device. Null to leave unchanged
 */
Crypto.prototype.setDeviceVerification = function(userId, deviceId, verified,
                                                  blocked, known) {
    const devices = this._sessionStore.getEndToEndDevicesForUser(userId);
    if (!devices || !devices[deviceId]) {
        throw new Error("Unknown device " + userId + ":" + deviceId);
    }

    const dev = devices[deviceId];
    let verificationStatus = dev.verified;

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

    let knownStatus = dev.known;
    if (known !== null && known !== undefined) {
        knownStatus = known;
    }

    if (dev.verified === verificationStatus && dev.known === knownStatus) {
        return;
    }
    dev.verified = verificationStatus;
    dev.known = knownStatus;
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
    const devices = this.getStoredDevicesForUser(userId) || [];
    const result = {};
    for (let j = 0; j < devices.length; ++j) {
        const device = devices[j];
        const deviceKey = device.getIdentityKey();
        const sessions = this._olmDevice.getSessionInfoForDevice(deviceKey);

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
    const sender_key = event.getSenderKey();
    const algorithm = event.getWireContent().algorithm;

    if (!sender_key || !algorithm) {
        return null;
    }

    // sender_key is the Curve25519 identity key of the device which the event
    // was sent from. In the case of Megolm, it's actually the Curve25519
    // identity key of the device which set up the Megolm session.

    const device = this._deviceList.getDeviceByIdentityKey(
        event.getSender(), algorithm, sender_key,
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

    const claimedKey = event.getKeysClaimed().ed25519;
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
    const existingConfig = this._sessionStore.getEndToEndRoom(roomId);
    if (existingConfig) {
        if (JSON.stringify(existingConfig) != JSON.stringify(config)) {
            console.error("Ignoring m.room.encryption event which requests " +
                          "a change of config in " + roomId);
            return;
        }
    }

    const AlgClass = algorithms.ENCRYPTION_CLASSES[config.algorithm];
    if (!AlgClass) {
        throw new Error("Unable to encrypt with " + config.algorithm);
    }

    this._sessionStore.storeEndToEndRoom(roomId, config);

    const alg = new AlgClass({
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
    const devicesByUser = {};

    for (let i = 0; i < users.length; ++i) {
        const userId = users[i];
        devicesByUser[userId] = [];

        const devices = this.getStoredDevicesForUser(userId) || [];
        for (let j = 0; j < devices.length; ++j) {
            const deviceInfo = devices[j];

            const key = deviceInfo.getIdentityKey();
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
        this._olmDevice, this._baseApis, devicesByUser,
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
 * Get a list containing all of the room keys
 *
 * @return {module:client.Promise} a promise which resolves to a list of
 *    session export objects
 */
Crypto.prototype.exportRoomKeys = function() {
    return q(
        this._sessionStore.getAllEndToEndInboundGroupSessionKeys().map(
            (s) => {
                const sess = this._olmDevice.exportInboundGroupSession(
                    s.senderKey, s.sessionId,
                );

                sess.algorithm = olmlib.MEGOLM_ALGORITHM;
                return sess;
            },
        ),
    );
};

/**
 * Import a list of room keys previously exported by exportRoomKeys
 *
 * @param {Object[]} keys a list of session export objects
 */
Crypto.prototype.importRoomKeys = function(keys) {
    keys.map((session) => {
        if (!session.room_id || !session.algorithm) {
            console.warn("ignoring session entry with missing fields", session);
            return;
        }

        const alg = this._getRoomDecryptor(session.room_id, session.algorithm);
        alg.importRoomKey(session);
    });
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

    const roomId = event.getRoomId();

    const alg = this._roomEncryptors[roomId];
    if (!alg) {
        // not encrypting messages in this room

        // check that the HS hasn't hidden the crypto event
        if (this._sessionStore.getEndToEndRoom(roomId)) {
            throw new Error(
                "Room was previously configured to use encryption, but is " +
                "no longer. Perhaps the homeserver is hiding the " +
                "configuration event.",
            );
        }
        return null;
    }

    // We can claim and prove ownership of all our device keys in the local
    // echo of the event since we know that all the local echos come from
    // this device.
    const myKeys = {
        curve25519: this._olmDevice.deviceCurve25519Key,
        ed25519: this._olmDevice.deviceEd25519Key,
    };

    return alg.encryptMessage(
        room, event.getType(), event.getContent(),
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
    const content = event.getWireContent();
    const alg = this._getRoomDecryptor(event.getRoomId(), content.algorithm);
    alg.decryptEvent(event);
};

/**
 * Handle the notification from /sync that a user has updated their device list.
 *
 * @param {String} userId
 */
Crypto.prototype.userDeviceListChanged = function(userId) {
    this._deviceList.invalidateUserDeviceList(userId);

    // don't flush the outdated device list yet - we do it once we finish
    // processing the sync.
};

/**
 * handle an m.room.encryption event
 *
 * @private
 * @param {module:models/event.MatrixEvent} event encryption event
 */
Crypto.prototype._onCryptoEvent = function(event) {
    const roomId = event.getRoomId();
    const content = event.getContent();

    try {
        this.setRoomEncryption(roomId, content);
    } catch (e) {
        console.error("Error configuring encryption in room " + roomId +
                      ":", e);
    }
};

/**
 * handle the completion of a /sync
 *
 * This is called after the processing of each successful /sync response.
 * It is an opportunity to do a batch process on the information received.
 *
 * @param {Object} syncData  the data from the 'MatrixClient.sync' event
 */
Crypto.prototype._onSyncCompleted = function(syncData) {
    this._deviceList.lastKnownSyncToken = syncData.nextSyncToken;

    if (!syncData.oldSyncToken) {
        // an initialsync.
        this._sendNewDeviceEvents();

        // if we have a deviceSyncToken, we can tell the deviceList to
        // invalidate devices which have changed since then.
        const oldSyncToken = this._sessionStore.getEndToEndDeviceSyncToken();
        if (oldSyncToken) {
            this._invalidateDeviceListsSince(oldSyncToken).catch((e) => {
                // if that failed, we fall back to invalidating everyone.
                console.warn("Error fetching changed device list", e);
                this._invalidateDeviceListForAllActiveUsers();
                return this._deviceList.flushNewDeviceRequests();
            }).done();
        } else {
            // otherwise, we have to invalidate all devices for all users we
            // share a room with.
            this._invalidateDeviceListForAllActiveUsers();
        }
    }

    // catch up on any new devices we got told about during the sync.
    this._deviceList.refreshOutdatedDeviceLists().done();
};

/**
 * Send m.new_device messages to any devices we share a room with.
 *
 * (TODO: we can get rid of this once a suitable number of homeservers and
 * clients support the more reliable device list update stream mechanism)
 *
 * @private
 */
Crypto.prototype._sendNewDeviceEvents = function() {
    if (this._sessionStore.getDeviceAnnounced()) {
        return;
    }

    // we need to tell all the devices in all the rooms we are members of that
    // we have arrived.
    // build a list of rooms for each user.
    const roomsByUser = {};
    for (const room of this._getE2eRooms()) {
        const members = room.getJoinedMembers();
        for (let j = 0; j < members.length; j++) {
            const m = members[j];
            if (!roomsByUser[m.userId]) {
                roomsByUser[m.userId] = [];
            }
            roomsByUser[m.userId].push(room.roomId);
        }
    }

    // build a per-device message for each user
    const content = {};
    for (const userId in roomsByUser) {
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

    const self = this;
    this._baseApis.sendToDevice(
        "m.new_device", // OH HAI!
        content,
    ).done(function() {
        self._sessionStore.setDeviceAnnounced();
    });
};

/**
 * Ask the server which users have new devices since a given token,
 * invalidate them, and start an update query.
 *
 * @param {String} oldSyncToken
 *
 * @returns {Promise} resolves once the query is complete. Rejects if the
 *   keyChange query fails.
 */
Crypto.prototype._invalidateDeviceListsSince = function(oldSyncToken) {
    return this._baseApis.getKeyChanges(
        oldSyncToken, this.lastKnownSyncToken,
    ).then((r) => {
        if (!r.changed || !Array.isArray(r.changed)) {
            return;
        }

        // only invalidate users we share an e2e room with - we don't
        // care about users in non-e2e rooms.
        const filteredUserIds = this._getE2eRoomMembers();
        r.changed.forEach((u) => {
            if (u in filteredUserIds) {
                this._deviceList.invalidateUserDeviceList(u);
            }
        });
        return this._deviceList.flushNewDeviceRequests();
    });
};

/**
 * Invalidate any stored device list for any users we share an e2e room with
 *
 * @private
 */
Crypto.prototype._invalidateDeviceListForAllActiveUsers = function() {
    Object.keys(this._getE2eRoomMembers()).forEach((m) => {
        this._deviceList.invalidateUserDeviceList(m);
    });
};

/**
 * get the users we share an e2e-enabled room with
 *
 * @returns {Object<string>} userid->userid map (should be a Set but argh ES6)
 */
Crypto.prototype._getE2eRoomMembers = function() {
    const userIds = Object.create(null);

    const rooms = this._getE2eRooms();
    for (const r of rooms) {
        const members = r.getJoinedMembers();
        members.forEach((m) => { userIds[m.userId] = m.userId; });
    }

    return userIds;
};

/**
 * Get a list of the e2e-enabled rooms we are members of
 *
 * @returns {module:models.Room[]}
 */
Crypto.prototype._getE2eRooms = function() {
    return this._clientStore.getRooms().filter((room) => {
        // check for rooms with encryption enabled
        const alg = this._roomEncryptors[room.roomId];
        if (!alg) {
            return false;
        }

        // ignore any rooms which we have left
        const me = room.getMember(this._userId);
        if (!me || (
            me.membership !== "join" && me.membership !== "invite"
        )) {
            return false;
        }

        return true;
    });
};

/**
 * Handle a key event
 *
 * @private
 * @param {module:models/event.MatrixEvent} event key event
 */
Crypto.prototype._onRoomKeyEvent = function(event) {
    const content = event.getContent();

    if (!content.room_id || !content.algorithm) {
        console.error("key event is missing fields");
        return;
    }

    const alg = this._getRoomDecryptor(content.room_id, content.algorithm);
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

    const roomId = member.roomId;

    const alg = this._roomEncryptors[roomId];
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
    const content = event.getContent();
    const userId = event.getSender();
    const deviceId = content.device_id;
    const rooms = content.rooms;

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

    this._deviceList.invalidateUserDeviceList(userId);
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
    let decryptors;
    let alg;

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

    const AlgClass = algorithms.DECRYPTION_CLASSES[algorithm];
    if (!AlgClass) {
        throw new algorithms.DecryptionError(
            'Unknown encryption algorithm "' + algorithm + '".',
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
    const sigs = {};
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
