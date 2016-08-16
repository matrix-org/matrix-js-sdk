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
 * Internal module. Defines the base classes of the encryption implementations
 *
 * @module crypto-algorithms/base
 */

var utils = require("../utils");

/**
 * map of registered encryption algorithm classes. A map from string to {@link
 * module:crypto-algorithms/base.EncryptionAlgorithm|EncryptionAlgorithm} class
 *
 * @type {Object.<string, function(new: module:crypto-algorithms/base.EncryptionAlgorithm)>}
 */
module.exports.ENCRYPTION_CLASSES = {};

/**
 * map of registered encryption algorithm classes. Map from string to {@link
 * module:crypto-algorithms/base.DecryptionAlgorithm|DecryptionAlgorithm} class
 *
 * @type {Object.<string, function(new: module:crypto-algorithms/base.DecryptionAlgorithm)>}
 */
module.exports.DECRYPTION_CLASSES = {};

/**
 * base type for encryption implementations
 *
 * @constructor
 *
 * @param {string} deviceId The identifier for this device.
 * @param {module:crypto} crypto crypto core
 * @param {module:OlmDevice} olmDevice olm.js wrapper
 */
module.exports.EncryptionAlgorithm = function(deviceId, crypto, olmDevice) {
    this._deviceId = deviceId;
    this._crypto = crypto;
    this._olmDevice = olmDevice;
};

/**
 * Initialise this EncryptionAlgorithm instance for a particular room
 *
 * @method module:crypto-algorithms/base.EncryptionAlgorithm#initRoomEncryption
 * @abstract
 *
 * @param {string[]} roomMembers list of currently-joined users in the room
 * @return {module:client.Promise} Promise which resolves when setup is complete
 */

/**
 * Encrypt a message event
 *
 * @method module:crypto-algorithms/base.EncryptionAlgorithm#encryptMessage
 * @abstract
 *
 * @param {module:models/room} room
 * @param {string} eventType
 * @param {object} plaintext event content
 *
 * @return {object} new event body
 */


/**
 * base type for decryption implementations
 *
 * @constructor
 * @param {string} deviceId The identifier for this device.
 * @param {module:crypto} crypto crypto core
 * @param {module:OlmDevice} olmDevice olm.js wrapper
 */
module.exports.DecryptionAlgorithm = function(deviceId, crypto, olmDevice) {
    this._deviceId = deviceId;
    this._crypto = crypto;
    this._olmDevice = olmDevice;
};

/**
 * Decrypt an event
 *
 * @method module:crypto-algorithms/base.DecryptionAlgorithm#decryptEvent
 * @abstract
 *
 * @param {object} event raw event
 *
 * @return {object} decrypted payload (with properties 'type', 'content')
 *
 * @throws {module:crypto-algorithms/base.DecryptionError} if there is a
 *   problem decrypting the event
 */

/**
 * Exception thrown when decryption fails
 *
 * @constructor
 * @param {string} msg message describing the problem
 * @extends Error
 */
module.exports.DecryptionError = function(msg) {
    this.message = msg;
};
utils.inherits(module.exports.DecryptionError, Error);

/**
 * Registers an encryption/decryption class for a particular algorithm
 *
 * @param {string} algorithm algorithm tag to register for
 *
 * @param {class} encryptor {@link
 *     module:crypto-algorithms/base.EncryptionAlgorithm|EncryptionAlgorithm}
 *     implementation
 *
 * @param {class} decryptor {@link
 *     module:crypto-algorithms/base.DecryptionAlgorithm|DecryptionAlgorithm}
 *     implementation
 */
module.exports.registerAlgorithm = function(algorithm, encryptor, decryptor) {
    module.exports.ENCRYPTION_CLASSES[algorithm] = encryptor;
    module.exports.DECRYPTION_CLASSES[algorithm] = decryptor;
};
