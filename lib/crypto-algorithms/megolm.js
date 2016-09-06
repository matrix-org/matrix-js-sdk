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
    this._discardNewSession = false;
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
        return q(this._outboundSessionId);
    }

    var session_id = this._olmDevice.createOutboundGroupSession();
    var key = this._olmDevice.getOutboundGroupSessionKey(session_id);

    this._olmDevice.addInboundGroupSession(
        this._roomId, this._olmDevice.deviceCurve25519Key, session_id,
        key.key, key.chain_index
    );

    // send the keys to each (unblocked) device in the room.
    var payload = {
        type: "m.room_key",
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

    // TODO: we need to give the user a chance to block any devices or users
    // before we send them the keys; it's too late to download them here.
    this._prepPromise = this._crypto.downloadKeys(
        roomMembers, false
    ).then(function(res) {
        return self._crypto.ensureOlmSessionsForUsers(roomMembers);
    }).then(function(devicemap) {
        // TODO: send OOB messages. for now, send an in-band message.  Each
        // encrypted copy of the key takes up about 1K, so we'll only manage
        // about 60 copies before we hit the event size limit; but ultimately the
        // OOB messaging API will solve that problem for us.

        var participantKeys = [];
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
                participantKeys.push(deviceInfo.getIdentityKey());
            }
        }

        var encryptedContent = olmlib.encryptMessageForDevices(
            self._deviceId,
            self._olmDevice,
            participantKeys,
            payload
        );

        var txnId = '' + (new Date().getTime());
        var path = utils.encodeUri(
            "/rooms/$roomId/send/m.room.encrypted/$txnId", {
                $roomId: self._roomId,
                $txnId: txnId,
            }
        );

        // TODO: retries
        return self._baseApis._http.authedRequest(
            undefined, "PUT", path, undefined, encryptedContent
        );
    }).then(function() {
        if (self._discardNewSession) {
            // we've had cause to reset the session_id since starting this process.
            // we'll use the current session for any currently pending events, but
            // don't save it as the current _outboundSessionId, so that new events
            // will use a new session.
            console.log("Session generation complete, but discarding");
        } else {
            self._outboundSessionId = session_id;
        }
        return session_id;
    }).finally(function() {
        self._prepPromise = null;
        self._discardNewSession = false;
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
    return this._ensureOutboundSession(room).then(function(session_id) {
        var payloadJson = {
            room_id: self._roomId,
            type: eventType,
            content: content
        };

        var ciphertext = self._olmDevice.encryptGroupMessage(
            session_id, JSON.stringify(payloadJson)
        );

        var encryptedContent = {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            sender_key: self._olmDevice.deviceCurve25519Key,
            ciphertext: ciphertext,
            session_id: session_id,
        };

        return encryptedContent;
    });
};

/**
 * @inheritdoc
 *
 * @param {module:models/event.MatrixEvent} event  event causing the change
 * @param {module:models/room-member} member  user whose membership changed
 */
MegolmEncryption.prototype.onRoomMembership = function(event, member) {
    // start a new outbound session whenever someone joins or leaves the room.
    //
    // technically we don't need to reset on all membership transitions (eg,
    // leave->ban), but we might as well.

    // when people join the room, we could get away with sharing the current
    // state of the ratchet with them; however, it's somewhat easier for now
    // just to reset the session and start a new one.

    if (this._outboundSessionId) {
        console.log("Discarding outbound megolm session due to change in " +
                    "membership of " + member.userId);
        this._outboundSessionId = null;
    }

    if (this._prepPromise) {
        console.log("Discarding as-yet-incomplete megolm session due to " +
                    "change in membership of " + member.userId);
        this._discardNewSession = true;
    }
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
        !content.ciphertext
       ) {
        throw new base.DecryptionError("Missing fields in input");
    }

    try {
        var res = this._olmDevice.decryptGroupMessage(
            event.room_id, content.sender_key, content.session_id, content.ciphertext
        );
        return JSON.parse(res);
    } catch (e) {
        throw new base.DecryptionError(e);
    }
};

/**
 * @inheritdoc
 *
 * @param {module:models/event.MatrixEvent} event key event
 */
MegolmDecryption.prototype.onRoomKeyEvent = function(event) {
    console.log("Adding key from ", event);
    var content = event.getContent();

    if (!content.room_id ||
        !content.session_id ||
        !content.session_key ||
        content.chain_index === undefined
       ) {
        console.error("key event is missing fields");
        return;
    }

    this._olmDevice.addInboundGroupSession(
        content.room_id, event.getSenderKey(), content.session_id,
        content.session_key, content.chain_index
    );
};

base.registerAlgorithm(
    olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption
);
