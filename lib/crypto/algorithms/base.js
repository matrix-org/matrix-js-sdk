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
 * @module crypto/algorithms/base
 */
var utils = require("../../utils");

/**
 * map of registered encryption algorithm classes. A map from string to {@link
 * module:crypto/algorithms/base.EncryptionAlgorithm|EncryptionAlgorithm} class
 *
 * @type {Object.<string, function(new: module:crypto/algorithms/base.EncryptionAlgorithm)>}
 */
module.exports.ENCRYPTION_CLASSES = {};

/**
 * map of registered encryption algorithm classes. Map from string to {@link
 * module:crypto/algorithms/base.DecryptionAlgorithm|DecryptionAlgorithm} class
 *
 * @type {Object.<string, function(new: module:crypto/algorithms/base.DecryptionAlgorithm)>}
 */
module.exports.DECRYPTION_CLASSES = {};

/**
 * base type for encryption implementations
 *
 * @constructor
 * @alias module:crypto/algorithms/base.EncryptionAlgorithm
 *
 * @param {object} params parameters
 * @param {string} params.userId  The UserID for the local user
 * @param {string} params.deviceId The identifier for this device.
 * @param {module:crypto} params.crypto crypto core
 * @param {module:crypto/OlmDevice} params.olmDevice olm.js wrapper
 * @param {module:base-apis~MatrixBaseApis} baseApis base matrix api interface
 * @param {string} params.roomId  The ID of the room we will be sending to
 * @param {object} params.config  The body of the m.room.encryption event
 */
var EncryptionAlgorithm = function(params) {
    this._userId = params.userId;
    this._deviceId = params.deviceId;
    this._crypto = params.crypto;
    this._olmDevice = params.olmDevice;
    this._baseApis = params.baseApis;
    this._roomId = params.roomId;
};
/** */
module.exports.EncryptionAlgorithm = EncryptionAlgorithm;

/**
 * Encrypt a message event
 *
 * @method module:crypto/algorithms/base.EncryptionAlgorithm#encryptMessage
 * @abstract
 *
 * @param {module:models/room} room
 * @param {string} eventType
 * @param {object} plaintext event content
 *
 * @return {module:client.Promise} Promise which resolves to the new event body
 */

/**
 * Called when the membership of a member of the room changes.
 *
 * @param {module:models/event.MatrixEvent} event  event causing the change
 * @param {module:models/room-member} member  user whose membership changed
 * @param {string=} oldMembership  previous membership
 */
EncryptionAlgorithm.prototype.onRoomMembership = function(
    event, member, oldMembership
) {};

/**
 * base type for decryption implementations
 *
 * @constructor
 * @alias module:crypto/algorithms/base.DecryptionAlgorithm
 *
 * @param {object} params parameters
 * @param {string} params.userId  The UserID for the local user
 * @param {module:crypto} params.crypto crypto core
 * @param {module:crypto/OlmDevice} params.olmDevice olm.js wrapper
 * @param {string=} params.roomId The ID of the room we will be receiving
 *     from. Null for to-device events.
 */
var DecryptionAlgorithm = function(params) {
    this._userId = params.userId;
    this._crypto = params.crypto;
    this._olmDevice = params.olmDevice;
    this._roomId = params.roomId;
};
/** */
module.exports.DecryptionAlgorithm = DecryptionAlgorithm;

/**
 * Decrypt an event
 *
 * @method module:crypto/algorithms/base.DecryptionAlgorithm#decryptEvent
 * @abstract
 *
 * @param {object} event raw event
 *
 * @return {null} if the event referred to an unknown megolm session
 * @return {module:crypto.DecryptionResult} decryption result
 *
 * @throws {module:crypto/algorithms/base.DecryptionError} if there is a
 *   problem decrypting the event
 */

/**
 * Handle a key event
 *
 * @method module:crypto/algorithms/base.DecryptionAlgorithm#onRoomKeyEvent
 *
 * @param {module:models/event.MatrixEvent} event key event
 */
DecryptionAlgorithm.prototype.onRoomKeyEvent = function(params) {
    // ignore by default
};

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
 *     module:crypto/algorithms/base.EncryptionAlgorithm|EncryptionAlgorithm}
 *     implementation
 *
 * @param {class} decryptor {@link
 *     module:crypto/algorithms/base.DecryptionAlgorithm|DecryptionAlgorithm}
 *     implementation
 */
module.exports.registerAlgorithm = function(algorithm, encryptor, decryptor) {
    module.exports.ENCRYPTION_CLASSES[algorithm] = encryptor;
    module.exports.DECRYPTION_CLASSES[algorithm] = decryptor;
};
