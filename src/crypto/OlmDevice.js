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
 * olm.js wrapper
 *
 * @module crypto/OlmDevice
 */
var Olm = require("olm");
var utils = require("../utils");


// The maximum size of an event is 65K, and we base64 the content, so this is a
// reasonable approximation to the biggest plaintext we can encrypt.
var MAX_PLAINTEXT_LENGTH = 65536 * 3 / 4;

function checkPayloadLength(payloadString) {
    if (payloadString === undefined) {
        throw new Error("payloadString undefined");
    }

    if (payloadString.length > MAX_PLAINTEXT_LENGTH) {
        // might as well fail early here rather than letting the olm library throw
        // a cryptic memory allocation error.
        //
        // Note that even if we manage to do the encryption, the message send may fail,
        // because by the time we've wrapped the ciphertext in the event object, it may
        // exceed 65K. But at least we won't just fail with "abort()" in that case.
        throw new Error("Message too long (" + payloadString.length + " bytes). " +
                        "The maximum for an encrypted message is " +
                        MAX_PLAINTEXT_LENGTH + " bytes.");
    }
}


/**
 * Manages the olm cryptography functions. Each OlmDevice has a single
 * OlmAccount and a number of OlmSessions.
 *
 * Accounts and sessions are kept pickled in a sessionStore.
 *
 * @constructor
 * @alias module:crypto/OlmDevice
 *
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
        _initialise_account(this._sessionStore, this._pickleKey, account);
        e2eKeys = JSON.parse(account.identity_keys());
    } finally {
        account.free();
    }

    this.deviceCurve25519Key = e2eKeys.curve25519;
    this.deviceEd25519Key = e2eKeys.ed25519;

    // we don't bother stashing outboundgroupsessions in the sessionstore -
    // instead we keep them here.
    this._outboundGroupSessionStore = {};

    // Store a set of decrypted message indexes for each group session.
    // This partially mitigates a replay attack where a MITM resends a group
    // message into the room.
    //
    // TODO: If we ever remove an event from memory we will also need to remove
    // it from this map. Otherwise if we download the event from the server we
    // will think that it is a duplicate.
    //
    // Keys are strings of form "<senderKey>|<session_id>|<message_index>"
    // Values are true.
    this._inboundGroupSessionMessageIndexes = {};
}

function _initialise_account(sessionStore, pickleKey, account) {
    var e2eAccount = sessionStore.getEndToEndAccount();
    if (e2eAccount !== null) {
        account.unpickle(pickleKey, e2eAccount);
        return;
    }

    account.create();
    var pickled = account.pickle(pickleKey);
    sessionStore.storeEndToEndAccount(pickled);
}

/**
 * @return {array} The version of Olm.
 */
OlmDevice.getOlmVersion = function() {
    return Olm.get_library_version();
};


/**
 * extract our OlmAccount from the session store and call the given function
 *
 * @param {function} func
 * @return {object} result of func
 * @private
 */
OlmDevice.prototype._getAccount = function(func) {
    var account = new Olm.Account();
    try {
        var pickledAccount = this._sessionStore.getEndToEndAccount();
        account.unpickle(this._pickleKey, pickledAccount);
        return func(account);
    } finally {
        account.free();
    }
};


/**
 * store our OlmAccount in the session store
 *
 * @param {OlmAccount} account
 * @private
 */
OlmDevice.prototype._saveAccount = function(account) {
    var pickledAccount = account.pickle(this._pickleKey);
    this._sessionStore.storeEndToEndAccount(pickledAccount);
};


/**
 * extract an OlmSession from the session store and call the given function
 *
 * @param {string} deviceKey
 * @param {string} sessionId
 * @param {function} func
 * @return {object} result of func
 * @private
 */
OlmDevice.prototype._getSession = function(deviceKey, sessionId, func) {
    var sessions = this._sessionStore.getEndToEndSessions(deviceKey);
    var pickledSession = sessions[sessionId];

    var session = new Olm.Session();
    try {
        session.unpickle(this._pickleKey, pickledSession);
        return func(session);
    } finally {
        session.free();
    }
};


/**
 * store our OlmSession in the session store
 *
 * @param {string} deviceKey
 * @param {OlmSession} session
 * @private
 */
OlmDevice.prototype._saveSession = function(deviceKey, session) {
    var pickledSession = session.pickle(this._pickleKey);
    this._sessionStore.storeEndToEndSession(
        deviceKey, session.session_id(), pickledSession
    );
};


/**
 * get an OlmUtility and call the given function
 *
 * @param {function} func
 * @return {object} result of func
 * @private
 */
OlmDevice.prototype._getUtility = function(func) {
    var utility = new Olm.Utility();
    try {
        return func(utility);
    } finally {
        utility.free();
    }
};


/**
 * Signs a message with the ed25519 key for this account.
 *
 * @param {string} message  message to be signed
 * @return {string} base64-encoded signature
 */
OlmDevice.prototype.sign = function(message) {
    return this._getAccount(function(account) {
        return account.sign(message);
    });
};

/**
 * Get the current (unused, unpublished) one-time keys for this account.
 *
 * @return {object} one time keys; an object with the single property
 * <tt>curve25519</tt>, which is itself an object mapping key id to Curve25519
 * key.
 */
OlmDevice.prototype.getOneTimeKeys = function() {
    return this._getAccount(function(account) {
        return JSON.parse(account.one_time_keys());
    });
};


/**
 * Get the maximum number of one-time keys we can store.
 *
 * @return {number} number of keys
 */
OlmDevice.prototype.maxNumberOfOneTimeKeys = function() {
    return this._getAccount(function(account) {
        return account.max_number_of_one_time_keys();
    });
};

/**
 * Marks all of the one-time keys as published.
 */
OlmDevice.prototype.markKeysAsPublished = function() {
    var self = this;
    this._getAccount(function(account) {
        account.mark_keys_as_published();
        self._saveAccount(account);
    });
};

/**
 * Generate some new one-time keys
 *
 * @param {number} numKeys number of keys to generate
 */
OlmDevice.prototype.generateOneTimeKeys = function(numKeys) {
    var self = this;
    this._getAccount(function(account) {
        account.generate_one_time_keys(numKeys);
        self._saveAccount(account);
    });
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
    var self = this;
    return this._getAccount(function(account) {
        var session = new Olm.Session();
        try {
            session.create_outbound(account, theirIdentityKey, theirOneTimeKey);
            self._saveSession(theirIdentityKey, session);
            return session.session_id();
        } finally {
            session.free();
        }
    });
};


/**
 * Generate a new inbound session, given an incoming message
 *
 * @param {string} theirDeviceIdentityKey remote user's Curve25519 identity key
 * @param {number} message_type  message_type field from the received message (must be 0)
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {{payload: string, session_id: string}} decrypted payload, and
 *     session id of new session
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

    var self = this;
    return this._getAccount(function(account) {
        var session = new Olm.Session();
        try {
            session.create_inbound_from(account, theirDeviceIdentityKey, ciphertext);
            account.remove_one_time_keys(session);
            self._saveAccount(account);

            var payloadString = session.decrypt(message_type, ciphertext);

            self._saveSession(theirDeviceIdentityKey, session);

            return {
                payload: payloadString,
                session_id: session.session_id(),
            };
        } finally {
            session.free();
        }
    });
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
 * Get the right olm session id for encrypting messages to the given identity key
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @return {string?}  session id, or null if no established session
 */
OlmDevice.prototype.getSessionIdForDevice = function(theirDeviceIdentityKey) {
    var sessionIds = this.getSessionIdsForDevice(theirDeviceIdentityKey);
    if (sessionIds.length === 0) {
        return null;
    }
    // Use the session with the lowest ID.
    sessionIds.sort();
    return sessionIds[0];
};

/**
 * Get information on the active Olm sessions for a device.
 * <p>
 * Returns an array, with an entry for each active session. The first entry in
 * the result will be the one used for outgoing messages. Each entry contains
 * the keys 'hasReceivedMessage' (true if the session has received an incoming
 * message and is therefore past the pre-key stage), and 'sessionId'.
 *
 * @param {string} deviceIdentityKey Curve25519 identity key for the device
 * @return {Array.<{sessionId: string, hasReceivedMessage: Boolean}>}
 */
OlmDevice.prototype.getSessionInfoForDevice = function(deviceIdentityKey) {
    var sessionIds = this.getSessionIdsForDevice(deviceIdentityKey);
    sessionIds.sort();

    var info = [];

    function getSessionInfo(session) {
        return {
            hasReceivedMessage: session.has_received_message()
        };
    }

    for (var i = 0; i < sessionIds.length; i++) {
        var sessionId = sessionIds[i];
        var res = this._getSession(deviceIdentityKey, sessionId, getSessionInfo);
        res.sessionId = sessionId;
        info.push(res);
    }
    return info;
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
    var self = this;

    checkPayloadLength(payloadString);

    return this._getSession(theirDeviceIdentityKey, sessionId, function(session) {
        var res = session.encrypt(payloadString);
        self._saveSession(theirDeviceIdentityKey, session);
        return res;
    });
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
 * @return {string} decrypted payload.
 */
OlmDevice.prototype.decryptMessage = function(
    theirDeviceIdentityKey, sessionId, message_type, ciphertext
) {
    var self = this;

    return this._getSession(theirDeviceIdentityKey, sessionId, function(session) {
        var payloadString = session.decrypt(message_type, ciphertext);
        self._saveSession(theirDeviceIdentityKey, session);

        return payloadString;
    });
};

/**
 * Determine if an incoming messages is a prekey message matching an existing session
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @param {string} sessionId  the id of the active session
 * @param {number} message_type  message_type field from the received message
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {boolean} true if the received message is a prekey message which matches
 *    the given session.
 */
OlmDevice.prototype.matchesSession = function(
    theirDeviceIdentityKey, sessionId, message_type, ciphertext
) {
    if (message_type !== 0) {
        return false;
    }

    return this._getSession(theirDeviceIdentityKey, sessionId, function(session) {
        return session.matches_inbound(ciphertext);
    });
};



// Outbound group session
// ======================

/**
 * store an OutboundGroupSession in _outboundGroupSessionStore
 *
 * @param {Olm.OutboundGroupSession} session
 * @private
 */
OlmDevice.prototype._saveOutboundGroupSession = function(session) {
    var pickledSession = session.pickle(this._pickleKey);
    this._outboundGroupSessionStore[session.session_id()] = pickledSession;
};


/**
 * extract an OutboundGroupSession from _outboundGroupSessionStore and call the
 * given function
 *
 * @param {string} sessionId
 * @param {function} func
 * @return {object} result of func
 * @private
 */
OlmDevice.prototype._getOutboundGroupSession = function(sessionId, func) {
    var pickled = this._outboundGroupSessionStore[sessionId];
    if (pickled === null) {
        throw new Error("Unknown outbound group session " + sessionId);
    }

    var session = new Olm.OutboundGroupSession();
    try {
        session.unpickle(this._pickleKey, pickled);
        return func(session);
    } finally {
        session.free();
    }
};


/**
 * Generate a new outbound group session
 *
 * @return {string} sessionId for the outbound session.
 */
OlmDevice.prototype.createOutboundGroupSession = function() {
    var session = new Olm.OutboundGroupSession();
    try {
        session.create();
        this._saveOutboundGroupSession(session);
        return session.session_id();
    } finally {
        session.free();
    }
};


/**
 * Encrypt an outgoing message with an outbound group session
 *
 * @param {string} sessionId  the id of the outboundgroupsession
 * @param {string} payloadString  payload to be encrypted and sent
 *
 * @return {string} ciphertext
 */
OlmDevice.prototype.encryptGroupMessage = function(sessionId, payloadString) {
    var self = this;

    checkPayloadLength(payloadString);

    return this._getOutboundGroupSession(sessionId, function(session) {
        var res = session.encrypt(payloadString);
        self._saveOutboundGroupSession(session);
        return res;
    });
};

/**
 * Get the session keys for an outbound group session
 *
 * @param {string} sessionId  the id of the outbound group session
 *
 * @return {{chain_index: number, key: string}} current chain index, and
 *     base64-encoded secret key.
 */
OlmDevice.prototype.getOutboundGroupSessionKey = function(sessionId) {
    return this._getOutboundGroupSession(sessionId, function(session) {
        return {
            chain_index: session.message_index(),
            key: session.session_key(),
        };
    });
};


// Inbound group session
// =====================

/**
 * store an InboundGroupSession in the session store
 *
 * @param {string} roomId
 * @param {string} senderCurve25519Key
 * @param {string} sessionId
 * @param {Olm.InboundGroupSession} session
 * @param {object} keysClaimed Other keys the sender claims.
 * @private
 */
OlmDevice.prototype._saveInboundGroupSession = function(
    roomId, senderCurve25519Key, sessionId, session, keysClaimed
) {
    var r = {
        room_id: roomId,
        session: session.pickle(this._pickleKey),
        keysClaimed: keysClaimed,
    };

    this._sessionStore.storeEndToEndInboundGroupSession(
        senderCurve25519Key, sessionId, JSON.stringify(r)
    );
};

/**
 * extract an InboundGroupSession from the session store and call the given function
 *
 * @param {string} roomId
 * @param {string} senderKey
 * @param {string} sessionId
 * @param {function(Olm.InboundGroupSession, Object<string, string>): T} func
 *   function to call. Second argument is the map of keys claimed by the session.
 *
 * @return {null} the sessionId is unknown
 *
 * @return {T} result of func
 *
 * @private
 * @template {T}
 */
OlmDevice.prototype._getInboundGroupSession = function(
    roomId, senderKey, sessionId, func
) {
    var r = this._sessionStore.getEndToEndInboundGroupSession(
        senderKey, sessionId
    );

    if (r === null) {
        return null;
    }

    r = JSON.parse(r);

    // check that the room id matches the original one for the session. This stops
    // the HS pretending a message was targeting a different room.
    if (roomId !== r.room_id) {
        throw new Error(
            "Mismatched room_id for inbound group session (expected " + r.room_id +
                ", was " + roomId + ")"
        );
    }

    var session = new Olm.InboundGroupSession();
    try {
        session.unpickle(this._pickleKey, r.session);
        return func(session, r.keysClaimed || {});
    } finally {
        session.free();
    }
};

/**
 * Add an inbound group session to the session store
 *
 * @param {string} roomId     room in which this session will be used
 * @param {string} senderKey  base64-encoded curve25519 key of the sender
 * @param {string} sessionId  session identifier
 * @param {string} sessionKey base64-encoded secret key
 * @param {Object<string, string>} keysClaimed Other keys the sender claims.
 */
OlmDevice.prototype.addInboundGroupSession = function(
    roomId, senderKey, sessionId, sessionKey, keysClaimed
) {
    var self = this;

    /* if we already have this session, consider updating it */
    function updateSession(session) {
        console.log("Update for megolm session " + senderKey + "/" + sessionId);
        // for now we just ignore updates. TODO: implement something here

        return true;
    }

    var r = this._getInboundGroupSession(
        roomId, senderKey, sessionId, updateSession
    );

    if (r !== null) {
        return;
    }

    // new session.
    var session = new Olm.InboundGroupSession();
    try {
        session.create(sessionKey);
        if (sessionId != session.session_id()) {
            throw new Error(
                "Mismatched group session ID from senderKey: " + senderKey
            );
        }
        self._saveInboundGroupSession(
            roomId, senderKey, sessionId, session, keysClaimed
        );
    } finally {
        session.free();
    }
};

/**
 * Decrypt a received message with an inbound group session
 *
 * @param {string} roomId    room in which the message was received
 * @param {string} senderKey base64-encoded curve25519 key of the sender
 * @param {string} sessionId session identifier
 * @param {string} body      base64-encoded body of the encrypted message
 *
 * @return {null} the sessionId is unknown
 *
 * @return {{result: string, keysProved: Object<string, string>, keysClaimed:
 *    Object<string, string>}} result
 */
OlmDevice.prototype.decryptGroupMessage = function(
    roomId, senderKey, sessionId, body
) {
    var self = this;

    function decrypt(session, keysClaimed) {
        var res = session.decrypt(body);

        var plaintext = res.plaintext;
        if (plaintext === undefined) {
            // Compatibility for older olm versions.
            plaintext = res;
        } else {
            // Check if we have seen this message index before to detect replay attacks.
            var messageIndexKey = senderKey + "|" + sessionId + "|" + res.message_index;
            if (messageIndexKey in self._inboundGroupSessionMessageIndexes) {
                throw new Error(
                    "Duplicate message index, possible replay attack: " +
                    messageIndexKey
                );
            }
            self._inboundGroupSessionMessageIndexes[messageIndexKey] = true;
        }

        // the sender must have had the senderKey to persuade us to save the
        // session.
        var keysProved = {curve25519: senderKey};

        self._saveInboundGroupSession(
            roomId, senderKey, sessionId, session, keysClaimed
        );
        return {
            result: plaintext,
            keysClaimed: keysClaimed,
            keysProved: keysProved,
        };
    }

    return this._getInboundGroupSession(
        roomId, senderKey, sessionId, decrypt
    );
};


// Utilities
// =========

/**
 * Verify an ed25519 signature.
 *
 * @param {string} key ed25519 key
 * @param {string} message message which was signed
 * @param {string} signature base64-encoded signature to be checked
 *
 * @raises {Error} if there is a problem with the verification. If the key was
 * too small then the message will be "OLM.INVALID_BASE64". If the signature
 * was invalid then the message will be "OLM.BAD_MESSAGE_MAC".
 */
OlmDevice.prototype.verifySignature = function(
    key, message, signature
) {
    this._getUtility(function(util) {
        util.ed25519_verify(key, message, signature);
    });
};

/** */
module.exports = OlmDevice;
