/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd

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

import logger from '../logger';
import IndexedDBCryptoStore from './store/indexeddb-crypto-store';

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
 * Attempts to load the OlmAccount from the crypto store, or creates one if none is
 * found.
 *
 * Reads the device keys from the OlmAccount object.
 */
OlmDevice.prototype.init = async function() {
    await this._migrateFromSessionStore();

    let e2eKeys;
    const account = new global.Olm.Account();
    try {
        await _initialiseAccount(
            this._sessionStore, this._cryptoStore, this._pickleKey, account,
        );
        e2eKeys = JSON.parse(account.identity_keys());

        this._maxOneTimeKeys = account.max_number_of_one_time_keys();
    } finally {
        account.free();
    }

    this.deviceCurve25519Key = e2eKeys.curve25519;
    this.deviceEd25519Key = e2eKeys.ed25519;
};

async function _initialiseAccount(sessionStore, cryptoStore, pickleKey, account) {
    await cryptoStore.doTxn('readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
        cryptoStore.getAccount(txn, (pickledAccount) => {
            if (pickledAccount !== null) {
                account.unpickle(pickleKey, pickledAccount);
            } else {
                account.create();
                pickledAccount = account.pickle(pickleKey);
                cryptoStore.storeAccount(txn, pickledAccount);
            }
        });
    });
}

/**
 * @return {array} The version of Olm.
 */
OlmDevice.getOlmVersion = function() {
    return global.Olm.get_library_version();
};

OlmDevice.prototype._migrateFromSessionStore = async function() {
    // account
    await this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
            this._cryptoStore.getAccount(txn, (pickledAccount) => {
                if (pickledAccount === null) {
                    // Migrate from sessionStore
                    pickledAccount = this._sessionStore.getEndToEndAccount();
                    if (pickledAccount !== null) {
                        logger.log("Migrating account from session store");
                        this._cryptoStore.storeAccount(txn, pickledAccount);
                    }
                }
            });
        },
    );

    // remove the old account now the transaction has completed. Either we've
    // migrated it or decided not to, either way we want to blow away the old data.
    this._sessionStore.removeEndToEndAccount();

    // sessions
    const sessions = this._sessionStore.getAllEndToEndSessions();
    if (Object.keys(sessions).length > 0) {
        await this._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_SESSIONS], (txn) => {
                // Don't migrate sessions from localstorage if we already have sessions
                // in indexeddb, since this means we've already migrated and an old version
                // has run against the same localstorage and created some spurious sessions.
                this._cryptoStore.countEndToEndSessions(txn, (count) => {
                    if (count) {
                        logger.log("Crypto store already has sessions: not migrating");
                        return;
                    }
                    let numSessions = 0;
                    for (const deviceKey of Object.keys(sessions)) {
                        for (const sessionId of Object.keys(sessions[deviceKey])) {
                            numSessions++;
                            this._cryptoStore.storeEndToEndSession(
                                deviceKey, sessionId, sessions[deviceKey][sessionId], txn,
                            );
                        }
                    }
                    logger.log(
                        "Migrating " + numSessions + " sessions from session store",
                    );
                });
            },
        );

        this._sessionStore.removeAllEndToEndSessions();
    }

    // inbound group sessions
    const ibGroupSessions = this._sessionStore.getAllEndToEndInboundGroupSessionKeys();
    if (Object.keys(ibGroupSessions).length > 0) {
        let numIbSessions = 0;
        await this._cryptoStore.doTxn(
            'readwrite', [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], (txn) => {
                // We always migrate inbound group sessions, even if we already have some
                // in the new store. They should be be safe to migrate.
                for (const s of ibGroupSessions) {
                    try {
                        this._cryptoStore.addEndToEndInboundGroupSession(
                            s.senderKey, s.sessionId,
                            JSON.parse(
                                this._sessionStore.getEndToEndInboundGroupSession(
                                    s.senderKey, s.sessionId,
                                ),
                            ), txn,
                        );
                    } catch (e) {
                        logger.warn(
                            "Failed to migrate session " + s.senderKey + "/" +
                            s.sessionId + ": " + e.stack || e,
                        );
                    }
                    ++numIbSessions;
                }
                logger.log(
                    "Migrated " + numIbSessions +
                    " inbound group sessions from session store",
                );
            },
        );
        this._sessionStore.removeAllEndToEndInboundGroupSessions();
    }
};

/**
 * extract our OlmAccount from the crypto store and call the given function
 * with the account object
 * The `account` object is useable only within the callback passed to this
 * function and will be freed as soon the callback returns. It is *not*
 * useable for the rest of the lifetime of the transaction.
 * This function requires a live transaction object from cryptoStore.doTxn()
 * and therefore may only be called in a doTxn() callback.
 *
 * @param {*} txn Opaque transaction object from cryptoStore.doTxn()
 * @param {function} func
 * @private
 */
OlmDevice.prototype._getAccount = function(txn, func) {
    this._cryptoStore.getAccount(txn, (pickledAccount) => {
        const account = new global.Olm.Account();
        try {
            account.unpickle(this._pickleKey, pickledAccount);
            func(account);
        } finally {
            account.free();
        }
    });
};

/*
 * Saves an account to the crypto store.
 * This function requires a live transaction object from cryptoStore.doTxn()
 * and therefore may only be called in a doTxn() callback.
 *
 * @param {*} txn Opaque transaction object from cryptoStore.doTxn()
 * @param {object} Olm.Account object
 * @private
 */
OlmDevice.prototype._storeAccount = function(txn, account) {
    this._cryptoStore.storeAccount(txn, account.pickle(this._pickleKey));
};

/**
 * extract an OlmSession from the session store and call the given function
 * The session is useable only within the callback passed to this
 * function and will be freed as soon the callback returns. It is *not*
 * useable for the rest of the lifetime of the transaction.
 *
 * @param {string} deviceKey
 * @param {string} sessionId
 * @param {*} txn Opaque transaction object from cryptoStore.doTxn()
 * @param {function} func
 * @private
 */
OlmDevice.prototype._getSession = function(deviceKey, sessionId, txn, func) {
    this._cryptoStore.getEndToEndSession(
        deviceKey, sessionId, txn, (sessionInfo) => {
            this._unpickleSession(sessionInfo, func);
        },
    );
};

/**
 * Creates a session object from a session pickle and executes the given
 * function with it. The session object is destroyed once the function
 * returns.
 *
 * @param {object} sessionInfo
 * @param {function} func
 * @private
 */
OlmDevice.prototype._unpickleSession = function(sessionInfo, func) {
    const session = new global.Olm.Session();
    try {
        session.unpickle(this._pickleKey, sessionInfo.session);
        const unpickledSessInfo = Object.assign({}, sessionInfo, {session});

        func(unpickledSessInfo);
    } finally {
        session.free();
    }
};

/**
 * store our OlmSession in the session store
 *
 * @param {string} deviceKey
 * @param {object} sessionInfo {session: OlmSession, lastReceivedMessageTs: int}
 * @param {*} txn Opaque transaction object from cryptoStore.doTxn()
 * @private
 */
OlmDevice.prototype._saveSession = function(deviceKey, sessionInfo, txn) {
    const sessionId = sessionInfo.session.session_id();
    const pickledSessionInfo = Object.assign(sessionInfo, {
        session: sessionInfo.session.pickle(this._pickleKey),
    });
    this._cryptoStore.storeEndToEndSession(
        deviceKey, sessionId, pickledSessionInfo, txn,
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
    const utility = new global.Olm.Utility();
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
    let result;
    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_ACCOUNT],
        (txn) => {
            this._getAccount(txn, (account) => {
                result = account.sign(message);
            },
        );
    });
    return result;
};

/**
 * Get the current (unused, unpublished) one-time keys for this account.
 *
 * @return {object} one time keys; an object with the single property
 * <tt>curve25519</tt>, which is itself an object mapping key id to Curve25519
 * key.
 */
OlmDevice.prototype.getOneTimeKeys = async function() {
    let result;
    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_ACCOUNT],
        (txn) => {
            this._getAccount(txn, (account) => {
                result = JSON.parse(account.one_time_keys());
            });
        },
    );

    return result;
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
    await this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT],
        (txn) => {
            this._getAccount(txn, (account) => {
                account.mark_keys_as_published();
                this._storeAccount(txn, account);
            });
        },
    );
};

/**
 * Generate some new one-time keys
 *
 * @param {number} numKeys number of keys to generate
 * @return {Promise} Resolved once the account is saved back having generated the keys
 */
OlmDevice.prototype.generateOneTimeKeys = function(numKeys) {
    return this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_ACCOUNT],
        (txn) => {
            this._getAccount(txn, (account) => {
                account.generate_one_time_keys(numKeys);
                this._storeAccount(txn, account);
            });
        },
    );
};

/**
 * Generate a new outbound session
 *
 * The new session will be stored in the cryptoStore.
 *
 * @param {string} theirIdentityKey remote user's Curve25519 identity key
 * @param {string} theirOneTimeKey  remote user's one-time Curve25519 key
 * @return {string} sessionId for the outbound session.
 */
OlmDevice.prototype.createOutboundSession = async function(
    theirIdentityKey, theirOneTimeKey,
) {
    let newSessionId;
    await this._cryptoStore.doTxn(
        'readwrite', [
            IndexedDBCryptoStore.STORE_ACCOUNT,
            IndexedDBCryptoStore.STORE_SESSIONS,
        ],
        (txn) => {
            this._getAccount(txn, (account) => {
                const session = new global.Olm.Session();
                try {
                    session.create_outbound(account, theirIdentityKey, theirOneTimeKey);
                    newSessionId = session.session_id();
                    this._storeAccount(txn, account);
                    const sessionInfo = {
                        session,
                        // Pretend we've received a message at this point, otherwise
                        // if we try to send a message to the device, it won't use
                        // this session
                        lastReceivedMessageTs: Date.now(),
                    };
                    this._saveSession(theirIdentityKey, sessionInfo, txn);
                } finally {
                    session.free();
                }
            });
        },
    );
    return newSessionId;
};


/**
 * Generate a new inbound session, given an incoming message
 *
 * @param {string} theirDeviceIdentityKey remote user's Curve25519 identity key
 * @param {number} messageType  messageType field from the received message (must be 0)
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {{payload: string, session_id: string}} decrypted payload, and
 *     session id of new session
 *
 * @raises {Error} if the received message was not valid (for instance, it
 *     didn't use a valid one-time key).
 */
OlmDevice.prototype.createInboundSession = async function(
    theirDeviceIdentityKey, messageType, ciphertext,
) {
    if (messageType !== 0) {
        throw new Error("Need messageType == 0 to create inbound session");
    }

    let result;
    await this._cryptoStore.doTxn(
        'readwrite', [
            IndexedDBCryptoStore.STORE_ACCOUNT,
            IndexedDBCryptoStore.STORE_SESSIONS,
        ],
        (txn) => {
            this._getAccount(txn, (account) => {
                const session = new global.Olm.Session();
                try {
                    session.create_inbound_from(
                        account, theirDeviceIdentityKey, ciphertext,
                    );
                    account.remove_one_time_keys(session);
                    this._storeAccount(txn, account);

                    const payloadString = session.decrypt(messageType, ciphertext);

                    const sessionInfo = {
                        session,
                        // this counts as a received message: set last received message time
                        // to now
                        lastReceivedMessageTs: Date.now(),
                    };
                    this._saveSession(theirDeviceIdentityKey, sessionInfo, txn);

                    result = {
                        payload: payloadString,
                        session_id: session.session_id(),
                    };
                } finally {
                    session.free();
                }
            });
        },
    );

    return result;
};


/**
 * Get a list of known session IDs for the given device
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @return {Promise<string[]>}  a list of known session ids for the device
 */
OlmDevice.prototype.getSessionIdsForDevice = async function(theirDeviceIdentityKey) {
    let sessionIds;
    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_SESSIONS],
        (txn) => {
            this._cryptoStore.getEndToEndSessions(
                theirDeviceIdentityKey, txn, (sessions) => {
                    sessionIds = Object.keys(sessions);
                },
            );
        },
    );

    return sessionIds;
};

/**
 * Get the right olm session id for encrypting messages to the given identity key
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @return {Promise<?string>}  session id, or null if no established session
 */
OlmDevice.prototype.getSessionIdForDevice = async function(theirDeviceIdentityKey) {
    const sessionInfos = await this.getSessionInfoForDevice(theirDeviceIdentityKey);
    if (sessionInfos.length === 0) {
        return null;
    }
    // Use the session that has most recently received a message
    let idxOfBest = 0;
    for (let i = 1; i < sessionInfos.length; i++) {
        const thisSessInfo = sessionInfos[i];
        const thisLastReceived = thisSessInfo.lastReceivedMessageTs === undefined ?
            0 : thisSessInfo.lastReceivedMessageTs;

        const bestSessInfo = sessionInfos[idxOfBest];
        const bestLastReceived = bestSessInfo.lastReceivedMessageTs === undefined ?
            0 : bestSessInfo.lastReceivedMessageTs;
        if (
            thisLastReceived > bestLastReceived || (
                thisLastReceived === bestLastReceived &&
                thisSessInfo.sessionId < bestSessInfo.sessionId
            )
        ) {
            idxOfBest = i;
        }
    }
    return sessionInfos[idxOfBest].sessionId;
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
    const info = [];

    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_SESSIONS],
        (txn) => {
            this._cryptoStore.getEndToEndSessions(deviceIdentityKey, txn, (sessions) => {
                const sessionIds = Object.keys(sessions).sort();
                for (const sessionId of sessionIds) {
                    this._unpickleSession(sessions[sessionId], (sessInfo) => {
                        info.push({
                            lastReceivedMessageTs: sessInfo.lastReceivedMessageTs,
                            hasReceivedMessage: sessInfo.session.has_received_message(),
                            sessionId: sessionId,
                        });
                    });
                }
            });
        },
    );

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
    checkPayloadLength(payloadString);

    let res;
    await this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_SESSIONS],
        (txn) => {
            this._getSession(theirDeviceIdentityKey, sessionId, txn, (sessionInfo) => {
                res = sessionInfo.session.encrypt(payloadString);
                this._saveSession(theirDeviceIdentityKey, sessionInfo, txn);
            });
        },
    );
    return res;
};

/**
 * Decrypt an incoming message using an existing session
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @param {string} sessionId  the id of the active session
 * @param {number} messageType  messageType field from the received message
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {Promise<string>} decrypted payload.
 */
OlmDevice.prototype.decryptMessage = async function(
    theirDeviceIdentityKey, sessionId, messageType, ciphertext,
) {
    let payloadString;
    await this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_SESSIONS],
        (txn) => {
            this._getSession(theirDeviceIdentityKey, sessionId, txn, (sessionInfo) => {
                payloadString = sessionInfo.session.decrypt(messageType, ciphertext);
                sessionInfo.lastReceivedMessageTs = Date.now();
                this._saveSession(theirDeviceIdentityKey, sessionInfo, txn);
            });
        },
    );
    return payloadString;
};

/**
 * Determine if an incoming messages is a prekey message matching an existing session
 *
 * @param {string} theirDeviceIdentityKey Curve25519 identity key for the
 *     remote device
 * @param {string} sessionId  the id of the active session
 * @param {number} messageType  messageType field from the received message
 * @param {string} ciphertext base64-encoded body from the received message
 *
 * @return {Promise<boolean>} true if the received message is a prekey message which matches
 *    the given session.
 */
OlmDevice.prototype.matchesSession = async function(
    theirDeviceIdentityKey, sessionId, messageType, ciphertext,
) {
    if (messageType !== 0) {
        return false;
    }

    let matches;
    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_SESSIONS],
        (txn) => {
            this._getSession(theirDeviceIdentityKey, sessionId, txn, (sessionInfo) => {
                matches = sessionInfo.session.matches_inbound(ciphertext);
            });
        },
    );
    return matches;
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
    if (pickled === undefined) {
        throw new Error("Unknown outbound group session " + sessionId);
    }

    const session = new global.Olm.OutboundGroupSession();
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
    const session = new global.Olm.OutboundGroupSession();
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
 * Unpickle a session from a sessionData object and invoke the given function.
 * The session is valid only until func returns.
 *
 * @param {Object} sessionData Object describing the session.
 * @param {function(Olm.InboundGroupSession)} func Invoked with the unpickled session
 * @return {*} result of func
 */
OlmDevice.prototype._unpickleInboundGroupSession = function(sessionData, func) {
    const session = new global.Olm.InboundGroupSession();
    try {
        session.unpickle(this._pickleKey, sessionData.session);
        return func(session);
    } finally {
        session.free();
    }
};

/**
 * extract an InboundGroupSession from the crypto store and call the given function
 *
 * @param {string} roomId The room ID to extract the session for, or null to fetch
 *     sessions for any room.
 * @param {string} senderKey
 * @param {string} sessionId
 * @param {*} txn Opaque transaction object from cryptoStore.doTxn()
 * @param {function(Olm.InboundGroupSession, InboundGroupSessionData)} func
 *   function to call.
 *
 * @private
 */
OlmDevice.prototype._getInboundGroupSession = function(
    roomId, senderKey, sessionId, txn, func,
) {
    this._cryptoStore.getEndToEndInboundGroupSession(
        senderKey, sessionId, txn, (sessionData) => {
            if (sessionData === null) {
                func(null);
                return;
            }

            // if we were given a room ID, check that the it matches the original one for the session. This stops
            // the HS pretending a message was targeting a different room.
            if (roomId !== null && roomId !== sessionData.room_id) {
                throw new Error(
                    "Mismatched room_id for inbound group session (expected " +
                    sessionData.room_id + ", was " + roomId + ")",
                );
            }

            this._unpickleInboundGroupSession(sessionData, (session) => {
                func(session, sessionData);
            });
        },
    );
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
    await this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], (txn) => {
            /* if we already have this session, consider updating it */
            this._getInboundGroupSession(
                roomId, senderKey, sessionId, txn,
                (existingSession, existingSessionData) => {
                    if (existingSession) {
                        logger.log(
                            "Update for megolm session " + senderKey + "/" + sessionId,
                        );
                        // for now we just ignore updates. TODO: implement something here
                        return;
                    }

                    // new session.
                    const session = new global.Olm.InboundGroupSession();
                    try {
                        if (exportFormat) {
                            session.import_session(sessionKey);
                        } else {
                            session.create(sessionKey);
                        }
                        if (sessionId != session.session_id()) {
                            throw new Error(
                                "Mismatched group session ID from senderKey: " +
                                senderKey,
                            );
                        }

                        const sessionData = {
                            room_id: roomId,
                            session: session.pickle(this._pickleKey),
                            keysClaimed: keysClaimed,
                            forwardingCurve25519KeyChain: forwardingCurve25519KeyChain,
                        };

                        this._cryptoStore.addEndToEndInboundGroupSession(
                            senderKey, sessionId, sessionData, txn,
                        );
                    } finally {
                        session.free();
                    }
                },
            );
        },
    );
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
    let result;

    await this._cryptoStore.doTxn(
        'readwrite', [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], (txn) => {
            this._getInboundGroupSession(
                roomId, senderKey, sessionId, txn, (session, sessionData) => {
                    if (session === null) {
                        result = null;
                        return;
                    }
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
                        const messageIndexKey = (
                            senderKey + "|" + sessionId + "|" + res.message_index
                        );
                        if (messageIndexKey in this._inboundGroupSessionMessageIndexes) {
                            const msgInfo = (
                                this._inboundGroupSessionMessageIndexes[messageIndexKey]
                            );
                            if (
                                msgInfo.id !== eventId ||
                                msgInfo.timestamp !== timestamp
                            ) {
                                throw new Error(
                                    "Duplicate message index, possible replay attack: " +
                                    messageIndexKey,
                                );
                            }
                        }
                        this._inboundGroupSessionMessageIndexes[messageIndexKey] = {
                            id: eventId,
                            timestamp: timestamp,
                        };
                    }

                    sessionData.session = session.pickle(this._pickleKey);
                    this._cryptoStore.storeEndToEndInboundGroupSession(
                        senderKey, sessionId, sessionData, txn,
                    );
                    result = {
                        result: plaintext,
                        keysClaimed: sessionData.keysClaimed || {},
                        senderKey: senderKey,
                        forwardingCurve25519KeyChain: (
                            sessionData.forwardingCurve25519KeyChain || []
                        ),
                    };
                },
            );
        },
    );

    return result;
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
    let result;
    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], (txn) => {
            this._cryptoStore.getEndToEndInboundGroupSession(
                senderKey, sessionId, txn, (sessionData) => {
                    if (sessionData === null) {
                        result = false;
                        return;
                    }

                    if (roomId !== sessionData.room_id) {
                        logger.warn(
                            `requested keys for inbound group session ${senderKey}|` +
                            `${sessionId}, with incorrect room_id ` +
                            `(expected ${sessionData.room_id}, ` +
                            `was ${roomId})`,
                        );
                        result = false;
                    } else {
                        result = true;
                    }
                },
            );
        },
    );

    return result;
};

/**
 * Extract the keys to a given megolm session, for sharing
 *
 * @param {string} roomId    room in which the message was received
 * @param {string} senderKey base64-encoded curve25519 key of the sender
 * @param {string} sessionId session identifier
 * @param {integer} chainIndex The chain index at which to export the session.
 *     If omitted, export at the first index we know about.
 *
 * @returns {Promise<{chain_index: number, key: string,
 *        forwarding_curve25519_key_chain: Array<string>,
 *        sender_claimed_ed25519_key: string
 *    }>}
 *    details of the session key. The key is a base64-encoded megolm key in
 *    export format.
 *
 * @throws Error If the given chain index could not be obtained from the known
 *     index (ie. the given chain index is before the first we have).
 */
OlmDevice.prototype.getInboundGroupSessionKey = async function(
    roomId, senderKey, sessionId, chainIndex,
) {
    let result;
    await this._cryptoStore.doTxn(
        'readonly', [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], (txn) => {
            this._getInboundGroupSession(
                roomId, senderKey, sessionId, txn, (session, sessionData) => {
                    if (session === null) {
                        result = null;
                        return;
                    }

                    if (chainIndex === undefined) {
                        chainIndex = session.first_known_index();
                    }

                    const exportedSession = session.export_session(chainIndex);

                    const claimedKeys = sessionData.keysClaimed || {};
                    const senderEd25519Key = claimedKeys.ed25519 || null;

                    result = {
                        "chain_index": chainIndex,
                        "key": exportedSession,
                        "forwarding_curve25519_key_chain":
                            sessionData.forwardingCurve25519KeyChain || [],
                        "sender_claimed_ed25519_key": senderEd25519Key,
                    };
                },
            );
        },
    );

    return result;
};

/**
 * Export an inbound group session
 *
 * @param {string} senderKey base64-encoded curve25519 key of the sender
 * @param {string} sessionId session identifier
 * @param {string} sessionData The session object from the store
 * @return {module:crypto/OlmDevice.MegolmSessionData} exported session data
 */
OlmDevice.prototype.exportInboundGroupSession = function(
    senderKey, sessionId, sessionData,
) {
    return this._unpickleInboundGroupSession(sessionData, (session) => {
        const messageIndex = session.first_known_index();

        return {
            "sender_key": senderKey,
            "sender_claimed_keys": sessionData.keysClaimed,
            "room_id": sessionData.room_id,
            "session_id": sessionId,
            "session_key": session.export_session(messageIndex),
            "forwarding_curve25519_key_chain": session.forwardingCurve25519KeyChain || [],
            "first_known_index": session.first_known_index(),
        };
    });
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
