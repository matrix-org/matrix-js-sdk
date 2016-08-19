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

var utils = require("./utils");

/**
 * matrix algorithm tag for olm
 */
module.exports.OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

/**
 * matrix algorithm tag for megolm
 */
module.exports.MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";


/**
 * Encrypt an event payload for a list of devices
 *
 * @param {string} ourDeviceId
 * @param {module:OlmDevice} olmDevice olm.js wrapper
 * @param {string[]} participantKeys list of curve25519 keys to encrypt for
 * @param {object} payloadFields fields to include in the encrypted payload
 *
 * @return {object} content for an m.room.encrypted event
 */
module.exports.encryptMessageForDevices = function(
    ourDeviceId, olmDevice, participantKeys, payloadFields
) {
    participantKeys.sort();
    var participantHash = ""; // Olm.sha256(participantKeys.join());
    var payloadJson = {
        fingerprint: participantHash,
        sender_device: ourDeviceId,
    };
    utils.extend(payloadJson, payloadFields);

    var ciphertext = {};
    var payloadString = JSON.stringify(payloadJson);
    for (var i = 0; i < participantKeys.length; ++i) {
        var deviceKey = participantKeys[i];
        var sessionId = olmDevice.getSessionIdForDevice(deviceKey);
        if (sessionId === null) {
            // If we don't have a session for a device then
            // we can't encrypt a message for it.
            continue;
        }
        console.log("Using sessionid " + sessionId + " for device " + deviceKey);
        ciphertext[deviceKey] = olmDevice.encryptMessage(
            deviceKey, sessionId, payloadString
        );
    }
    var encryptedContent = {
        algorithm: module.exports.OLM_ALGORITHM,
        sender_key: olmDevice.deviceCurve25519Key,
        ciphertext: ciphertext
    };
    return encryptedContent;
};
