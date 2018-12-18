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

import Promise from 'bluebird';
const anotherjson = require('another-json');

const logger = require("../logger");
const utils = require("../utils");

/**
 * matrix algorithm tag for olm
 */
module.exports.OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

/**
 * matrix algorithm tag for megolm
 */
module.exports.MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

/**
 * matrix algorithm tag for megolm backups
 */
module.exports.MEGOLM_BACKUP_ALGORITHM = "m.megolm_backup.v1.curve25519-aes-sha2";


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
 *
 * Returns a promise which resolves (to undefined) when the payload
 *    has been encrypted into `resultsObject`
 */
module.exports.encryptMessageForDevice = async function(
    resultsObject,
    ourUserId, ourDeviceId, olmDevice, recipientUserId, recipientDevice,
    payloadFields,
) {
    const deviceKey = recipientDevice.getIdentityKey();
    const sessionId = await olmDevice.getSessionIdForDevice(deviceKey);
    if (sessionId === null) {
        // If we don't have a session for a device then
        // we can't encrypt a message for it.
        return;
    }

    logger.log(
        "Using sessionid " + sessionId + " for device " +
            recipientUserId + ":" + recipientDevice.deviceId,
    );

    const payload = {
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

    resultsObject[deviceKey] = await olmDevice.encryptMessage(
        deviceKey, sessionId, JSON.stringify(payload),
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
 *    map from userid to list of devices to ensure sessions for
 *
 * @param {bolean} force If true, establish a new session even if one already exists.
 *     Optional.
 *
 * @return {module:client.Promise} resolves once the sessions are complete, to
 *    an Object mapping from userId to deviceId to
 *    {@link module:crypto~OlmSessionResult}
 */
module.exports.ensureOlmSessionsForDevices = async function(
    olmDevice, baseApis, devicesByUser, force,
) {
    const devicesWithoutSession = [
        // [userId, deviceId], ...
    ];
    const result = {};

    for (const userId in devicesByUser) {
        if (!devicesByUser.hasOwnProperty(userId)) {
            continue;
        }
        result[userId] = {};
        const devices = devicesByUser[userId];
        for (let j = 0; j < devices.length; j++) {
            const deviceInfo = devices[j];
            const deviceId = deviceInfo.deviceId;
            const key = deviceInfo.getIdentityKey();
            const sessionId = await olmDevice.getSessionIdForDevice(key);
            if (sessionId === null || force) {
                devicesWithoutSession.push([userId, deviceId]);
            }
            result[userId][deviceId] = {
                device: deviceInfo,
                sessionId: sessionId,
            };
        }
    }

    if (devicesWithoutSession.length === 0) {
        return result;
    }

    // TODO: this has a race condition - if we try to send another message
    // while we are claiming a key, we will end up claiming two and setting up
    // two sessions.
    //
    // That should eventually resolve itself, but it's poor form.

    const oneTimeKeyAlgorithm = "signed_curve25519";
    const res = await baseApis.claimOneTimeKeys(
        devicesWithoutSession, oneTimeKeyAlgorithm,
    );

    const otk_res = res.one_time_keys || {};
    const promises = [];
    for (const userId in devicesByUser) {
        if (!devicesByUser.hasOwnProperty(userId)) {
            continue;
        }
        const userRes = otk_res[userId] || {};
        const devices = devicesByUser[userId];
        for (let j = 0; j < devices.length; j++) {
            const deviceInfo = devices[j];
            const deviceId = deviceInfo.deviceId;
            if (result[userId][deviceId].sessionId && !force) {
                // we already have a result for this device
                continue;
            }

            const deviceRes = userRes[deviceId] || {};
            let oneTimeKey = null;
            for (const keyId in deviceRes) {
                if (keyId.indexOf(oneTimeKeyAlgorithm + ":") === 0) {
                    oneTimeKey = deviceRes[keyId];
                }
            }

            if (!oneTimeKey) {
                logger.warn(
                    "No one-time keys (alg=" + oneTimeKeyAlgorithm +
                        ") for device " + userId + ":" + deviceId,
                );
                continue;
            }

            promises.push(
                _verifyKeyAndStartSession(
                    olmDevice, oneTimeKey, userId, deviceInfo,
                ).then((sid) => {
                    result[userId][deviceId].sessionId = sid;
                }),
            );
        }
    }

    await Promise.all(promises);
    return result;
};

async function _verifyKeyAndStartSession(olmDevice, oneTimeKey, userId, deviceInfo) {
    const deviceId = deviceInfo.deviceId;
    try {
        await _verifySignature(
            olmDevice, oneTimeKey, userId, deviceId,
            deviceInfo.getFingerprint(),
        );
    } catch (e) {
        logger.error(
            "Unable to verify signature on one-time key for device " +
                userId + ":" + deviceId + ":", e,
        );
        return null;
    }

    let sid;
    try {
        sid = await olmDevice.createOutboundSession(
            deviceInfo.getIdentityKey(), oneTimeKey.key,
        );
    } catch (e) {
        // possibly a bad key
        logger.error("Error starting session with device " +
                      userId + ":" + deviceId + ": " + e);
        return null;
    }

    logger.log("Started new sessionid " + sid +
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
 *
 * Returns a promise which resolves (to undefined) if the the signature is good,
 * or rejects with an Error if it is bad.
 */
const _verifySignature = module.exports.verifySignature = async function(
    olmDevice, obj, signingUserId, signingDeviceId, signingKey,
) {
    const signKeyId = "ed25519:" + signingDeviceId;
    const signatures = obj.signatures || {};
    const userSigs = signatures[signingUserId] || {};
    const signature = userSigs[signKeyId];
    if (!signature) {
        throw Error("No signature");
    }

    // prepare the canonical json: remove unsigned and signatures, and stringify with
    // anotherjson
    delete obj.unsigned;
    delete obj.signatures;
    const json = anotherjson.stringify(obj);

    olmDevice.verifySignature(
        signingKey, json, signature,
    );
};
