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
 * @module crypto-algorithms/olm
 */
var q = require('q');

var utils = require("../utils");
var olmlib = require("../olmlib");
var DeviceInfo = require("../crypto-deviceinfo");
var DeviceVerification = DeviceInfo.DeviceVerification;


var base = require("./base");

/**
 * Olm encryption implementation
 *
 * @constructor
 * @extends {module:crypto-algorithms/base.EncryptionAlgorithm}
 *
 * @param {object} params parameters, as per
 *     {@link module:crypto-algorithms/base.EncryptionAlgorithm}
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
        var participantKeys = [];
        for (var i = 0; i < users.length; ++i) {
            var userId = users[i];
            var devices = self._crypto.getStoredDevicesForUser(userId);
            for (var j = 0; j < devices.length; ++j) {
                var deviceInfo = devices[j];
                var key = deviceInfo.getIdentityKey();
                if (key == self._olmDevice.deviceCurve25519Key) {
                    // don't bother setting up session to ourself
                    continue;
                }
                if (deviceInfo.verified == DeviceVerification.BLOCKED) {
                    // don't bother setting up sessions with blocked users
                    continue;
                }
                participantKeys.push(key);
            }
        }

        return olmlib.encryptMessageForDevices(
            self._deviceId, self._olmDevice, participantKeys, {
                room_id: room.roomId,
                type: eventType,
                content: content,
            }
        );
    });
};

/**
 * Olm decryption implementation
 *
 * @constructor
 * @extends {module:crypto-algorithms/base.DecryptionAlgorithm}
 * @param {object} params parameters, as per
 *     {@link module:crypto-algorithms/base.DecryptionAlgorithm}
 */
function OlmDecryption(params) {
    base.DecryptionAlgorithm.call(this, params);
}
utils.inherits(OlmDecryption, base.DecryptionAlgorithm);

/**
 * @inheritdoc
 *
 * @param {object} event raw event
 *
 * @return {object} decrypted payload (with properties 'type', 'content')
 *
 * @throws {module:crypto-algorithms/base.DecryptionError} if there is a
 *   problem decrypting the event
 */
OlmDecryption.prototype.decryptEvent = function(event) {
    var content = event.content;
    var deviceKey = content.sender_key;
    var ciphertext = content.ciphertext;

    if (!ciphertext) {
        throw new base.DecryptionError("Missing ciphertext");
    }

    if (!(this._olmDevice.deviceCurve25519Key in content.ciphertext)) {
        throw new base.DecryptionError("Not included in recipients");
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
    // TODO: check the room_id and fingerprint
    if (payloadString !== null) {
        return JSON.parse(payloadString);
    } else {
        throw new base.DecryptionError("Bad Encrypted Message");
    }
};

base.registerAlgorithm(olmlib.OLM_ALGORITHM, OlmEncryption, OlmDecryption);
