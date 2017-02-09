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
 * Defines m.olm encryption/decryption
 *
 * @module crypto/algorithms/megolm
 */

const q = require("q");

const utils = require("../../utils");
const olmlib = require("../olmlib");
const base = require("./base");

/**
 * @private
 * @constructor
 *
 * @param {string} sessionId
 *
 * @property {string} sessionId
 * @property {Number} useCount     number of times this session has been used
 * @property {Number} creationTime when the session was created (ms since the epoch)
 *
 * @property {object} sharedWithDevices
 *    devices with which we have shared the session key
 *        userId -> {deviceId -> msgindex}
 */
function OutboundSessionInfo(sessionId) {
    this.sessionId = sessionId;
    this.useCount = 0;
    this.creationTime = new Date().getTime();
    this.sharedWithDevices = {};
}


/**
 * Check if it's time to rotate the session
 *
 * @param {Number} rotationPeriodMsgs
 * @param {Number} rotationPeriodMs
 * @return {Boolean}
 */
OutboundSessionInfo.prototype.needsRotation = function(
    rotationPeriodMsgs, rotationPeriodMs,
) {
    const sessionLifetime = new Date().getTime() - this.creationTime;

    if (this.useCount >= rotationPeriodMsgs ||
        sessionLifetime >= rotationPeriodMs
       ) {
        console.log(
            "Rotating megolm session after " + this.useCount +
                " messages, " + sessionLifetime + "ms",
        );
        return true;
    }

    return false;
};


/**
 * Determine if this session has been shared with devices which it shouldn't
 * have been.
 *
 * @param {Object} devicesInRoom userId -> {deviceId -> object}
 *   devices we should shared the session with.
 *
 * @return {Boolean} true if we have shared the session with devices which aren't
 * in devicesInRoom.
 */
OutboundSessionInfo.prototype.sharedWithTooManyDevices = function(
    devicesInRoom,
) {
    for (const userId in this.sharedWithDevices) {
        if (!this.sharedWithDevices.hasOwnProperty(userId)) {
            continue;
        }

        if (!devicesInRoom.hasOwnProperty(userId)) {
            console.log("Starting new session because we shared with " + userId);
            return true;
        }

        for (const deviceId in this.sharedWithDevices[userId]) {
            if (!this.sharedWithDevices[userId].hasOwnProperty(deviceId)) {
                continue;
            }

            if (!devicesInRoom[userId].hasOwnProperty(deviceId)) {
                console.log(
                    "Starting new session because we shared with " +
                        userId + ":" + deviceId,
                );
                return true;
            }
        }
    }
};


/**
 * Megolm encryption implementation
 *
 * @constructor
 * @extends {module:crypto/algorithms/base.EncryptionAlgorithm}
 *
 * @param {object} params parameters, as per
 *     {@link module:crypto/algorithms/base.EncryptionAlgorithm}
 */
function MegolmEncryption(params) {
    base.EncryptionAlgorithm.call(this, params);

    // the most recent attempt to set up a session. This is used to serialise
    // the session setups, so that we have a race-free view of which session we
    // are using, and which devices we have shared the keys with. It resolves
    // with an OutboundSessionInfo (or undefined, for the first message in the
    // room).
    this._setupPromise = q();

    // default rotation periods
    this._sessionRotationPeriodMsgs = 100;
    this._sessionRotationPeriodMs = 7 * 24 * 3600 * 1000;

    if (params.config.rotation_period_ms !== undefined) {
        this._sessionRotationPeriodMs = params.config.rotation_period_ms;
    }

    if (params.config.rotation_period_msgs !== undefined) {
        this._sessionRotationPeriodMsgs = params.config.rotation_period_msgs;
    }
}
utils.inherits(MegolmEncryption, base.EncryptionAlgorithm);

/**
 * @private
 *
 * @param {Object} devicesInRoom The devices in this room, indexed by user ID
 *
 * @return {module:client.Promise} Promise which resolves to the
 *    OutboundSessionInfo when setup is complete.
 */
MegolmEncryption.prototype._ensureOutboundSession = function(devicesInRoom) {
    const self = this;

    let session;

    // takes the previous OutboundSessionInfo, and considers whether to create
    // a new one. Also shares the key with any (new) devices in the room.
    // Updates `session` to hold the final OutboundSessionInfo.
    //
    // returns a promise which resolves once the keyshare is successful.
    function prepareSession(oldSession) {
        session = oldSession;

        // need to make a brand new session?
        if (session && session.needsRotation(self._sessionRotationPeriodMsgs,
                                             self._sessionRotationPeriodMs)
           ) {
            console.log("Starting new megolm session because we need to rotate.");
            session = null;
        }

        // determine if we have shared with anyone we shouldn't have
        if (session && session.sharedWithTooManyDevices(devicesInRoom)) {
            session = null;
        }

        if (!session) {
            session = self._prepareNewSession();
        }

        // now check if we need to share with any devices
        const shareMap = {};

        for (const userId in devicesInRoom) {
            if (!devicesInRoom.hasOwnProperty(userId)) {
                continue;
            }

            const userDevices = devicesInRoom[userId];

            for (const deviceId in userDevices) {
                if (!userDevices.hasOwnProperty(deviceId)) {
                    continue;
                }

                const deviceInfo = userDevices[deviceId];

                const key = deviceInfo.getIdentityKey();
                if (key == self._olmDevice.deviceCurve25519Key) {
                    // don't bother sending to ourself
                    continue;
                }

                if (
                    !session.sharedWithDevices[userId] ||
                        session.sharedWithDevices[userId][deviceId] === undefined
                ) {
                    shareMap[userId] = shareMap[userId] || [];
                    shareMap[userId].push(deviceInfo);
                }
            }
        }

        return self._shareKeyWithDevices(
            session, shareMap,
        );
    }

    // helper which returns the session prepared by prepareSession
    function returnSession() {
        return session;
    }

    // first wait for the previous share to complete
    const prom = this._setupPromise.then(prepareSession);

    // _setupPromise resolves to `session` whether or not the share succeeds
    this._setupPromise = prom.then(returnSession, returnSession);

    // but we return a promise which only resolves if the share was successful.
    return prom.then(returnSession);
};

/**
 * @private
 *
 * @return {module:crypto/algorithms/megolm.OutboundSessionInfo} session
 */
MegolmEncryption.prototype._prepareNewSession = function() {
    const session_id = this._olmDevice.createOutboundGroupSession();
    const key = this._olmDevice.getOutboundGroupSessionKey(session_id);

    this._olmDevice.addInboundGroupSession(
        this._roomId, this._olmDevice.deviceCurve25519Key, session_id,
        key.key, {ed25519: this._olmDevice.deviceEd25519Key},
    );

    return new OutboundSessionInfo(session_id);
};

/**
 * @private
 *
 * @param {module:crypto/algorithms/megolm.OutboundSessionInfo} session
 *
 * @param {object<string, module:crypto/deviceinfo[]>} devicesByUser
 *    map from userid to list of devices
 *
 * @return {module:client.Promise} Promise which resolves once the key sharing
 *     message has been sent.
 */
MegolmEncryption.prototype._shareKeyWithDevices = function(session, devicesByUser) {
    const self = this;

    const key = this._olmDevice.getOutboundGroupSessionKey(session.sessionId);
    const payload = {
        type: "m.room_key",
        content: {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            room_id: this._roomId,
            session_id: session.sessionId,
            session_key: key.key,
            chain_index: key.chain_index,
        },
    };

    const contentMap = {};

    return olmlib.ensureOlmSessionsForDevices(
        this._olmDevice, this._baseApis, devicesByUser,
    ).then(function(devicemap) {
        let haveTargets = false;

        for (const userId in devicesByUser) {
            if (!devicesByUser.hasOwnProperty(userId)) {
                continue;
            }

            const devicesToShareWith = devicesByUser[userId];
            const sessionResults = devicemap[userId];

            for (let i = 0; i < devicesToShareWith.length; i++) {
                const deviceInfo = devicesToShareWith[i];
                const deviceId = deviceInfo.deviceId;

                const sessionResult = sessionResults[deviceId];
                if (!sessionResult.sessionId) {
                    // no session with this device, probably because there
                    // were no one-time keys.
                    //
                    // we could send them a to_device message anyway, as a
                    // signal that they have missed out on the key sharing
                    // message because of the lack of keys, but there's not
                    // much point in that really; it will mostly serve to clog
                    // up to_device inboxes.
                    //
                    // ensureOlmSessionsForUsers has already done the logging,
                    // so just skip it.
                    continue;
                }

                console.log(
                    "sharing keys with device " + userId + ":" + deviceId,
                );

                const encryptedContent = {
                    algorithm: olmlib.OLM_ALGORITHM,
                    sender_key: self._olmDevice.deviceCurve25519Key,
                    ciphertext: {},
                };

                olmlib.encryptMessageForDevice(
                    encryptedContent.ciphertext,
                    self._userId,
                    self._deviceId,
                    self._olmDevice,
                    userId,
                    deviceInfo,
                    payload,
                );

                if (!contentMap[userId]) {
                    contentMap[userId] = {};
                }

                contentMap[userId][deviceId] = encryptedContent;
                haveTargets = true;
            }
        }

        if (!haveTargets) {
            return q();
        }

        // TODO: retries
        return self._baseApis.sendToDevice("m.room.encrypted", contentMap);
    }).then(function() {
        // Add the devices we have shared with to session.sharedWithDevices.
        //
        // we deliberately iterate over devicesByUser (ie, the devices we
        // attempted to share with) rather than the contentMap (those we did
        // share with), because we don't want to try to claim a one-time-key
        // for dead devices on every message.
        for (const userId in devicesByUser) {
            if (!devicesByUser.hasOwnProperty(userId)) {
                continue;
            }
            if (!session.sharedWithDevices[userId]) {
                session.sharedWithDevices[userId] = {};
            }
            const devicesToShareWith = devicesByUser[userId];
            for (let i = 0; i < devicesToShareWith.length; i++) {
                const deviceInfo = devicesToShareWith[i];
                session.sharedWithDevices[userId][deviceInfo.deviceId] =
                    key.chain_index;
            }
        }
    });
};

/**
 * @inheritdoc
 *
 * @param {module:models/room} room
 * @param {string} eventType
 * @param {object} content plaintext event content
 *
 * @return {module:client.Promise} Promise which resolves to the new event body
 */
MegolmEncryption.prototype.encryptMessage = function(room, eventType, content) {
    const self = this;
    return this._getDevicesInRoom(room).then(function(devicesInRoom) {
        // check if any of these devices are not yet known to the user.
        // if so, warn the user so they can verify or ignore.
        self._checkForUnknownDevices(devicesInRoom);

        return self._ensureOutboundSession(devicesInRoom);
    }).then(function(session) {
        const payloadJson = {
            room_id: self._roomId,
            type: eventType,
            content: content,
        };

        const ciphertext = self._olmDevice.encryptGroupMessage(
            session.sessionId, JSON.stringify(payloadJson),
        );

        const encryptedContent = {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            sender_key: self._olmDevice.deviceCurve25519Key,
            ciphertext: ciphertext,
            session_id: session.sessionId,
             // Include our device ID so that recipients can send us a
             // m.new_device message if they don't have our session key.
            device_id: self._deviceId,
        };

        session.useCount++;
        return encryptedContent;
    });
};

/**
 * Checks the devices we're about to send to and see if any are entirely
 * unknown to the user.  If so, warn the user, and mark them as known to
 * give the user a chance to go verify them before re-sending this message.
 *
 * @param {Object} devicesInRoom userId -> {deviceId -> object}
 *   devices we should shared the session with.
 */
MegolmEncryption.prototype._checkForUnknownDevices = function(devicesInRoom) {
    const unknownDevices = {};

    Object.keys(devicesInRoom).forEach((userId)=>{
        Object.keys(devicesInRoom[userId]).forEach((deviceId)=>{
            const device = devicesInRoom[userId][deviceId];
            if (device.isUnverified() && !device.isKnown()) {
                if (!unknownDevices[userId]) {
                    unknownDevices[userId] = {};
                }
                unknownDevices[userId][deviceId] = device;
            }
        });
    });

    if (Object.keys(unknownDevices).length) {
        // it'd be kind to pass unknownDevices up to the user in this error
        throw new base.UnknownDeviceError(
            "This room contains unknown devices which have not been verified. " +
            "We strongly recommend you verify them before continuing.", unknownDevices);
    }
};

/**
 * Get the list of unblocked devices for all users in the room
 *
 * @param {module:models/room} room
 *
 * @return {module:client.Promise} Promise which resolves to a map
 *     from userId to deviceId to deviceInfo
 */
MegolmEncryption.prototype._getDevicesInRoom = function(room) {
    // XXX what about rooms where invitees can see the content?
    const roomMembers = utils.map(room.getJoinedMembers(), function(u) {
        return u.userId;
    });

    // We are happy to use a cached version here: we assume that if we already
    // have a list of the user's devices, then we already share an e2e room
    // with them, which means that they will have announced any new devices via
    // an m.new_device.
    //
    // XXX: what if the cache is stale, and the user left the room we had in
    // common and then added new devices before joining this one? --Matthew
    //
    // yup, see https://github.com/vector-im/riot-web/issues/2305 --richvdh
    return this._crypto.downloadKeys(roomMembers, false).then((devices) => {
        // remove any blocked devices
        for (const userId in devices) {
            if (!devices.hasOwnProperty(userId)) {
                continue;
            }

            const userDevices = devices[userId];
            for (const deviceId in userDevices) {
                if (!userDevices.hasOwnProperty(deviceId)) {
                    continue;
                }

                if (userDevices[deviceId].isBlocked() ||
                    (userDevices[deviceId].isUnverified() &&
                     (room.getBlacklistUnverifiedDevices() ||
                      this._crypto.getGlobalBlacklistUnverifiedDevices()))
                   ) {
                    delete userDevices[deviceId];
                }
            }
        }

        return devices;
    });
};

/**
 * Megolm decryption implementation
 *
 * @constructor
 * @extends {module:crypto/algorithms/base.DecryptionAlgorithm}
 *
 * @param {object} params parameters, as per
 *     {@link module:crypto/algorithms/base.DecryptionAlgorithm}
 */
function MegolmDecryption(params) {
    base.DecryptionAlgorithm.call(this, params);

    // events which we couldn't decrypt due to unknown sessions / indexes: map from
    // senderKey|sessionId to list of MatrixEvents
    this._pendingEvents = {};
}
utils.inherits(MegolmDecryption, base.DecryptionAlgorithm);

/**
 * @inheritdoc
 *
 * @param {MatrixEvent} event
 *
 * @throws {module:crypto/algorithms/base.DecryptionError} if there is a
 *   problem decrypting the event
 */
MegolmDecryption.prototype.decryptEvent = function(event) {
    const content = event.getWireContent();

    if (!content.sender_key || !content.session_id ||
        !content.ciphertext
       ) {
        throw new base.DecryptionError("Missing fields in input");
    }

    let res;
    try {
        res = this._olmDevice.decryptGroupMessage(
            event.getRoomId(), content.sender_key, content.session_id, content.ciphertext,
        );
    } catch (e) {
        if (e.message === 'OLM.UNKNOWN_MESSAGE_INDEX') {
            this._addEventToPendingList(event);
        }
        throw new base.DecryptionError(
            e.toString(), {
                session: content.sender_key + '|' + content.session_id,
            },
        );
    }

    if (res === null) {
        // We've got a message for a session we don't have.
        this._addEventToPendingList(event);
        throw new base.DecryptionError(
            "The sender's device has not sent us the keys for this message.",
            {
                session: content.sender_key + '|' + content.session_id,
            },
        );
    }

    const payload = JSON.parse(res.result);

    // belt-and-braces check that the room id matches that indicated by the HS
    // (this is somewhat redundant, since the megolm session is scoped to the
    // room, so neither the sender nor a MITM can lie about the room_id).
    if (payload.room_id !== event.getRoomId()) {
        throw new base.DecryptionError(
            "Message intended for room " + payload.room_id,
        );
    }

    event.setClearData(payload, res.keysProved, res.keysClaimed);
};


/**
 * Add an event to the list of those we couldn't decrypt the first time we
 * saw them.
 *
 * @private
 *
 * @param {module:models/event.MatrixEvent} event
 */
MegolmDecryption.prototype._addEventToPendingList = function(event) {
    const content = event.getWireContent();
    const k = content.sender_key + "|" + content.session_id;
    if (!this._pendingEvents[k]) {
        this._pendingEvents[k] = [];
    }
    this._pendingEvents[k].push(event);
};

/**
 * @inheritdoc
 *
 * @param {module:models/event.MatrixEvent} event key event
 */
MegolmDecryption.prototype.onRoomKeyEvent = function(event) {
    const content = event.getContent();
    const senderKey = event.getSenderKey();
    const sessionId = content.session_id;

    if (!content.room_id ||
        !sessionId ||
        !content.session_key ||
        !senderKey
       ) {
        console.error(`key event is missing fields`);
        return;
    }

    console.log(`Adding key for megolm session ${senderKey}|${sessionId}`);
    this._olmDevice.addInboundGroupSession(
        content.room_id, senderKey, sessionId,
        content.session_key, event.getKeysClaimed(),
    );

    // have another go at decrypting events sent with this session.
    this._retryDecryption(senderKey, sessionId);
};


/**
 * @inheritdoc
 *
 * @param {module:crypto/OlmDevice.MegolmSessionData} session
 */
MegolmDecryption.prototype.importRoomKey = function(session) {
    this._olmDevice.importInboundGroupSession(session);

    // have another go at decrypting events sent with this session.
    this._retryDecryption(session.sender_key, session.session_id);
};

/**
 * Have another go at decrypting events after we receive a key
 *
 * @private
 * @param {String} senderKey
 * @param {String} sessionId
 */
MegolmDecryption.prototype._retryDecryption = function(senderKey, sessionId) {
    const k = senderKey + "|" + sessionId;
    const pending = this._pendingEvents[k];
    if (!pending) {
        return;
    }

    delete this._pendingEvents[k];

    for (let i = 0; i < pending.length; i++) {
        try {
            this.decryptEvent(pending[i]);
            console.log("successful re-decryption of", pending[i]);
        } catch (e) {
            console.log("Still can't decrypt", pending[i], e.stack || e);
        }
    }
};

base.registerAlgorithm(
    olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption,
);
