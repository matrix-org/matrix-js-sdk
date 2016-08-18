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
var base = require("./base");

var MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

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
    this._outboundSessionId = null;
}
utils.inherits(MegolmEncryption, base.EncryptionAlgorithm);

/**
 * @inheritdoc
 * @param {string[]} roomMembers list of currently-joined users in the room
 * @return {module:client.Promise} Promise which resolves when setup is complete
 */
MegolmEncryption.prototype.initRoomEncryption = function(roomMembers) {
    // nothing to do here.
    return q();
};


/**
 * @private
 */
MegolmEncryption.prototype._ensureOutboundSession = function() {
    if (this._outboundSessionId) {
        return;
    }
    var session_id = this._olmDevice.createOutboundGroupSession();
    this._outboundSessionId = session_id;

    var key = this._olmDevice.getOutboundGroupSessionKey(session_id);

    // TODO: initiate key-sharing

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
};

/**
 * @inheritdoc
 *
 * @param {module:models/room?} room
 * @param {string} eventType
 * @param {object} plaintext event content
 *
 * @return {object} new event body
 */
MegolmEncryption.prototype.encryptMessage = function(room, eventType, content) {
    this._ensureOutboundSession();

    var payloadJson = {
        room_id: this._roomId,
        type: eventType,
        content: content
    };

    var ciphertext = this._olmDevice.encryptGroupMessage(
        this._outboundSessionId, JSON.stringify(payloadJson)
    );

    var encryptedContent = {
        algorithm: MEGOLM_ALGORITHM,
        sender_key: this._olmDevice.deviceCurve25519Key,
        body: ciphertext,
        session_id: this._outboundSessionId,
        signature: "FIXME",
    };

    return encryptedContent;
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

base.registerAlgorithm(MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption);
