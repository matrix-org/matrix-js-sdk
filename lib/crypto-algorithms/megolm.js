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
 * @module crypto-algorithms/megolm
 */

var q = require("q");

var utils = require("../utils");
var olmlib = require("../olmlib");
var base = require("./base");

/**
 * Megolm encryption implementation
 *
 * @constructor
 * @extends {module:crypto-algorithms/base.EncryptionAlgorithm}
 *
 * @param {object} params parameters, as per
 *     {@link module:crypto-algorithms/base.EncryptionAlgorithm}
 */
function MegolmEncryption(params) {
    base.EncryptionAlgorithm.call(this, params);
    this._prepPromise = null;
    this._outboundSessionId = null;
}
utils.inherits(MegolmEncryption, base.EncryptionAlgorithm);

/**
 * @private
 *
 * @param {module:models/room} room
 *
 * @return {module:client.Promise} Promise which resolves when setup is
 *   complete.
 */
MegolmEncryption.prototype._ensureOutboundSession = function(room) {
    if (this._prepPromise) {
        // prep already in progress
        return this._prepPromise;
    }

    if (this._outboundSessionId) {
        // prep already done
        return q();
    }

    var session_id = this._olmDevice.createOutboundGroupSession();
    var key = this._olmDevice.getOutboundGroupSessionKey(session_id);

    console.log(
        'Created outbound session. Add with window.mxMatrixClientPeg.' +
            'matrixClient._crypto._olmDevice.addInboundGroupSession("' +
            [
                this._roomId, this._olmDevice.deviceCurve25519Key, session_id,
                key.key, key.chain_index
            ].join('", "') +
            '")'
    );

    this._olmDevice.addInboundGroupSession(
        this._roomId, this._olmDevice.deviceCurve25519Key, session_id,
        key.key, key.chain_index
    );

    // send the keys to each (unblocked) device in the room.
    var payload = {
        type: "m.key",
        content: {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            room_id: this._roomId,
            session_id: session_id,
            session_key: key.key,
            chain_index: key.chain_index,
        }
    };

    var roomMembers = utils.map(room.getJoinedMembers(), function(u) {
        return u.userId;
    });

    var self = this;
    var txnBase = '' + (new Date().getTime()) + '.';
    var txnCtr = 0;

    // TODO: we need to give the user a chance to block any devices or users
    // before we send them the keys; it's too late to download them here.
    this._prepPromise = this._crypto.downloadKeys(
        roomMembers, false
    ).then(function(res) {
        return self._crypto.ensureOlmSessionsForUsers(roomMembers);
    }).then(function(devicemap) {
        var promises = [];
        for (var userId in devicemap) {
            if (!devicemap.hasOwnProperty(userId)) {
                continue;
            }

            var devices = devicemap[userId];

            for (var deviceId in devices) {
                if (!devices.hasOwnProperty(deviceId)) {
                    continue;
                }

                var deviceInfo = devices[deviceId].device;
                var encryptedContent = olmlib.encryptMessageForDevices(
                    self._deviceId,
                    self._olmDevice,
                    [deviceInfo.getIdentityKey()],
                    payload
                );

                var txnId = txnBase + (txnCtr++);

                // TODO: send an OOB message. for now, send an in-band message.
                var path = utils.encodeUri(
                    "/rooms/$roomId/send/m.room.encrypted/$txnId", {
                        $roomId: self._roomId,
                        $txnId: txnId,
                    }
                );

                // TODO: retries
                var promise = self._baseApis._http.authedRequest(
                    undefined, "PUT", path, undefined, encryptedContent
                );

                promises.push(promise);
            }
        }
        return q.all(promises);
    }).then(function() {
        // don't set this until the keys are sent successfully; if we get an
        // error, the user can restart by resending the message.
        self._outboundSessionId = session_id;
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
MegolmEncryption.prototype.encryptMessage = function(room, eventType, content) {
    var self = this;
    return this._ensureOutboundSession(room).then(function() {
        var payloadJson = {
            room_id: self._roomId,
            type: eventType,
            content: content
        };

        var ciphertext = self._olmDevice.encryptGroupMessage(
            self._outboundSessionId, JSON.stringify(payloadJson)
        );

        var encryptedContent = {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            sender_key: self._olmDevice.deviceCurve25519Key,
            body: ciphertext,
            session_id: self._outboundSessionId,
            signature: "FIXME",
        };

        return encryptedContent;
    });
};

/**
 * Megolm decryption implementation
 *
 * @constructor
 * @extends {module:crypto-algorithms/base.DecryptionAlgorithm}
 *
 * @param {object} params parameters, as per
 *     {@link module:crypto-algorithms/base.DecryptionAlgorithm}
 */
function MegolmDecryption(params) {
    base.DecryptionAlgorithm.call(this, params);
}
utils.inherits(MegolmDecryption, base.DecryptionAlgorithm);

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
MegolmDecryption.prototype.decryptEvent = function(event) {
    var content = event.content;

    console.log("decrypting " + event.event_id + " with sid " +
                content.session_id);

    if (!content.sender_key || !content.session_id ||
        !content.body || !content.signature
       ) {
        throw new base.DecryptionError("Missing fields in input");
    }

    try {
        var res = this._olmDevice.decryptGroupMessage(
            event.room_id, content.sender_key, content.session_id, content.body
        );
        return JSON.parse(res);
    } catch (e) {
        throw new base.DecryptionError(e);
    }
};

base.registerAlgorithm(
    olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption
);
