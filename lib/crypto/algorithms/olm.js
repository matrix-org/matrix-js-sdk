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
var q = require('q');

var utils = require("../../utils");
var olmlib = require("../olmlib");
var DeviceInfo = require("../deviceinfo");
var DeviceVerification = DeviceInfo.DeviceVerification;


var base = require("./base");

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
        return q();
    }

    var self = this;
    this._prepPromise = self._crypto.downloadKeys(roomMembers, true).then(function(res) {
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
 * @param {object} plaintext event content
 *
 * @return {module:client.Promise} Promise which resolves to the new event body
 */
OlmEncryption.prototype.encryptMessage = function(room, eventType, content) {
    // pick the list of recipients based on the membership list.
    //
    // TODO: there is a race condition here! What if a new user turns up
    // just as you are sending a secret message?

    var users = utils.map(room.getJoinedMembers(), function(u) {
        return u.userId;
    });

    var self = this;
    return this._ensureSession(users).then(function() {
        var payloadFields = {
            room_id: room.roomId,
            type: eventType,
            content: content,
        };

        var encryptedContent = {
            algorithm: olmlib.OLM_ALGORITHM,
            sender_key: self._olmDevice.deviceCurve25519Key,
            ciphertext: {},
        };

        for (var i = 0; i < users.length; ++i) {
            var userId = users[i];
            var devices = self._crypto.getStoredDevicesForUser(userId);

            for (var j = 0; j < devices.length; ++j) {
                var deviceInfo = devices[j];
                var key = deviceInfo.getIdentityKey();
                if (key == self._olmDevice.deviceCurve25519Key) {
                    // don't bother sending to ourself
                    continue;
                }
                if (deviceInfo.verified == DeviceVerification.BLOCKED) {
                    // don't bother setting up sessions with blocked users
                    continue;
                }

                olmlib.encryptMessageForDevice(
                    encryptedContent.ciphertext,
                    self._userId, self._deviceId, self._olmDevice,
                    userId, deviceInfo, payloadFields
                );
            }
        }

        return encryptedContent;
    });
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
 * @throws {module:crypto/algorithms/base.DecryptionError} if there is a
 *   problem decrypting the event
 */
OlmDecryption.prototype.decryptEvent = function(event) {
    var content = event.getWireContent();
    var deviceKey = content.sender_key;
    var ciphertext = content.ciphertext;

    if (!ciphertext) {
        throw new base.DecryptionError("Missing ciphertext");
    }

    if (!(this._olmDevice.deviceCurve25519Key in ciphertext)) {
        throw new base.DecryptionError("Not included in recipients");
    }
    var message = ciphertext[this._olmDevice.deviceCurve25519Key];
    var payloadString;

    try {
        payloadString = this._decryptMessage(deviceKey, message);
    } catch (e) {
        console.warn(
            "Failed to decrypt Olm event (id=" +
                event.getId() + ") from " + deviceKey +
                ": " + e.message
        );
        throw new base.DecryptionError("Bad Encrypted Message");
    }

    var payload = JSON.parse(payloadString);

    // check that we were the intended recipient, to avoid unknown-key attack
    // https://github.com/vector-im/vector-web/issues/2483
    if (payload.recipient != this._userId) {
        console.warn(
            "Event " + event.getId() + ": Intended recipient " +
            payload.recipient + " does not match our id " + this._userId
        );
        throw new base.DecryptionError(
            "Message was intented for " + payload.recipient
        );
    }

    if (payload.recipient_keys.ed25519 !=
               this._olmDevice.deviceEd25519Key) {
        console.warn(
            "Event " + event.getId() + ": Intended recipient ed25519 key " +
            payload.recipient_keys.ed25519 + " did not match ours"
        );
        throw new base.DecryptionError("Message not intended for this device");
    }

    // check that the original sender matches what the homeserver told us, to
    // avoid people masquerading as others.
    // (this check is also provided via the sender's embedded ed25519 key,
    // which is checked elsewhere).
    if (payload.sender != event.getSender()) {
        console.warn(
            "Event " + event.getId() + ": original sender " + payload.sender +
            " does not match reported sender " + event.getSender()
        );
        throw new base.DecryptionError(
            "Message forwarded from " + payload.sender
        );
    }

    // Olm events intended for a room have a room_id.
    if (payload.room_id !== event.getRoomId()) {
        console.warn(
            "Event " + event.getId() + ": original room " + payload.room_id +
            " does not match reported room " + event.room_id
        );
        throw new base.DecryptionError(
            "Message intended for room " + payload.room_id
        );
    }

    event.setClearData(payload, {curve25519: deviceKey}, payload.keys || {});
};


/**
 * Attempt to decrypt an Olm message
 *
 * @param {string} theirDeviceIdentityKey  Curve25519 identity key of the sender
 * @param {object} message  message object, with 'type' and 'body' fields
 *
 * @return {string} payload, if decrypted successfully.
 */
OlmDecryption.prototype._decryptMessage = function(theirDeviceIdentityKey, message) {
    var sessionIds = this._olmDevice.getSessionIdsForDevice(theirDeviceIdentityKey);

    // try each session in turn.
    var decryptionErrors = {};
    for (var i = 0; i < sessionIds.length; i++) {
        var sessionId = sessionIds[i];
        try {
            var payload = this._olmDevice.decryptMessage(
                theirDeviceIdentityKey, sessionId, message.type, message.body
            );
            console.log(
                "Decrypted Olm message from " + theirDeviceIdentityKey +
                    " with session " + sessionId
            );
            return payload;
        } catch (e) {
            var foundSession = this._olmDevice.matchesSession(
                theirDeviceIdentityKey, sessionId, message.type, message.body
            );

            if (foundSession) {
                // decryption failed, but it was a prekey message matching this
                // session, so it should have worked.
                throw new Error(
                    "Error decrypting prekey message with existing session id " +
                        sessionId + ": " + e.message
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
                JSON.stringify(decryptionErrors)
        );
    }

    // prekey message which doesn't match any existing sessions: make a new
    // session.

    var res;
    try {
        res = this._olmDevice.createInboundSession(
            theirDeviceIdentityKey, message.type, message.body
        );
    } catch (e) {
        decryptionErrors["(new)"] = e.message;
        throw new Error(
            "Error decrypting prekey message: " +
                JSON.stringify(decryptionErrors)
        );
    }

    console.log(
        "created new inbound Olm session ID " +
            res.session_id + " with " + theirDeviceIdentityKey
    );
    return res.payload;
};


base.registerAlgorithm(olmlib.OLM_ALGORITHM, OlmEncryption, OlmDecryption);
