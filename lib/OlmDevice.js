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

var Olm = require("olm");
var utils = require("./utils");

/**
 * Manages the olm cryptography functions. Each OlmDevice has a single
 * OlmAccount and a number of OlmSessions.
 *
 * Accounts and sessions are kept pickled in a sessionStore.
 *
 * @constructor
 * @param {Object} sessionStore A store to be used for data in end-to-end
 *    crypto
 *
 * @property {string} deviceCurve25519Key   Curve25519 key for the account
 * @property {string} deviceEd25519Key      Ed25519 key for the account
 */
function OlmDevice(sessionStore) {
    this._sessionStore = sessionStore;
    this._pickleKey = "DEFAULT_KEY";

    var e2eKeys;
    var account = new Olm.Account();
    try {
        var e2eAccount = this._sessionStore.getEndToEndAccount();
        if (e2eAccount === null) {
            account.create();
            var pickled = account.pickle(this._pickleKey);
            this._sessionStore.storeEndToEndAccount(pickled);
        } else {
            account.unpickle(this._pickleKey, e2eAccount);
        }
        e2eKeys = JSON.parse(account.identity_keys());
    } finally {
        account.free();
    }

    this.deviceCurve25519Key = e2eKeys.curve25519;
    this.deviceEd25519Key = e2eKeys.ed25519;
}


/**
 * Signs a message with the ed25519 key for this account.
 *
 * @param {string} message  message to be signed
 * @return {string} base64-encoded signature
 */
OlmDevice.prototype.sign = function(message) {
    var account = new Olm.Account();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);
        return account.sign(message);
    } finally {
        account.free();
    }
};

/**
 * Get the current (unused, unpublished) one-time keys for this account.
 *
 * @return {object} one time keys; an object with the single property
 * <tt>curve25519<tt>, which is itself an object mapping key id to Curve25519
 * key.
 */
OlmDevice.prototype.getOneTimeKeys = function() {
    var account = new Olm.Account();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);
        return JSON.parse(account.one_time_keys());
    } finally {
        account.free();
    }
};


/**
 * Get the maximum number of one-time keys we can store.
 *
 * @return {number} number of keys
 */
OlmDevice.prototype.maxNumberOfOneTimeKeys = function() {
    var account = new Olm.Account();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);
        return account.max_number_of_one_time_keys();
    } finally {
        account.free();
    }
};

/**
 * Marks all of the one-time keys as published.
 */
OlmDevice.prototype.markKeysAsPublished = function() {
    var account = new Olm.Account();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);
        account.mark_keys_as_published();
        pickledAccount = account.pickle(this._pickleKey);
        this._sessionStore.storeEndToEndAccount(pickledAccount);
    } finally {
        account.free();
    }
};

/**
 * Generate some new one-time keys
 *
 * @param {number} numKeys number of keys to generate
 */
OlmDevice.prototype.generateOneTimeKeys = function(numKeys) {
    var account = new Olm.Account();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);
        account.generate_one_time_keys(numKeys);
        pickledAccount = account.pickle(this._pickleKey);
        this._sessionStore.storeEndToEndAccount(pickledAccount);
    } finally {
        account.free();
    }
};

/**
 * Generate a new outbound session
 *
 * The new session will be stored in the sessionStore.
 *
 * @param {string} theirIdentityKey remote user's Curve25519 identity key
 * @param {string} theirOneTimeKey  remote user's one-time Curve25519 key
 * @return {string} sessionId for the outbound session.
 */
OlmDevice.prototype.createOutboundSession = function(
    theirIdentityKey, theirOneTimeKey
) {
    var account = new Olm.Account();
    var session = new Olm.Session();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);

        session.create_outbound(account, theirIdentityKey, theirOneTimeKey);

        var pickledSession = session.pickle(this._pickleKey);
        var sessionId = session.session_id();
        this._sessionStore.storeEndToEndSession(
            theirIdentityKey, sessionId, pickledSession
        );
        return sessionId;
    } finally {
        session.free();
        account.free();
    }
};


/**
 * Generate a new inbound session, given an incoming message
 *
 * @param {string} theirDeviceIdentityKey remote user's Curve25519 identity key
 * @param {number} message_type  message_type field from the received message (must be 0)
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {string} decrypted payload
 *
 * @raises {Error} if the received message was not valid (for instance, it
 *     didn't use a valid one-time key).
 */
OlmDevice.prototype.createInboundSession = function(
    theirDeviceIdentityKey, message_type, ciphertext
) {
    if (message_type !== 0) {
        throw new Error("Need message_type == 0 to create inbound session");
    }

    var account = new Olm.Account();
    var session = new Olm.Session();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);

        session.create_inbound_from(account, theirDeviceIdentityKey, ciphertext);
        account.remove_one_time_keys(session);

        pickledAccount = account.pickle(this._pickleKey);
        this._sessionStore.storeEndToEndAccount(pickledAccount);

        var payloadString = session.decrypt(message_type, ciphertext);

        var sessionId = session.session_id();
        var pickledSession = session.pickle(this._pickleKey);
        this._sessionStore.storeEndToEndSession(
            theirDeviceIdentityKey, sessionId, pickledSession
        );

        return payloadString;
    } finally {
        session.free();
        account.free();
    }
};


/**
 * Get a list of known session IDs for the given device
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @return {string[]}  a list of known session ids for the device
 */
OlmDevice.prototype.getSessionIdsForDevice = function(theirDeviceIdentityKey) {
    var sessions = this._sessionStore.getEndToEndSessions(
        theirDeviceIdentityKey
    );
    return utils.keys(sessions);
};


/**
 * Encrypt an outgoing message using an existing session
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @param {string} sessionId  the id of the active session
 * @param {string} payloadString  payload to be encrypted and sent
 *
 * @return {string} ciphertext
 */
OlmDevice.prototype.encryptMessage = function(
    theirDeviceIdentityKey, sessionId, payloadString
) {
    var sessions = this._sessionStore.getEndToEndSessions(
        theirDeviceIdentityKey
    );
    var pickledSession = sessions[sessionId];

    var session = new Olm.Session();

    try {
        session.unpickle(this._pickleKey, pickledSession);
        var res = session.encrypt(payloadString);
        pickledSession = session.pickle(this._pickleKey);
        this._sessionStore.storeEndToEndSession(
            theirDeviceIdentityKey, sessionId, pickledSession
        );
        return res;
    } finally {
        session.free();
    }
};

/**
 * Decrypt an incoming message using an existing session
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @param {string} sessionId  the id of the active session
 * @param {number} message_type  message_type field from the received message
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {string} decrypted payload
 *
 * @raises {Error} if the received message was not valid (for instance, it
 *     did not match this session).
 */
OlmDevice.prototype.decryptMessage = function(
    theirDeviceIdentityKey, sessionId, message_type, ciphertext
) {
    var sessions = this._sessionStore.getEndToEndSessions(
        theirDeviceIdentityKey
    );
    var pickledSession = sessions[sessionId];

    var session = new Olm.Session();
    try {
        session.unpickle(this._pickleKey, pickledSession);
        var matchesInbound = message_type === 0 && session.matches_inbound(ciphertext);
        var payloadString = null;
        try {
            payloadString = session.decrypt(message_type, ciphertext);
        } catch (e) {
            console.log(
                "Failed to decrypt with an existing session: " + e.message
            );

            return {
                matchesInbound: matchesInbound,
                payload: null,
            };
        }

        // successfully decrypted: update the session
        pickledSession = session.pickle(this._pickleKey);
        this._sessionStore.storeEndToEndSession(
            theirDeviceIdentityKey, sessionId, pickledSession
        );

        return {
            matchesInbound: matchesInbound,
            payload: payloadString,
        };
    } finally {
        session.free();
    }
};

/** */
module.exports = OlmDevice;
