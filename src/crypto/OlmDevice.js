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
const Olm = global.Olm;
if (!Olm) {
    throw new Error("global.Olm is not defined");
}
const utils = require("../utils");


// The maximum size of an event is 65K, and we base64 the content, so this is a
// reasonable approximation to the biggest plaintext we can encrypt.
const MAX_PLAINTEXT_LENGTH = 65536 * 3 / 4;

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
 * The type of object we use for importing and exporting megolm session data.
 *
 * @typedef {Object} module:crypto/OlmDevice.MegolmSessionData
 * @property {String} sender_key  Sender's Curve25519 device key
 * @property {String[]} forwarding_curve25519_key_chain Devices which forwarded
 *     this session to us (normally empty).
 * @property {Object<string, string>} sender_claimed_keys Other keys the sender claims.
 * @property {String} room_id     Room this session is used in
 * @property {String} session_id  Unique id for the session
 * @property {String} session_key Base64'ed key data
 */


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
 *    crypto. This is deprecated and being replaced by cryptoStore.
 * @param {Object} cryptoStore A store for crypto data
 *
 * @property {string} deviceCurve25519Key   Curve25519 key for the account
 * @property {string} deviceEd25519Key      Ed25519 key for the account
 */
function OlmDevice(sessionStore, cryptoStore) {
    this._sessionStore = sessionStore;
    this._cryptoStore = cryptoStore;
    this._pickleKey = "DEFAULT_KEY";

    // don't know these until we load the account from storage in init()
    this.deviceCurve25519Key = null;
    this.deviceEd25519Key = null;
    this._maxOneTimeKeys = null;

    // we don't bother stashing outboundgroupsessions in the sessionstore -
    // instead we keep them here.
    this._outboundGroupSessionStore = {};

    // Store a set of decrypted message indexes for each group session.
    // This partially mitigates a replay attack where a MITM resends a group
    // message into the room.
    //
    // When we decrypt a message and the message index matches a previously
    // decrypted message, one possible cause of that is that we are decrypting
    // the same event, and may not indicate an actual replay attack.  For
    // example, this could happen if we receive events, forget about them, and
    // then re-fetch them when we backfill.  So we store the event ID and
    // timestamp corresponding to each message index when we first decrypt it,
    // and compare these against the event ID and timestamp every time we use
    // that same index.  If they match, then we're probably decrypting the same
    // event and we don't consider it a replay attack.
    //
    // Keys are strings of form "<senderKey>|<session_id>|<message_index>"
    // Values are objects of the form "{id: <event id>, timestamp: <ts>}"
    this._inboundGroupSessionMessageIndexes = {};
}

/**
 * Initialise the OlmAccount. This must be called before any other operations
 * on the OlmDevice.
 *
 * Attempts to load the OlmAccount from localStorage, or creates one if none is
 * found.
 *
 * Reads the device keys from the OlmAccount object.
 */
OlmDevice.prototype.init = async function() {
    let e2eKeys;
    const account = new Olm.Account();
    try {
        await _initialise_account(this._sessionStore, this._cryptoStore, this._pickleKey, account);
        e2eKeys = JSON.parse(account.identity_keys());

        this._maxOneTimeKeys = account.max_number_of_one_time_keys();
    } finally {
        account.free();
    }

    this.deviceCurve25519Key = e2eKeys.curve25519;
    this.deviceEd25519Key = e2eKeys.ed25519;
};


async function _initialise_account(sessionStore, cryptoStore, pickleKey, account) {
    let removeFromSessionStore = false;
    await cryptoStore.endToEndAccountTransaction((accountData, save) => {
        if (accountData !== null) {
            account.unpickle(pickleKey, accountData);
        } else {
            // Migrate from sessionStore
            accountData = sessionStore.getEndToEndAccount();
            if (accountData !== null) {
                removeFromSessionStore = true;
                account.unpickle(pickleKey, accountData);
            } else {
                account.create();
                accountData = account.pickle(pickleKey);
            }
            save(accountData);
        }
    });

    // only remove this once it's safely saved to the crypto store
    if (removeFromSessionStore) {
        sessionStore.removeEndToEndAccount();
    }
}

/**
 * @return {array} The version of Olm.
 */
OlmDevice.getOlmVersion = function() {
    return Olm.get_library_version();
};


/**
 * extract our OlmAccount from the crypto store and call the given function
 * with the account object and a 'save' function which returns a promise.
 * The function will not be awaited upon and the save function must be
 * called before the function returns, or not at all.
 *
 * @param {function} func
 * @return {object} result of func
 * @private
 */
OlmDevice.prototype._getAccount = async function(func) {
    let result;

    await this._cryptoStore.endToEndAccountTransaction((accountData, save) => {
        // Olm has a limited heap size so we must tightly control the number of
        // Olm account objects in existence at any given time: once created, it
        // must be destroyed again before we await.
        const account = new Olm.Account();
        try {
            account.unpickle(this._pickleKey, accountData);

            result = func(account, () => {
                const pickledAccount = account.pickle(this._pickleKey);
                return save(pickledAccount);
            });
        } finally {
            account.free();
        }
    });
    return result;
};


/**
 * store our OlmAccount in the session store
 *
 * @param {OlmAccount} account
 * @private
 */
OlmDevice.prototype._saveAccount = async function(account) {
    const pickledAccount = account.pickle(this._pickleKey);
    await this._cryptoStore.storeEndToEndAccount(pickledAccount);
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
    const sessions = this._sessionStore.getEndToEndSessions(deviceKey);
    const pickledSession = sessions[sessionId];

    const session = new Olm.Session();
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
    const pickledSession = session.pickle(this._pickleKey);
    this._sessionStore.storeEndToEndSession(
        deviceKey, session.session_id(), pickledSession,
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
    const utility = new Olm.Utility();
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
 * @return {Promise<string>} base64-encoded signature
 */
OlmDevice.prototype.sign = async function(message) {
    return await this._getAccount(function(account) {
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
OlmDevice.prototype.getOneTimeKeys = async function() {
    return await this._getAccount(function(account) {
        return JSON.parse(account.one_time_keys());
    });
};


/**
 * Get the maximum number of one-time keys we can store.
 *
 * @return {number} number of keys
 */
OlmDevice.prototype.maxNumberOfOneTimeKeys = function() {
    return this._maxOneTimeKeys;
};

/**
 * Marks all of the one-time keys as published.
 */
OlmDevice.prototype.markKeysAsPublished = async function() {
    await this._getAccount(function(account, save) {
        account.mark_keys_as_published();
        return save();
    });
};

/**
 * Generate some new one-time keys
 *
 * @param {number} numKeys number of keys to generate
 * @return {Promise} Resolved once the account is saved back having generated the keys
 */
OlmDevice.prototype.generateOneTimeKeys = async function(numKeys) {
    return this._getAccount(function(account, save) {
        account.generate_one_time_keys(numKeys);
        return save();
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
OlmDevice.prototype.createOutboundSession = async function(
    theirIdentityKey, theirOneTimeKey,
) {
    const self = this;
    return await this._getAccount(async function(account, save) {
        const session = new Olm.Session();
        try {
            session.create_outbound(account, theirIdentityKey, theirOneTimeKey);
            await save();
            await self._saveSession(theirIdentityKey, session);
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
OlmDevice.prototype.createInboundSession = async function(
    theirDeviceIdentityKey, message_type, ciphertext,
) {
    if (message_type !== 0) {
        throw new Error("Need message_type == 0 to create inbound session");
    }

    const self = this;
    return await this._getAccount(async function(account, save) {
        const session = new Olm.Session();
        try {
            session.create_inbound_from(account, theirDeviceIdentityKey, ciphertext);
            account.remove_one_time_keys(session);
            await save();

            const payloadString = session.decrypt(message_type, ciphertext);

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
 * @return {Promise<string[]>}  a list of known session ids for the device
 */
OlmDevice.prototype.getSessionIdsForDevice = async function(theirDeviceIdentityKey) {
    const sessions = this._sessionStore.getEndToEndSessions(
        theirDeviceIdentityKey,
    );
    return utils.keys(sessions);
};

/**
 * Get the right olm session id for encrypting messages to the given identity key
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @return {Promise<?string>}  session id, or null if no established session
 */
OlmDevice.prototype.getSessionIdForDevice = async function(theirDeviceIdentityKey) {
    const sessionIds = await this.getSessionIdsForDevice(theirDeviceIdentityKey);
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
OlmDevice.prototype.getSessionInfoForDevice = async function(deviceIdentityKey) {
    const sessionIds = await this.getSessionIdsForDevice(deviceIdentityKey);
    sessionIds.sort();

    const info = [];

    function getSessionInfo(session) {
        return {
            hasReceivedMessage: session.has_received_message(),
        };
    }

    for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i];
        const res = this._getSession(deviceIdentityKey, sessionId, getSessionInfo);
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
 * @return {Promise<string>} ciphertext
 */
OlmDevice.prototype.encryptMessage = async function(
    theirDeviceIdentityKey, sessionId, payloadString,
) {
    const self = this;

    checkPayloadLength(payloadString);

    return this._getSession(theirDeviceIdentityKey, sessionId, function(session) {
        const res = session.encrypt(payloadString);
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
 * @return {Promise<string>} decrypted payload.
 */
OlmDevice.prototype.decryptMessage = async function(
    theirDeviceIdentityKey, sessionId, message_type, ciphertext,
) {
    const self = this;

    return this._getSession(theirDeviceIdentityKey, sessionId, function(session) {
        const payloadString = session.decrypt(message_type, ciphertext);
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
 * @return {Promise<boolean>} true if the received message is a prekey message which matches
 *    the given session.
 */
OlmDevice.prototype.matchesSession = async function(
    theirDeviceIdentityKey, sessionId, message_type, ciphertext,
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
    const pickledSession = session.pickle(this._pickleKey);
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
    const pickled = this._outboundGroupSessionStore[sessionId];
    if (pickled === null) {
        throw new Error("Unknown outbound group session " + sessionId);
    }

    const session = new Olm.OutboundGroupSession();
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
    const session = new Olm.OutboundGroupSession();
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
    const self = this;

    checkPayloadLength(payloadString);

    return this._getOutboundGroupSession(sessionId, function(session) {
        const res = session.encrypt(payloadString);
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
 * data stored in the session store about an inbound group session
 *
 * @typedef {Object} InboundGroupSessionData
 * @property {string} room_Id
 * @property {string} session   pickled Olm.InboundGroupSession
 * @property {Object<string, string>} keysClaimed
 * @property {Array<string>} forwardingCurve25519KeyChain  Devices involved in forwarding
 *     this session to us (normally empty).
 */

/**
 * store an InboundGroupSession in the session store
 *
 * @param {string} senderCurve25519Key
 * @param {string} sessionId
 * @param {InboundGroupSessionData} sessionData
 * @private
 */
OlmDevice.prototype._saveInboundGroupSession = function(
    senderCurve25519Key, sessionId, sessionData,
) {
    this._sessionStore.storeEndToEndInboundGroupSession(
        senderCurve25519Key, sessionId, JSON.stringify(sessionData),
    );
};

/**
 * extract an InboundGroupSession from the session store and call the given function
 *
 * @param {string} roomId
 * @param {string} senderKey
 * @param {string} sessionId
 * @param {function(Olm.InboundGroupSession, InboundGroupSessionData): T} func
 *   function to call.
 *
 * @return {null} the sessionId is unknown
 *
 * @return {T} result of func
 *
 * @private
 * @template {T}
 */
OlmDevice.prototype._getInboundGroupSession = function(
    roomId, senderKey, sessionId, func,
) {
    let r = this._sessionStore.getEndToEndInboundGroupSession(
        senderKey, sessionId,
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
                ", was " + roomId + ")",
        );
    }

    const session = new Olm.InboundGroupSession();
    try {
        session.unpickle(this._pickleKey, r.session);
        return func(session, r);
    } finally {
        session.free();
    }
};

/**
 * Add an inbound group session to the session store
 *
 * @param {string} roomId     room in which this session will be used
 * @param {string} senderKey  base64-encoded curve25519 key of the sender
 * @param {Array<string>} forwardingCurve25519KeyChain  Devices involved in forwarding
 *     this session to us.
 * @param {string} sessionId  session identifier
 * @param {string} sessionKey base64-encoded secret key
 * @param {Object<string, string>} keysClaimed Other keys the sender claims.
 * @param {boolean} exportFormat true if the megolm keys are in export format
 *    (ie, they lack an ed25519 signature)
 */
OlmDevice.prototype.addInboundGroupSession = async function(
    roomId, senderKey, forwardingCurve25519KeyChain,
    sessionId, sessionKey, keysClaimed,
    exportFormat,
) {
    const self = this;

    /* if we already have this session, consider updating it */
    function updateSession(session, sessionData) {
        console.log("Update for megolm session " + senderKey + "/" + sessionId);
        // for now we just ignore updates. TODO: implement something here

        return true;
    }

    const r = this._getInboundGroupSession(
        roomId, senderKey, sessionId, updateSession,
    );

    if (r !== null) {
        return;
    }

    // new session.
    const session = new Olm.InboundGroupSession();
    try {
        if (exportFormat) {
            session.import_session(sessionKey);
        } else {
            session.create(sessionKey);
        }
        if (sessionId != session.session_id()) {
            throw new Error(
                "Mismatched group session ID from senderKey: " + senderKey,
            );
        }

        const sessionData = {
            room_id: roomId,
            session: session.pickle(this._pickleKey),
            keysClaimed: keysClaimed,
            forwardingCurve25519KeyChain: forwardingCurve25519KeyChain,
        };

        self._saveInboundGroupSession(
            senderKey, sessionId, sessionData,
        );
    } finally {
        session.free();
    }
};


/**
 * Add a previously-exported inbound group session to the session store
 *
 * @param {module:crypto/OlmDevice.MegolmSessionData} data  session data
 */
OlmDevice.prototype.importInboundGroupSession = async function(data) {
    /* if we already have this session, consider updating it */
    function updateSession(session, sessionData) {
        console.log("Update for megolm session " + data.sender_key + "|" +
                    data.session_id);
        // for now we just ignore updates. TODO: implement something here

        return true;
    }

    const r = this._getInboundGroupSession(
        data.room_id, data.sender_key, data.session_id, updateSession,
    );

    if (r !== null) {
        return;
    }

    // new session.
    const session = new Olm.InboundGroupSession();
    try {
        session.import_session(data.session_key);
        if (data.session_id != session.session_id()) {
            throw new Error(
                "Mismatched group session ID from senderKey: " + data.sender_key,
            );
        }

        const sessionData = {
            room_id: data.room_id,
            session: session.pickle(this._pickleKey),
            keysClaimed: data.sender_claimed_keys,
            forwardingCurve25519KeyChain: data.forwarding_curve25519_key_chain,
        };

        this._saveInboundGroupSession(
            data.sender_key, data.session_id, sessionData,
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
 * @param {string} eventId   ID of the event being decrypted
 * @param {Number} timestamp timestamp of the event being decrypted
 *
 * @return {null} the sessionId is unknown
 *
 * @return {Promise<{result: string, senderKey: string,
 *    forwardingCurve25519KeyChain: Array<string>,
 *    keysClaimed: Object<string, string>}>}
 */
OlmDevice.prototype.decryptGroupMessage = async function(
    roomId, senderKey, sessionId, body, eventId, timestamp,
) {
    const self = this;

    function decrypt(session, sessionData) {
        const res = session.decrypt(body);

        let plaintext = res.plaintext;
        if (plaintext === undefined) {
            // Compatibility for older olm versions.
            plaintext = res;
        } else {
            // Check if we have seen this message index before to detect replay attacks.
            // If the event ID and timestamp are specified, and the match the event ID
            // and timestamp from the last time we used this message index, then we
            // don't consider it a replay attack.
            const messageIndexKey = senderKey + "|" + sessionId + "|" + res.message_index;
            if (messageIndexKey in self._inboundGroupSessionMessageIndexes) {
                const msgInfo = self._inboundGroupSessionMessageIndexes[messageIndexKey];
                if (msgInfo.id !== eventId || msgInfo.timestamp !== timestamp) {
                    throw new Error(
                        "Duplicate message index, possible replay attack: " +
                        messageIndexKey,
                    );
                }
            }
            self._inboundGroupSessionMessageIndexes[messageIndexKey] = {
                id: eventId,
                timestamp: timestamp,
            };
        }

        sessionData.session = session.pickle(self._pickleKey);
        self._saveInboundGroupSession(
            senderKey, sessionId, sessionData,
        );
        return {
            result: plaintext,
            keysClaimed: sessionData.keysClaimed || {},
            senderKey: senderKey,
            forwardingCurve25519KeyChain: sessionData.forwardingCurve25519KeyChain || [],
        };
    }

    return this._getInboundGroupSession(
        roomId, senderKey, sessionId, decrypt,
    );
};

/**
 * Determine if we have the keys for a given megolm session
 *
 * @param {string} roomId    room in which the message was received
 * @param {string} senderKey base64-encoded curve25519 key of the sender
 * @param {sring} sessionId session identifier
 *
 * @returns {Promise<boolean>} true if we have the keys to this session
 */
OlmDevice.prototype.hasInboundSessionKeys = async function(roomId, senderKey, sessionId) {
    const s = this._sessionStore.getEndToEndInboundGroupSession(
        senderKey, sessionId,
    );

    if (s === null) {
        return false;
    }

    const r = JSON.parse(s);
    if (roomId !== r.room_id) {
        console.warn(
            `requested keys for inbound group session ${senderKey}|` +
            `${sessionId}, with incorrect room_id (expected ${r.room_id}, ` +
            `was ${roomId})`,
        );
        return false;
    }

    return true;
};

/**
 * Extract the keys to a given megolm session, for sharing
 *
 * @param {string} roomId    room in which the message was received
 * @param {string} senderKey base64-encoded curve25519 key of the sender
 * @param {string} sessionId session identifier
 *
 * @returns {Promise<{chain_index: number, key: string,
 *        forwarding_curve25519_key_chain: Array<string>,
 *        sender_claimed_ed25519_key: string
 *    }>}
 *    details of the session key. The key is a base64-encoded megolm key in
 *    export format.
 */
OlmDevice.prototype.getInboundGroupSessionKey = async function(
    roomId, senderKey, sessionId,
) {
    function getKey(session, sessionData) {
        const messageIndex = session.first_known_index();

        const claimedKeys = sessionData.keysClaimed || {};
        const senderEd25519Key = claimedKeys.ed25519 || null;

        return {
            "chain_index": messageIndex,
            "key": session.export_session(messageIndex),
            "forwarding_curve25519_key_chain":
                sessionData.forwardingCurve25519KeyChain || [],
            "sender_claimed_ed25519_key": senderEd25519Key,
        };
    }

    return this._getInboundGroupSession(
        roomId, senderKey, sessionId, getKey,
    );
};

/**
 * Export an inbound group session
 *
 * @param {string} senderKey base64-encoded curve25519 key of the sender
 * @param {string} sessionId session identifier
 * @return {Promise<module:crypto/OlmDevice.MegolmSessionData>} exported session data
 */
OlmDevice.prototype.exportInboundGroupSession = async function(senderKey, sessionId) {
    const s = this._sessionStore.getEndToEndInboundGroupSession(
        senderKey, sessionId,
    );

    if (s === null) {
        throw new Error("Unknown inbound group session [" + senderKey + "," +
                        sessionId + "]");
    }
    const r = JSON.parse(s);

    const session = new Olm.InboundGroupSession();
    try {
        session.unpickle(this._pickleKey, r.session);

        const messageIndex = session.first_known_index();

        return {
            "sender_key": senderKey,
            "sender_claimed_keys": r.keysClaimed,
            "room_id": r.room_id,
            "session_id": sessionId,
            "session_key": session.export_session(messageIndex),
            "forwarding_curve25519_key_chain":
                session.forwardingCurve25519KeyChain || [],
        };
    } finally {
        session.free();
    }
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
    key, message, signature,
) {
    this._getUtility(function(util) {
        util.ed25519_verify(key, message, signature);
    });
};

/** */
module.exports = OlmDevice;
