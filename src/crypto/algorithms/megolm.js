/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2018 New Vector Ltd

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

import Promise from 'bluebird';

const logger = require("../../logger");
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
        logger.log(
            "Rotating megolm session after " + this.useCount +
                " messages, " + sessionLifetime + "ms",
        );
        return true;
    }

    return false;
};

OutboundSessionInfo.prototype.markSharedWithDevice = function(
    userId, deviceId, chainIndex,
) {
    if (!this.sharedWithDevices[userId]) {
        this.sharedWithDevices[userId] = {};
    }
    this.sharedWithDevices[userId][deviceId] = chainIndex;
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
            logger.log("Starting new session because we shared with " + userId);
            return true;
        }

        for (const deviceId in this.sharedWithDevices[userId]) {
            if (!this.sharedWithDevices[userId].hasOwnProperty(deviceId)) {
                continue;
            }

            if (!devicesInRoom[userId].hasOwnProperty(deviceId)) {
                logger.log(
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
    this._setupPromise = Promise.resolve();

    // Map of outbound sessions by sessions ID. Used if we need a particular
    // session (the session we're currently using to send is always obtained
    // using _setupPromise).
    this._outboundSessions = {};

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
    async function prepareSession(oldSession) {
        session = oldSession;

        // need to make a brand new session?
        if (session && session.needsRotation(self._sessionRotationPeriodMsgs,
                                             self._sessionRotationPeriodMs)
           ) {
            logger.log("Starting new megolm session because we need to rotate.");
            session = null;
        }

        // determine if we have shared with anyone we shouldn't have
        if (session && session.sharedWithTooManyDevices(devicesInRoom)) {
            session = null;
        }

        if (!session) {
            logger.log(`Starting new megolm session for room ${self._roomId}`);
            session = await self._prepareNewSession();
            self._outboundSessions[session.sessionId] = session;
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
MegolmEncryption.prototype._prepareNewSession = async function() {
    const sessionId = this._olmDevice.createOutboundGroupSession();
    const key = this._olmDevice.getOutboundGroupSessionKey(sessionId);

    await this._olmDevice.addInboundGroupSession(
        this._roomId, this._olmDevice.deviceCurve25519Key, [], sessionId,
        key.key, {ed25519: this._olmDevice.deviceEd25519Key},
    );

    if (this._crypto.backupInfo) {
        // don't wait for it to complete
        this._crypto.backupGroupSession(
            this._roomId, this._olmDevice.deviceCurve25519Key, [],
            sessionId, key.key,
        ).catch((e) => {
            // This throws if the upload failed, but this is fine
            // since it will have written it to the db and will retry.
            console.log("Failed to back up group session", e);
        });
    }

    return new OutboundSessionInfo(sessionId);
};

/**
 * @private
 *
 * @param {module:crypto/algorithms/megolm.OutboundSessionInfo} session
 *
 * @param {number} chainIndex current chain index
 *
 * @param {object<userId, deviceId>} devicemap
 *   mapping from userId to deviceId to {@link module:crypto~OlmSessionResult}
 *
 * @param {object<string, module:crypto/deviceinfo[]>} devicesByUser
 *    map from userid to list of devices
 *
 * @return {array<object<userid, deviceInfo>>}
 */
MegolmEncryption.prototype._splitUserDeviceMap = function(
    session, chainIndex, devicemap, devicesByUser,
) {
    const maxToDeviceMessagesPerRequest = 20;

    // use an array where the slices of a content map gets stored
    const mapSlices = [];
    let currentSliceId = 0; // start inserting in the first slice
    let entriesInCurrentSlice = 0;

    for (const userId of Object.keys(devicesByUser)) {
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

                // mark this device as "handled" because we don't want to try
                // to claim a one-time-key for dead devices on every message.
                session.markSharedWithDevice(userId, deviceId, chainIndex);

                // ensureOlmSessionsForUsers has already done the logging,
                // so just skip it.
                continue;
            }

            logger.log(
                "share keys with device " + userId + ":" + deviceId,
            );

            if (entriesInCurrentSlice > maxToDeviceMessagesPerRequest) {
                // the current slice is filled up. Start inserting into the next slice
                entriesInCurrentSlice = 0;
                currentSliceId++;
            }
            if (!mapSlices[currentSliceId]) {
                mapSlices[currentSliceId] = [];
            }

            mapSlices[currentSliceId].push({
                userId: userId,
                deviceInfo: deviceInfo,
            });

            entriesInCurrentSlice++;
        }
    }
    return mapSlices;
};

/**
 * @private
 *
 * @param {module:crypto/algorithms/megolm.OutboundSessionInfo} session
 *
 * @param {number} chainIndex current chain index
 *
 * @param {object<userId, deviceInfo>} userDeviceMap
 *   mapping from userId to deviceInfo
 *
 * @param {object} payload fields to include in the encrypted payload
 *
 * @return {module:client.Promise} Promise which resolves once the key sharing
 *     for the given userDeviceMap is generated and has been sent.
 */
MegolmEncryption.prototype._encryptAndSendKeysToDevices = function(
    session, chainIndex, userDeviceMap, payload,
) {
    const encryptedContent = {
        algorithm: olmlib.OLM_ALGORITHM,
        sender_key: this._olmDevice.deviceCurve25519Key,
        ciphertext: {},
    };
    const contentMap = {};

    const promises = [];
    for (let i = 0; i < userDeviceMap.length; i++) {
        const val = userDeviceMap[i];
        const userId = val.userId;
        const deviceInfo = val.deviceInfo;
        const deviceId = deviceInfo.deviceId;

        if (!contentMap[userId]) {
            contentMap[userId] = {};
        }
        contentMap[userId][deviceId] = encryptedContent;

        promises.push(
            olmlib.encryptMessageForDevice(
                encryptedContent.ciphertext,
                this._userId,
                this._deviceId,
                this._olmDevice,
                userId,
                deviceInfo,
                payload,
            ),
        );
    }

    return Promise.all(promises).then(() => {
        return this._baseApis.sendToDevice("m.room.encrypted", contentMap).then(() => {
            // store that we successfully uploaded the keys of the current slice
            for (const userId of Object.keys(contentMap)) {
                for (const deviceId of Object.keys(contentMap[userId])) {
                    session.markSharedWithDevice(
                        userId, deviceId, chainIndex,
                    );
                }
            }
        });
    });
};

/**
 * Re-shares a megolm session key with devices if the key has already been
 * sent to them.
 *
 * @param {string} senderKey The key of the originating device for the session
 * @param {string} sessionId ID of the outbound session to share
 * @param {string} userId ID of the user who owns the target device
 * @param {module:crypto/deviceinfo} device The target device
 */
MegolmEncryption.prototype.reshareKeyWithDevice = async function(
    senderKey, sessionId, userId, device,
) {
    const obSessionInfo = this._outboundSessions[sessionId];
    if (!obSessionInfo) {
        logger.debug("Session ID " + sessionId + " not found: not re-sharing keys");
        return;
    }

    // The chain index of the key we previously sent this device
    if (obSessionInfo.sharedWithDevices[userId] === undefined) {
        logger.debug("Session ID " + sessionId + " never shared with user " + userId);
        return;
    }
    const sentChainIndex = obSessionInfo.sharedWithDevices[userId][device.deviceId];
    if (sentChainIndex === undefined) {
        logger.debug(
            "Session ID " + sessionId + " never shared with device " +
            userId + ":" + device.deviceId,
        );
        return;
    }

    // get the key from the inbound session: the outbound one will already
    // have been ratcheted to the next chain index.
    const key = await this._olmDevice.getInboundGroupSessionKey(
        this._roomId, senderKey, sessionId, sentChainIndex,
    );

    if (!key) {
        logger.warn(
            "No outbound session key found for " + sessionId + ": not re-sharing keys",
        );
        return;
    }

    await olmlib.ensureOlmSessionsForDevices(
        this._olmDevice, this._baseApis, {
            [userId]: {
                [device.deviceId]: device,
            },
        },
    );

    const payload = {
        type: "m.forwarded_room_key",
        content: {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            room_id: this._roomId,
            session_id: sessionId,
            session_key: key.key,
            chain_index: key.chain_index,
            sender_key: senderKey,
            sender_claimed_ed25519_key: key.sender_claimed_ed25519_key,
            forwarding_curve25519_key_chain: key.forwarding_curve25519_key_chain,
        },
    };

    const encryptedContent = {
        algorithm: olmlib.OLM_ALGORITHM,
        sender_key: this._olmDevice.deviceCurve25519Key,
        ciphertext: {},
    };
    await olmlib.encryptMessageForDevice(
        encryptedContent.ciphertext,
        this._userId,
        this._deviceId,
        this._olmDevice,
        userId,
        device,
        payload,
    ),

    await this._baseApis.sendToDevice("m.room.encrypted", {
        [userId]: {
            [device.deviceId]: encryptedContent,
        },
    });
    logger.debug(
        `Re-shared key for session ${sessionId}  with ${userId}:${device.deviceId}`,
    );
};

/**
 * @param {module:crypto/algorithms/megolm.OutboundSessionInfo} session
 *
 * @param {object<string, module:crypto/deviceinfo[]>} devicesByUser
 *    map from userid to list of devices
 */
MegolmEncryption.prototype._shareKeyWithDevices = async function(session, devicesByUser) {
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

    const devicemap = await olmlib.ensureOlmSessionsForDevices(
        this._olmDevice, this._baseApis, devicesByUser,
    );

    const userDeviceMaps = this._splitUserDeviceMap(
        session, key.chain_index, devicemap, devicesByUser,
    );

    for (let i = 0; i < userDeviceMaps.length; i++) {
        try {
            await this._encryptAndSendKeysToDevices(
                session, key.chain_index, userDeviceMaps[i], payload,
            );
            logger.log(`Completed megolm keyshare in ${this._roomId} `
                + `(slice ${i + 1}/${userDeviceMaps.length})`);
        } catch (e) {
            logger.log(`megolm keyshare in ${this._roomId} `
                + `(slice ${i + 1}/${userDeviceMaps.length}) failed`);

            throw e;
        }
    }
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
    logger.log(`Starting to encrypt event for ${this._roomId}`);

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
             // XXX: Do we still need this now that m.new_device messages
             // no longer exist since #483?
            device_id: self._deviceId,
        };

        session.useCount++;
        return encryptedContent;
    });
};

/**
 * Forces the current outbound group session to be discarded such
 * that another one will be created next time an event is sent.
 *
 * This should not normally be necessary.
 */
MegolmEncryption.prototype.forceDiscardSession = function() {
    this._setupPromise = this._setupPromise.then(() => null);
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
MegolmEncryption.prototype._getDevicesInRoom = async function(room) {
    const members = await room.getEncryptionTargetMembers();
    const roomMembers = utils.map(members, function(u) {
        return u.userId;
    });

    // The global value is treated as a default for when rooms don't specify a value.
    let isBlacklisting = this._crypto.getGlobalBlacklistUnverifiedDevices();
    if (typeof room.getBlacklistUnverifiedDevices() === 'boolean') {
        isBlacklisting = room.getBlacklistUnverifiedDevices();
    }

    // We are happy to use a cached version here: we assume that if we already
    // have a list of the user's devices, then we already share an e2e room
    // with them, which means that they will have announced any new devices via
    // device_lists in their /sync response.  This cache should then be maintained
    // using all the device_lists changes and left fields.
    // See https://github.com/vector-im/riot-web/issues/2305 for details.
    const devices = await this._crypto.downloadKeys(roomMembers, false);
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
                (userDevices[deviceId].isUnverified() && isBlacklisting)
               ) {
                delete userDevices[deviceId];
            }
        }
    }

    return devices;
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
    // senderKey|sessionId to Set of MatrixEvents
    this._pendingEvents = {};

    // this gets stubbed out by the unit tests.
    this.olmlib = olmlib;
}
utils.inherits(MegolmDecryption, base.DecryptionAlgorithm);

/**
 * @inheritdoc
 *
 * @param {MatrixEvent} event
 *
 * returns a promise which resolves to a
 * {@link module:crypto~EventDecryptionResult} once we have finished
 * decrypting, or rejects with an `algorithms.DecryptionError` if there is a
 * problem decrypting the event.
 */
MegolmDecryption.prototype.decryptEvent = async function(event) {
    const content = event.getWireContent();

    if (!content.sender_key || !content.session_id ||
        !content.ciphertext
       ) {
        throw new base.DecryptionError(
            "MEGOLM_MISSING_FIELDS",
            "Missing fields in input",
        );
    }

    // we add the event to the pending list *before* we start decryption.
    //
    // then, if the key turns up while decryption is in progress (and
    // decryption fails), we will schedule a retry.
    // (fixes https://github.com/vector-im/riot-web/issues/5001)
    this._addEventToPendingList(event);

    let res;
    try {
        res = await this._olmDevice.decryptGroupMessage(
            event.getRoomId(), content.sender_key, content.session_id, content.ciphertext,
            event.getId(), event.getTs(),
        );
    } catch (e) {
        let errorCode = "OLM_DECRYPT_GROUP_MESSAGE_ERROR";

        if (e.message === 'OLM.UNKNOWN_MESSAGE_INDEX') {
            this._requestKeysForEvent(event);

            errorCode = 'OLM_UNKNOWN_MESSAGE_INDEX';
        }

        throw new base.DecryptionError(
            errorCode,
            e.toString(), {
                session: content.sender_key + '|' + content.session_id,
            },
        );
    }

    if (res === null) {
        // We've got a message for a session we don't have.
        //
        // (XXX: We might actually have received this key since we started
        // decrypting, in which case we'll have scheduled a retry, and this
        // request will be redundant. We could probably check to see if the
        // event is still in the pending list; if not, a retry will have been
        // scheduled, so we needn't send out the request here.)
        this._requestKeysForEvent(event);
        throw new base.DecryptionError(
            "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
            "The sender's device has not sent us the keys for this message.",
            {
                session: content.sender_key + '|' + content.session_id,
            },
        );
    }

    // success. We can remove the event from the pending list, if that hasn't
    // already happened.
    this._removeEventFromPendingList(event);

    const payload = JSON.parse(res.result);

    // belt-and-braces check that the room id matches that indicated by the HS
    // (this is somewhat redundant, since the megolm session is scoped to the
    // room, so neither the sender nor a MITM can lie about the room_id).
    if (payload.room_id !== event.getRoomId()) {
        throw new base.DecryptionError(
            "MEGOLM_BAD_ROOM",
            "Message intended for room " + payload.room_id,
        );
    }

    return {
        clearEvent: payload,
        senderCurve25519Key: res.senderKey,
        claimedEd25519Key: res.keysClaimed.ed25519,
        forwardingCurve25519KeyChain: res.forwardingCurve25519KeyChain,
    };
};

MegolmDecryption.prototype._requestKeysForEvent = function(event) {
    const sender = event.getSender();
    const wireContent = event.getWireContent();

    // send the request to all of our own devices, and the
    // original sending device if it wasn't us.
    const recipients = [{
        userId: this._userId, deviceId: '*',
    }];
    if (sender != this._userId) {
        recipients.push({
            userId: sender, deviceId: wireContent.device_id,
        });
    }

    this._crypto.requestRoomKey({
        room_id: event.getRoomId(),
        algorithm: wireContent.algorithm,
        sender_key: wireContent.sender_key,
        session_id: wireContent.session_id,
    }, recipients);
};

/**
 * Add an event to the list of those awaiting their session keys.
 *
 * @private
 *
 * @param {module:models/event.MatrixEvent} event
 */
MegolmDecryption.prototype._addEventToPendingList = function(event) {
    const content = event.getWireContent();
    const k = content.sender_key + "|" + content.session_id;
    if (!this._pendingEvents[k]) {
        this._pendingEvents[k] = new Set();
    }
    this._pendingEvents[k].add(event);
};

/**
 * Remove an event from the list of those awaiting their session keys.
 *
 * @private
 *
 * @param {module:models/event.MatrixEvent} event
 */
MegolmDecryption.prototype._removeEventFromPendingList = function(event) {
    const content = event.getWireContent();
    const k = content.sender_key + "|" + content.session_id;
    if (!this._pendingEvents[k]) {
        return;
    }

    this._pendingEvents[k].delete(event);
    if (this._pendingEvents[k].size === 0) {
        delete this._pendingEvents[k];
    }
};


/**
 * @inheritdoc
 *
 * @param {module:models/event.MatrixEvent} event key event
 */
MegolmDecryption.prototype.onRoomKeyEvent = function(event) {
    const content = event.getContent();
    const sessionId = content.session_id;
    let senderKey = event.getSenderKey();
    let forwardingKeyChain = [];
    let exportFormat = false;
    let keysClaimed;

    if (!content.room_id ||
        !sessionId ||
        !content.session_key
       ) {
        logger.error("key event is missing fields");
        return;
    }

    if (!senderKey) {
        logger.error("key event has no sender key (not encrypted?)");
        return;
    }

    if (event.getType() == "m.forwarded_room_key") {
        exportFormat = true;
        forwardingKeyChain = content.forwarding_curve25519_key_chain;
        if (!utils.isArray(forwardingKeyChain)) {
            forwardingKeyChain = [];
        }

        // copy content before we modify it
        forwardingKeyChain = forwardingKeyChain.slice();
        forwardingKeyChain.push(senderKey);

        senderKey = content.sender_key;
        if (!senderKey) {
            logger.error("forwarded_room_key event is missing sender_key field");
            return;
        }

        const ed25519Key = content.sender_claimed_ed25519_key;
        if (!ed25519Key) {
            logger.error(
                `forwarded_room_key_event is missing sender_claimed_ed25519_key field`,
            );
            return;
        }

        keysClaimed = {
            ed25519: ed25519Key,
        };
    } else {
        keysClaimed = event.getKeysClaimed();
    }

    logger.log(`Adding key for megolm session ${senderKey}|${sessionId}`);
    return this._olmDevice.addInboundGroupSession(
        content.room_id, senderKey, forwardingKeyChain, sessionId,
        content.session_key, keysClaimed,
        exportFormat,
    ).then(() => {
        // cancel any outstanding room key requests for this session
        this._crypto.cancelRoomKeyRequest({
            algorithm: content.algorithm,
            room_id: content.room_id,
            session_id: content.session_id,
            sender_key: senderKey,
        });

        // have another go at decrypting events sent with this session.
        this._retryDecryption(senderKey, sessionId);
    }).then(() => {
        if (this._crypto.backupInfo) {
            // don't wait for the keys to be backed up for the server
            this._crypto.backupGroupSession(
                content.room_id, senderKey, forwardingKeyChain,
                content.session_id, content.session_key, keysClaimed,
                exportFormat,
            ).catch((e) => {
                // This throws if the upload failed, but this is fine
                // since it will have written it to the db and will retry.
                console.log("Failed to back up group session", e);
            });
        }
    }).catch((e) => {
        logger.error(`Error handling m.room_key_event: ${e}`);
    });
};

/**
 * @inheritdoc
 */
MegolmDecryption.prototype.hasKeysForKeyRequest = function(keyRequest) {
    const body = keyRequest.requestBody;

    return this._olmDevice.hasInboundSessionKeys(
        body.room_id,
        body.sender_key,
        body.session_id,
        // TODO: ratchet index
    );
};

/**
 * @inheritdoc
 */
MegolmDecryption.prototype.shareKeysWithDevice = function(keyRequest) {
    const userId = keyRequest.userId;
    const deviceId = keyRequest.deviceId;
    const deviceInfo = this._crypto.getStoredDevice(userId, deviceId);
    const body = keyRequest.requestBody;

    this.olmlib.ensureOlmSessionsForDevices(
        this._olmDevice, this._baseApis, {
            [userId]: [deviceInfo],
        },
    ).then((devicemap) => {
        const olmSessionResult = devicemap[userId][deviceId];
        if (!olmSessionResult.sessionId) {
            // no session with this device, probably because there
            // were no one-time keys.
            //
            // ensureOlmSessionsForUsers has already done the logging,
            // so just skip it.
            return null;
        }

        logger.log(
            "sharing keys for session " + body.sender_key + "|"
            + body.session_id + " with device "
            + userId + ":" + deviceId,
        );

        return this._buildKeyForwardingMessage(
            body.room_id, body.sender_key, body.session_id,
        );
    }).then((payload) => {
        const encryptedContent = {
            algorithm: olmlib.OLM_ALGORITHM,
            sender_key: this._olmDevice.deviceCurve25519Key,
            ciphertext: {},
        };

        return this.olmlib.encryptMessageForDevice(
            encryptedContent.ciphertext,
            this._userId,
            this._deviceId,
            this._olmDevice,
            userId,
            deviceInfo,
            payload,
        ).then(() => {
            const contentMap = {
                [userId]: {
                    [deviceId]: encryptedContent,
                },
            };

            // TODO: retries
            return this._baseApis.sendToDevice("m.room.encrypted", contentMap);
        });
    }).done();
};

MegolmDecryption.prototype._buildKeyForwardingMessage = async function(
    roomId, senderKey, sessionId,
) {
    const key = await this._olmDevice.getInboundGroupSessionKey(
        roomId, senderKey, sessionId,
    );

    return {
        type: "m.forwarded_room_key",
        content: {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            room_id: roomId,
            sender_key: senderKey,
            sender_claimed_ed25519_key: key.sender_claimed_ed25519_key,
            session_id: sessionId,
            session_key: key.key,
            chain_index: key.chain_index,
            forwarding_curve25519_key_chain: key.forwarding_curve25519_key_chain,
        },
    };
};

/**
 * @inheritdoc
 *
 * @param {module:crypto/OlmDevice.MegolmSessionData} session
 */
MegolmDecryption.prototype.importRoomKey = function(session) {
    return this._olmDevice.addInboundGroupSession(
        session.room_id,
        session.sender_key,
        session.forwarding_curve25519_key_chain,
        session.session_id,
        session.session_key,
        session.sender_claimed_keys,
        true,
    ).then(() => {
        if (this._crypto.backupInfo) {
            // don't wait for it to complete
            this._crypto.backupGroupSession(
                session.room_id,
                session.sender_key,
                session.forwarding_curve25519_key_chain,
                session.session_id,
                session.session_key,
                session.sender_claimed_keys,
                true,
            ).catch((e) => {
                // This throws if the upload failed, but this is fine
                // since it will have written it to the db and will retry.
                console.log("Failed to back up group session", e);
            });
        }
        // have another go at decrypting events sent with this session.
        this._retryDecryption(session.sender_key, session.session_id);
    });
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

    for (const ev of pending) {
        ev.attemptDecryption(this._crypto);
    }
};

base.registerAlgorithm(
    olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption,
);
