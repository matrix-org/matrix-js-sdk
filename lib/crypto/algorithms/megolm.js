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
 * @private
 * @constructor
 *
 * @param {string} sessionId
 *
 * @property {string} sessionId
 * @property {Number} useCount     number of times this session has been used
 * @property {Number} creationTime when the session was created (ms since the epoch)
 * @property {module:client.Promise?} sharePromise  If a share operation is in progress,
 *    a promise which resolves when it is complete.
 */
function OutboundSessionInfo(sessionId) {
    this.sessionId = sessionId;
    this.useCount = 0;
    this.creationTime = new Date().getTime();
    this.sharePromise = null;
}


/**
 * Check if it's time to rotate the session
 *
 * @param {Number} rotationPeriodMsgs
 * @param {Number} rotationPeriodMs
 * @return {Boolean}
 */
OutboundSessionInfo.prototype.needsRotation = function(
    rotationPeriodMsgs, rotationPeriodMs
) {
    var sessionLifetime = new Date().getTime() - this.creationTime;

    if (this.useCount >= rotationPeriodMsgs ||
        sessionLifetime >= rotationPeriodMs
       ) {
        console.log(
            "Rotating megolm session after " + this.useCount +
                " messages, " + sessionLifetime + "ms"
        );
        return true;
    }

    return false;
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

    // OutboundSessionInfo. Null if we haven't yet started setting one up. Note
    // that even if this is non-null, it may not be ready for use (in which
    // case _outboundSession.sharePromise will be non-null.)
    this._outboundSession = null;

    // devices which have joined since we last sent a message.
    // userId -> {deviceId -> true}, or
    // userId -> true
    this._devicesPendingKeyShare = {};

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
 * @param {module:models/room} room
 *
 * @return {module:client.Promise} Promise which resolves to the
 *    OutboundSessionInfo when setup is complete.
 */
MegolmEncryption.prototype._ensureOutboundSession = function(room) {
    var self = this;

    var session = this._outboundSession;

    // need to make a brand new session?
    if (!session || session.needsRotation(self._sessionRotationPeriodMsgs,
                                          self._sessionRotationPeriodMs)
       ) {
        this._outboundSession = session = this._prepareNewSession(room);
    }

    if (session.sharePromise) {
        // key share already in progress
        return session.sharePromise;
    }

    // no share in progress: check for new devices
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

    session.sharePromise = this._shareKeyWithDevices(
        session.sessionId, shareMap
    ).finally(function() {
        session.sharePromise = null;
    }).then(function() {
        return session;
    });

    return session.sharePromise;
};

/**
 * @private
 *
 * @param {module:models/room} room
 *
 * @return {module:crypto/algorithms/megolm.OutboundSessionInfo} session
 */
MegolmEncryption.prototype._prepareNewSession = function(room) {
    var session_id = this._olmDevice.createOutboundGroupSession();
    var key = this._olmDevice.getOutboundGroupSessionKey(session_id);

    this._olmDevice.addInboundGroupSession(
        this._roomId, this._olmDevice.deviceCurve25519Key, session_id,
        key.key, {ed25519: this._olmDevice.deviceEd25519Key}
    );

    // we're going to share the key with all current members of the room,
    // so we can reset this.
    this._devicesPendingKeyShare = {};

    var session = new OutboundSessionInfo(session_id);

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
    session.sharePromise = this._crypto.downloadKeys(
        roomMembers, false
    ).then(function(res) {
        return self._shareKeyWithDevices(session_id, shareMap);
    }).then(function() {
        return session;
    }).finally(function() {
        session.sharePromise = null;
    });

    return session;
};

/**
 * @private
 *
 * @param {string} session_id
 *
 * @param {Object<string, Object<string, boolean>|boolean>} shareMap
 *    Map from userid to either: true (meaning this is a new user in the room,
 *    so all of his devices need the keys); or a map from deviceid to true
 *    (meaning this user has one or more new devices, which need the keys).
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

    // we downloaded the user's device list when they joined the room, or when
    // the new device announced itself, so there is no need to do so now.

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
            var sessionResults = devicemap[userId];

            for (var deviceId in sessionResults) {
                if (!sessionResults.hasOwnProperty(deviceId)) {
                    continue;
                }

                if (devicesToShareWith === true) {
                    // all devices
                } else if (!devicesToShareWith[deviceId]) {
                    // not a new device
                    continue;
                }

                var sessionResult = sessionResults[deviceId];
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
                    "sharing keys with device " + userId + ":" + deviceId
                );

                var deviceInfo = sessionResult.device;

                var encryptedContent = {
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
                    payload
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
    return this._ensureOutboundSession(room).then(function(session) {
        var payloadJson = {
            room_id: self._roomId,
            type: eventType,
            content: content
        };

        var ciphertext = self._olmDevice.encryptGroupMessage(
            session.sessionId, JSON.stringify(payloadJson)
        );

        var encryptedContent = {
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
 * @inheritdoc
 *
 * @param {module:models/event.MatrixEvent} event  event causing the change
 * @param {module:models/room-member} member  user whose membership changed
 * @param {string=} oldMembership  previous membership
 */
MegolmEncryption.prototype.onRoomMembership = function(event, member, oldMembership) {
    // if we haven't yet made a session, there's nothing to do here.
    if (!this._outboundSession) {
        return;
    }

    var newMembership = member.membership;

    if (newMembership === 'join') {
        this._onNewRoomMember(member.userId);
        return;
    }

    if (newMembership === 'invite' && oldMembership !== 'join') {
        // we don't (yet) share keys with invited members, so nothing to do yet
        return;
    }

    // otherwise we assume the user is leaving, and start a new outbound session.
    console.log("Discarding outbound megolm session due to change in " +
                "membership of " + member.userId + " (" + oldMembership +
                "->" + newMembership + ")");

    // this ensures that we will start a new session on the next message.
    this._outboundSession = null;
};

/**
 * handle a new user joining a room
 *
 * @param {string} userId   new member
 */
MegolmEncryption.prototype._onNewRoomMember = function(userId) {
    // make sure we have a list of this user's devices. We are happy to use a
    // cached version here: we assume that if we already have a list of the
    // user's devices, then we already share an e2e room with them, which means
    // that they will have announced any new devices via an m.new_device.
    this._crypto.downloadKeys([userId], false).done();

    // also flag this user up for needing a keyshare.
    this._devicesPendingKeyShare[userId] = true;
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
 * @return {null} The event referred to an unknown megolm session
 * @return {module:crypto.DecryptionResult} decryption result
 *
 * @throws {module:crypto/algorithms/base.DecryptionError} if there is a
 *   problem decrypting the event
 */
MegolmDecryption.prototype.decryptEvent = function(event) {
    var content = event.content;

    if (!content.sender_key || !content.session_id ||
        !content.ciphertext
       ) {
        throw new base.DecryptionError("Missing fields in input");
    }

    var res;
    try {
        res = this._olmDevice.decryptGroupMessage(
            event.room_id, content.sender_key, content.session_id, content.ciphertext
        );
    } catch (e) {
        throw new base.DecryptionError(e);
    }

    if (res === null) {
        return null;
    }

    var payload = JSON.parse(res.result);

    // belt-and-braces check that the room id matches that indicated by the HS
    // (this is somewhat redundant, since the megolm session is scoped to the
    // room, so neither the sender nor a MITM can lie about the room_id).
    if (payload.room_id !== event.room_id) {
        throw new base.DecryptionError(
            "Message intended for room " + payload.room_id
        );
    }

    return {
        payload: payload,
        keysClaimed: res.keysClaimed,
        keysProved: res.keysProved,
    };
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
        !content.session_key
       ) {
        console.error("key event is missing fields");
        return;
    }

    this._olmDevice.addInboundGroupSession(
        content.room_id, event.getSenderKey(), content.session_id,
        content.session_key, event.getKeysClaimed()
    );
};

base.registerAlgorithm(
    olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption
);
