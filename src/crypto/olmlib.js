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

/**
 * @module olmlib
 *
 * Utilities common to olm encryption algorithms
 */

var q = require('q');
var anotherjson = require('another-json');

var utils = require("../utils");

/**
 * matrix algorithm tag for olm
 */
module.exports.OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

/**
 * matrix algorithm tag for megolm
 */
module.exports.MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";


/**
 * Encrypt an event payload for an Olm device
 *
 * @param {Object<string, string>} resultsObject  The `ciphertext` property
 *   of the m.room.encrypted event to which to add our result
 *
 * @param {string} ourUserId
 * @param {string} ourDeviceId
 * @param {module:crypto/OlmDevice} olmDevice olm.js wrapper
 * @param {string} recipientUserId
 * @param {module:crypto/deviceinfo} recipientDevice
 * @param {object} payloadFields fields to include in the encrypted payload
 */
module.exports.encryptMessageForDevice = function(
    resultsObject,
    ourUserId, ourDeviceId, olmDevice, recipientUserId, recipientDevice,
    payloadFields
) {
    var deviceKey = recipientDevice.getIdentityKey();
    var sessionId = olmDevice.getSessionIdForDevice(deviceKey);
    if (sessionId === null) {
        // If we don't have a session for a device then
        // we can't encrypt a message for it.
        return;
    }

    console.log(
        "Using sessionid " + sessionId + " for device " +
            recipientUserId + ":" + recipientDevice.deviceId
    );

    var payload = {
        sender: ourUserId,
        sender_device: ourDeviceId,

        // Include the Ed25519 key so that the recipient knows what
        // device this message came from.
        // We don't need to include the curve25519 key since the
        // recipient will already know this from the olm headers.
        // When combined with the device keys retrieved from the
        // homeserver signed by the ed25519 key this proves that
        // the curve25519 key and the ed25519 key are owned by
        // the same device.
        keys: {
            "ed25519": olmDevice.deviceEd25519Key,
        },

        // include the recipient device details in the payload,
        // to avoid unknown key attacks, per
        // https://github.com/vector-im/vector-web/issues/2483
        recipient: recipientUserId,
        recipient_keys: {
            "ed25519": recipientDevice.getFingerprint(),
        },
    };

    // TODO: technically, a bunch of that stuff only needs to be included for
    // pre-key messages: after that, both sides know exactly which devices are
    // involved in the session. If we're looking to reduce data transfer in the
    // future, we could elide them for subsequent messages.

    utils.extend(payload, payloadFields);

    resultsObject[deviceKey] = olmDevice.encryptMessage(
        deviceKey, sessionId, JSON.stringify(payload)
    );
};

/**
 * Try to make sure we have established olm sessions for the given devices.
 *
 * @param {module:crypto/OlmDevice} olmDevice
 *
 * @param {module:base-apis~MatrixBaseApis} baseApis
 *
 * @param {object<string, module:crypto/deviceinfo[]>} devicesByUser
 *    map from userid to list of devices
 *
 * @return {module:client.Promise} resolves once the sessions are complete, to
 *    an Object mapping from userId to deviceId to
 *    {@link module:crypto~OlmSessionResult}
 */
module.exports.ensureOlmSessionsForDevices = function(
    olmDevice, baseApis, devicesByUser
) {
    var devicesWithoutSession = [
        // [userId, deviceId], ...
    ];
    var result = {};

    for (var userId in devicesByUser) {
        if (!devicesByUser.hasOwnProperty(userId)) { continue; }
        result[userId] = {};
        var devices = devicesByUser[userId];
        for (var j = 0; j < devices.length; j++) {
            var deviceInfo = devices[j];
            var deviceId = deviceInfo.deviceId;
            var key = deviceInfo.getIdentityKey();
            var sessionId = olmDevice.getSessionIdForDevice(key);
            if (sessionId === null) {
                devicesWithoutSession.push([userId, deviceId]);
            }
            result[userId][deviceId] = {
                device: deviceInfo,
                sessionId: sessionId,
            };
        }
    }

    if (devicesWithoutSession.length === 0) {
        return q(result);
    }

    // TODO: this has a race condition - if we try to send another message
    // while we are claiming a key, we will end up claiming two and setting up
    // two sessions.
    //
    // That should eventually resolve itself, but it's poor form.

    var oneTimeKeyAlgorithm = "signed_curve25519";
    return baseApis.claimOneTimeKeys(
        devicesWithoutSession, oneTimeKeyAlgorithm
    ).then(function(res) {
        var otk_res = res.one_time_keys || {};
        for (var userId in devicesByUser) {
            if (!devicesByUser.hasOwnProperty(userId)) { continue; }
            var userRes = otk_res[userId] || {};
            var devices = devicesByUser[userId];
            for (var j = 0; j < devices.length; j++) {
                var deviceInfo = devices[j];
                var deviceId = deviceInfo.deviceId;
                if (result[userId][deviceId].sessionId) {
                    // we already have a result for this device
                    continue;
                }

                var deviceRes = userRes[deviceId] || {};
                var oneTimeKey = null;
                for (var keyId in deviceRes) {
                    if (keyId.indexOf(oneTimeKeyAlgorithm + ":") === 0) {
                        oneTimeKey = deviceRes[keyId];
                    }
                }

                if (!oneTimeKey) {
                    console.warn(
                        "No one-time keys (alg=" + oneTimeKeyAlgorithm +
                            ") for device " + userId + ":" + deviceId
                    );
                    continue;
                }

                var sid = _verifyKeyAndStartSession(
                    olmDevice, oneTimeKey, userId, deviceInfo
                );
                result[userId][deviceId].sessionId = sid;
            }
        }
        return result;
    });
};


function _verifyKeyAndStartSession(olmDevice, oneTimeKey, userId, deviceInfo) {
    var deviceId = deviceInfo.deviceId;
    try {
        _verifySignature(
            olmDevice, oneTimeKey, userId, deviceId,
            deviceInfo.getFingerprint()
        );
    } catch (e) {
        console.error(
            "Unable to verify signature on one-time key for device " +
                userId + ":" + deviceId + ":", e
        );
        return null;
    }

    var sid;
    try {
        sid = olmDevice.createOutboundSession(
            deviceInfo.getIdentityKey(), oneTimeKey.key
        );
    } catch (e) {
        // possibly a bad key
        console.error("Error starting session with device " +
                      userId + ":" + deviceId + ": " + e);
        return null;
    }

    console.log("Started new sessionid " + sid +
                " for device " + userId + ":" + deviceId);
    return sid;
}


/**
 * Verify the signature on an object
 *
 * @param {module:crypto/OlmDevice} olmDevice olm wrapper to use for verify op
 *
 * @param {Object} obj object to check signature on. Note that this will be
 * stripped of its 'signatures' and 'unsigned' properties.
 *
 * @param {string} signingUserId  ID of the user whose signature should be checked
 *
 * @param {string} signingDeviceId  ID of the device whose signature should be checked
 *
 * @param {string} signingKey   base64-ed ed25519 public key
 */
var _verifySignature = module.exports.verifySignature = function(
    olmDevice, obj, signingUserId, signingDeviceId, signingKey
) {
    var signKeyId = "ed25519:" + signingDeviceId;
    var signatures = obj.signatures || {};
    var userSigs = signatures[signingUserId] || {};
    var signature = userSigs[signKeyId];
    if (!signature) {
        throw Error("No signature");
    }

    // prepare the canonical json: remove unsigned and signatures, and stringify with
    // anotherjson
    delete obj.unsigned;
    delete obj.signatures;
    var json = anotherjson.stringify(obj);

    olmDevice.verifySignature(
        signingKey, json, signature
    );
};
