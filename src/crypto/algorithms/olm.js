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
 * Defines m.olm encryption/decryption
 *
 * @module crypto/algorithms/olm
 */
import Promise from 'bluebird';

const logger = require("../../logger");
const utils = require("../../utils");
const olmlib = require("../olmlib");
const DeviceInfo = require("../deviceinfo");
const DeviceVerification = DeviceInfo.DeviceVerification;


const base = require("./base");

/**
 * Olm encryption implementation
 *
 * @constructor
 * @extends {module:crypto/algorithms/base.EncryptionAlgorithm}
 *
 * @param {object} params parameters, as per
 *     {@link module:crypto/algorithms/base.EncryptionAlgorithm}
 */
function OlmEncryption(params) {
    base.EncryptionAlgorithm.call(this, params);
    this._sessionPrepared = false;
    this._prepPromise = null;
}
utils.inherits(OlmEncryption, base.EncryptionAlgorithm);

/**
 * @private

 * @param {string[]} roomMembers list of currently-joined users in the room
 * @return {module:client.Promise} Promise which resolves when setup is complete
 */
OlmEncryption.prototype._ensureSession = function(roomMembers) {
    if (this._prepPromise) {
        // prep already in progress
        return this._prepPromise;
    }

    if (this._sessionPrepared) {
        // prep already done
        return Promise.resolve();
    }

    const self = this;
    this._prepPromise = self._crypto.downloadKeys(roomMembers).then(function(res) {
        return self._crypto.ensureOlmSessionsForUsers(roomMembers);
    }).then(function() {
        self._sessionPrepared = true;
    }).finally(function() {
        self._prepPromise = null;
    });
    return this._prepPromise;
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
OlmEncryption.prototype.encryptMessage = async function(room, eventType, content) {
    // pick the list of recipients based on the membership list.
    //
    // TODO: there is a race condition here! What if a new user turns up
    // just as you are sending a secret message?

    const members = await room.getEncryptionTargetMembers();

    const users = utils.map(members, function(u) {
        return u.userId;
    });

    const self = this;
    await this._ensureSession(users);

    const payloadFields = {
        room_id: room.roomId,
        type: eventType,
        content: content,
    };

    const encryptedContent = {
        algorithm: olmlib.OLM_ALGORITHM,
        sender_key: self._olmDevice.deviceCurve25519Key,
        ciphertext: {},
    };

    const promises = [];

    for (let i = 0; i < users.length; ++i) {
        const userId = users[i];
        const devices = self._crypto.getStoredDevicesForUser(userId);

        for (let j = 0; j < devices.length; ++j) {
            const deviceInfo = devices[j];
            const key = deviceInfo.getIdentityKey();
            if (key == self._olmDevice.deviceCurve25519Key) {
                // don't bother sending to ourself
                continue;
            }
            if (deviceInfo.verified == DeviceVerification.BLOCKED) {
                // don't bother setting up sessions with blocked users
                continue;
            }

            promises.push(
                olmlib.encryptMessageForDevice(
                    encryptedContent.ciphertext,
                    self._userId, self._deviceId, self._olmDevice,
                    userId, deviceInfo, payloadFields,
                ),
            );
        }
    }

    return await Promise.all(promises).return(encryptedContent);
};

/**
 * Olm decryption implementation
 *
 * @constructor
 * @extends {module:crypto/algorithms/base.DecryptionAlgorithm}
 * @param {object} params parameters, as per
 *     {@link module:crypto/algorithms/base.DecryptionAlgorithm}
 */
function OlmDecryption(params) {
    base.DecryptionAlgorithm.call(this, params);
}
utils.inherits(OlmDecryption, base.DecryptionAlgorithm);

/**
 * @inheritdoc
 *
 * @param {MatrixEvent} event
 *
 * returns a promise which resolves to a
 * {@link module:crypto~EventDecryptionResult} once we have finished
 * decrypting. Rejects with an `algorithms.DecryptionError` if there is a
 * problem decrypting the event.
 */
OlmDecryption.prototype.decryptEvent = async function(event) {
    const content = event.getWireContent();
    const deviceKey = content.sender_key;
    const ciphertext = content.ciphertext;

    if (!ciphertext) {
        throw new base.DecryptionError(
            "OLM_MISSING_CIPHERTEXT",
            "Missing ciphertext",
        );
    }

    if (!(this._olmDevice.deviceCurve25519Key in ciphertext)) {
        throw new base.DecryptionError(
            "OLM_NOT_INCLUDED_IN_RECIPIENTS",
            "Not included in recipients",
        );
    }
    const message = ciphertext[this._olmDevice.deviceCurve25519Key];
    let payloadString;

    try {
        payloadString = await this._decryptMessage(deviceKey, message);
    } catch (e) {
        throw new base.DecryptionError(
            "OLM_BAD_ENCRYPTED_MESSAGE",
            "Bad Encrypted Message", {
                sender: deviceKey,
                err: e,
            },
        );
    }

    const payload = JSON.parse(payloadString);

    // check that we were the intended recipient, to avoid unknown-key attack
    // https://github.com/vector-im/vector-web/issues/2483
    if (payload.recipient != this._userId) {
        throw new base.DecryptionError(
            "OLM_BAD_RECIPIENT",
            "Message was intented for " + payload.recipient,
        );
    }

    if (payload.recipient_keys.ed25519 != this._olmDevice.deviceEd25519Key) {
        throw new base.DecryptionError(
            "OLM_BAD_RECIPIENT_KEY",
            "Message not intended for this device", {
                intended: payload.recipient_keys.ed25519,
                our_key: this._olmDevice.deviceEd25519Key,
            },
        );
    }

    // check that the original sender matches what the homeserver told us, to
    // avoid people masquerading as others.
    // (this check is also provided via the sender's embedded ed25519 key,
    // which is checked elsewhere).
    if (payload.sender != event.getSender()) {
        throw new base.DecryptionError(
            "OLM_FORWARDED_MESSAGE",
            "Message forwarded from " + payload.sender, {
                reported_sender: event.getSender(),
            },
        );
    }

    // Olm events intended for a room have a room_id.
    if (payload.room_id !== event.getRoomId()) {
        throw new base.DecryptionError(
            "OLM_BAD_ROOM",
            "Message intended for room " + payload.room_id, {
                reported_room: event.room_id,
            },
        );
    }

    const claimedKeys = payload.keys || {};

    return {
        clearEvent: payload,
        senderCurve25519Key: deviceKey,
        claimedEd25519Key: claimedKeys.ed25519 || null,
    };
};

/**
 * Attempt to decrypt an Olm message
 *
 * @param {string} theirDeviceIdentityKey  Curve25519 identity key of the sender
 * @param {object} message  message object, with 'type' and 'body' fields
 *
 * @return {string} payload, if decrypted successfully.
 */
OlmDecryption.prototype._decryptMessage = async function(
    theirDeviceIdentityKey, message,
) {
    const sessionIds = await this._olmDevice.getSessionIdsForDevice(
        theirDeviceIdentityKey,
    );

    // try each session in turn.
    const decryptionErrors = {};
    for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i];
        try {
            const payload = await this._olmDevice.decryptMessage(
                theirDeviceIdentityKey, sessionId, message.type, message.body,
            );
            logger.log(
                "Decrypted Olm message from " + theirDeviceIdentityKey +
                    " with session " + sessionId,
            );
            return payload;
        } catch (e) {
            const foundSession = await this._olmDevice.matchesSession(
                theirDeviceIdentityKey, sessionId, message.type, message.body,
            );

            if (foundSession) {
                // decryption failed, but it was a prekey message matching this
                // session, so it should have worked.
                throw new Error(
                    "Error decrypting prekey message with existing session id " +
                        sessionId + ": " + e.message,
                );
            }

            // otherwise it's probably a message for another session; carry on, but
            // keep a record of the error
            decryptionErrors[sessionId] = e.message;
        }
    }

    if (message.type !== 0) {
        // not a prekey message, so it should have matched an existing session, but it
        // didn't work.

        if (sessionIds.length === 0) {
            throw new Error("No existing sessions");
        }

        throw new Error(
            "Error decrypting non-prekey message with existing sessions: " +
                JSON.stringify(decryptionErrors),
        );
    }

    // prekey message which doesn't match any existing sessions: make a new
    // session.

    let res;
    try {
        res = await this._olmDevice.createInboundSession(
            theirDeviceIdentityKey, message.type, message.body,
        );
    } catch (e) {
        decryptionErrors["(new)"] = e.message;
        throw new Error(
            "Error decrypting prekey message: " +
                JSON.stringify(decryptionErrors),
        );
    }

    logger.log(
        "created new inbound Olm session ID " +
            res.session_id + " with " + theirDeviceIdentityKey,
    );
    return res.payload;
};


base.registerAlgorithm(olmlib.OLM_ALGORITHM, OlmEncryption, OlmDecryption);
