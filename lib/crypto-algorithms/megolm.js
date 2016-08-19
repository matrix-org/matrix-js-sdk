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
 * @return {module:client.Promise} Promise which resolves when setup is
 *   complete.
 */
MegolmEncryption.prototype._ensureOutboundSession = function() {
    if (this._prepPromise) {
        // prep already in progress
        return this._prepPromise;
    }

    if (this._outboundSessionId) {
        // prep already done
        return q();
    }

    var session_id = this._olmDevice.createOutboundGroupSession();
    this._outboundSessionId = session_id;

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

    var self = this;
    // TODO: initiate key-sharing
    this._prepPromise = q.delay(3000).then(function() {
        console.log("woop woop, we totally shared the keys");
        self._prepPromise = null;
    });
    return this._prepPromise;
};


/**
 * @inheritdoc
 *
 * @param {module:models/room?} room
 * @param {string} eventType
 * @param {object} plaintext event content
 *
 * @return {module:client.Promise} Promise which resolves to the new event body
 */
MegolmEncryption.prototype.encryptMessage = function(room, eventType, content) {
    var self = this;
    return this._ensureOutboundSession().then(function() {
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
