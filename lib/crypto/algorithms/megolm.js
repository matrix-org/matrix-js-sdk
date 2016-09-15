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

var q = require("q");

var utils = require("../../utils");
var olmlib = require("../olmlib");
var base = require("./base");

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
    this._prepPromise = null;
    this._outboundSessionId = null;
    this._discardNewSession = false;

    // devices which have joined since we last sent a message.
    // userId -> {deviceId -> true}, or
    // userId -> true
    this._devicesPendingKeyShare = {};
    this._sharePromise = null;
}
utils.inherits(MegolmEncryption, base.EncryptionAlgorithm);

/**
 * @private
 *
 * @param {module:models/room} room
 *
 * @return {module:client.Promise} Promise which resolves to the megolm
 *   sessionId when setup is complete.
 */
MegolmEncryption.prototype._ensureOutboundSession = function(room) {
    var self = this;

    if (this._prepPromise) {
        // prep already in progress
        return this._prepPromise;
    }

    var sessionId = this._outboundSessionId;

    // need to make a brand new session?
    if (!sessionId) {
        this._prepPromise = this._prepareNewSession(room).
            finally(function() {
                self._prepPromise = null;
            });
        return this._prepPromise;
    }

    if (this._sharePromise) {
        // key share already in progress
        return this._sharePromise;
    }

    // prep already done, but check for new devices
    var shareMap = this._devicesPendingKeyShare;
    this._devicesPendingKeyShare = {};

    // check each user is (still) a member of the room
    for (var userId in shareMap) {
        if (!shareMap.hasOwnProperty(userId)) {
            continue;
        }

        // XXX what about rooms where invitees can see the content?
        var member = room.getMember(userId);
        if (member.membership !== "join") {
            delete shareMap[userId];
        }
    }

    this._sharePromise = this._shareKeyWithDevices(
        sessionId, shareMap
    ).finally(function() {
        self._sharePromise = null;
    }).then(function() {
        return sessionId;
    });

    return this._sharePromise;
};

/**
 * @private
 *
 * @param {module:models/room} room
 *
 * @return {module:client.Promise} Promise which resolves to the megolm
 *   sessionId when setup is complete.
 */
MegolmEncryption.prototype._prepareNewSession = function(room) {
    var session_id = this._olmDevice.createOutboundGroupSession();
    var key = this._olmDevice.getOutboundGroupSessionKey(session_id);

    this._olmDevice.addInboundGroupSession(
        this._roomId, this._olmDevice.deviceCurve25519Key, session_id,
        key.key, key.chain_index
    );

    // we're going to share the key with all current members of the room,
    // so we can reset this.
    this._devicesPendingKeyShare = {};

    var roomMembers = utils.map(room.getJoinedMembers(), function(u) {
        return u.userId;
    });

    var shareMap = {};
    for (var i = 0; i < roomMembers.length; i++) {
        var userId = roomMembers[i];
        shareMap[userId] = true;
    }

    var self = this;

    // TODO: we need to give the user a chance to block any devices or users
    // before we send them the keys; it's too late to download them here.
    return this._crypto.downloadKeys(
        roomMembers, false
    ).then(function(res) {
        return self._shareKeyWithDevices(session_id, shareMap);
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
        self._discardNewSession = false;
    });
};

/**
 * @private
 *
 * @param {string} session_id
 * @param {Object<string, Object<string, boolean>|boolean>} shareMap
 *
 * @return {module:client.Promise} Promise which resolves once the key sharing
 *     message has been sent.
 */
MegolmEncryption.prototype._shareKeyWithDevices = function(session_id, shareMap) {
    var self = this;

    var key = this._olmDevice.getOutboundGroupSessionKey(session_id);
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

    return self._crypto.ensureOlmSessionsForUsers(
        utils.keys(shareMap)
    ).then(function(devicemap) {
        var contentMap = {};
        var haveTargets = false;

        for (var userId in devicemap) {
            if (!devicemap.hasOwnProperty(userId)) {
                continue;
            }

            var devicesToShareWith = shareMap[userId];
            var deviceInfos = devicemap[userId];

            for (var deviceId in deviceInfos) {
                if (!deviceInfos.hasOwnProperty(deviceId)) {
                    continue;
                }

                if (devicesToShareWith === true) {
                    // all devices
                } else if (!devicesToShareWith[deviceId]) {
                    // not a new device
                    continue;
                }

                console.log(
                    "sharing keys with device " + userId + ":" + deviceId
                );

                var deviceInfo = deviceInfos[deviceId].device;

                if (!contentMap[userId]) {
                    contentMap[userId] = {};
                }

                contentMap[userId][deviceId] =
                    olmlib.encryptMessageForDevices(
                        self._deviceId,
                        self._olmDevice,
                        [deviceInfo.getIdentityKey()],
                        payload
                    );
                haveTargets = true;
            }
        }

        if (!haveTargets) {
            return q();
        }

        // TODO: retries
        return self._baseApis.sendToDevice("m.room.encrypted", contentMap);
    });
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
             // Include our device ID so that recipients can send us a
             // m.new_device message if they don't have our session key.
            device_id: self._deviceId,
        };

        return encryptedContent;
    });
};

/**
 * @inheritdoc
 *
 * @param {module:models/event.MatrixEvent} event  event causing the change
 * @param {module:models/room-member} member  user whose membership changed
 * @param {string=} oldMembership  previous membership
 */
MegolmEncryption.prototype.onRoomMembership = function(event, member, oldMembership) {
    var newMembership = member.membership;

    if (newMembership === 'join') {
        // new member in the room.
        this._devicesPendingKeyShare[member.userId] = true;
        return;
    }

    if (newMembership === 'invite' && oldMembership !== 'join') {
        // we don't (yet) share keys with invited members, so nothing to do yet
        return;
    }

    // otherwise we assume the user is leaving, and start a new outbound session.
    if (this._outboundSessionId) {
        console.log("Discarding outbound megolm session due to change in " +
                    "membership of " + member.userId + " (" + oldMembership +
                    "->" + newMembership + ")");
        this._outboundSessionId = null;
    }

    if (this._prepPromise) {
        console.log("Discarding as-yet-incomplete megolm session due to " +
                    "change in membership of " + member.userId + " (" +
                    oldMembership + "->" + newMembership + ")");
        this._discardNewSession = true;
    }
};

/**
 * @inheritdoc
 *
 * @param {string} userId    owner of the device
 * @param {string} deviceId  deviceId of the device
 */
MegolmEncryption.prototype.onNewDevice = function(userId, deviceId) {
    var d = this._devicesPendingKeyShare[userId];

    if (d === true) {
        // we already want to share keys with all devices for this user
        return;
    }

    if (!d) {
        this._devicesPendingKeyShare[userId] = d = {};
    }

    d[deviceId] = true;
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
}
utils.inherits(MegolmDecryption, base.DecryptionAlgorithm);

/**
 * @inheritdoc
 *
 * @param {object} event raw event
 *
 * @return {object} object with 'result' key with decrypted payload (with
 *  properties 'type', 'content') and a 'sessionExists' key.
 *
 * @throws {module:crypto/algorithms/base.DecryptionError} if there is a
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
        if (res.sessionExists) {
            res.result = JSON.parse(res.result);
            return res;
        } else {
            return {sessionExists: false};
        }
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
        content.session_key, content.chain_index, event.getKeysClaimed()
    );
};

base.registerAlgorithm(
    olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption
);
