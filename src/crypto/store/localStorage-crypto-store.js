/*
Copyright 2017, 2018 New Vector Ltd

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

import Promise from 'bluebird';

import logger from '../../logger';
import MemoryCryptoStore from './memory-crypto-store.js';

/**
 * Internal module. Partial localStorage backed storage for e2e.
 * This is not a full crypto store, just the in-memory store with
 * some things backed by localStorage. It exists because indexedDB
 * is broken in Firefox private mode or set to, "will not remember
 * history".
 *
 * @module
 */

const E2E_PREFIX = "crypto.";
const KEY_END_TO_END_ACCOUNT = E2E_PREFIX + "account";
const KEY_DEVICE_DATA = E2E_PREFIX + "device_data";
const KEY_INBOUND_SESSION_PREFIX = E2E_PREFIX + "inboundgroupsessions/";
const KEY_ROOMS_PREFIX = E2E_PREFIX + "rooms/";
const KEY_SESSIONS_NEEDING_BACKUP = E2E_PREFIX + "sessionsneedingbackup";

function keyEndToEndSessions(deviceKey) {
    return E2E_PREFIX + "sessions/" + deviceKey;
}

function keyEndToEndInboundGroupSession(senderKey, sessionId) {
    return KEY_INBOUND_SESSION_PREFIX + senderKey + "/" + sessionId;
}

function keyEndToEndRoomsPrefix(roomId) {
    return KEY_ROOMS_PREFIX + roomId;
}

/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
export default class LocalStorageCryptoStore extends MemoryCryptoStore {
    constructor(webStore) {
        super();
        this.store = webStore;
    }

    // Olm Sessions

    countEndToEndSessions(txn, func) {
        let count = 0;
        for (let i = 0; i < this.store.length; ++i) {
            if (this.store.key(i).startsWith(keyEndToEndSessions(''))) ++count;
        }
        func(count);
    }

    _getEndToEndSessions(deviceKey, txn, func) {
        const sessions = getJsonItem(this.store, keyEndToEndSessions(deviceKey));
        const fixedSessions = {};

        // fix up any old sessions to be objects rather than just the base64 pickle
        for (const [sid, val] of Object.entries(sessions || {})) {
            if (typeof val === 'string') {
                fixedSessions[sid] = {
                    session: val,
                };
            } else {
                fixedSessions[sid] = val;
            }
        }

        return fixedSessions;
    }

    getEndToEndSession(deviceKey, sessionId, txn, func) {
        const sessions = this._getEndToEndSessions(deviceKey);
        func(sessions[sessionId] || {});
    }

    getEndToEndSessions(deviceKey, txn, func) {
        func(this._getEndToEndSessions(deviceKey) || {});
    }

    storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
        const sessions = this._getEndToEndSessions(deviceKey) || {};
        sessions[sessionId] = sessionInfo;
        setJsonItem(
            this.store, keyEndToEndSessions(deviceKey), sessions,
        );
    }

    // Inbound Group Sessions

    getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        func(getJsonItem(
            this.store,
            keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
        ));
    }

    getAllEndToEndInboundGroupSessions(txn, func) {
        for (let i = 0; i < this.store.length; ++i) {
            const key = this.store.key(i);
            if (key.startsWith(KEY_INBOUND_SESSION_PREFIX)) {
                // we can't use split, as the components we are trying to split out
                // might themselves contain '/' characters. We rely on the
                // senderKey being a (32-byte) curve25519 key, base64-encoded
                // (hence 43 characters long).

                func({
                    senderKey: key.substr(KEY_INBOUND_SESSION_PREFIX.length, 43),
                    sessionId: key.substr(KEY_INBOUND_SESSION_PREFIX.length + 44),
                    sessionData: getJsonItem(this.store, key),
                });
            }
        }
        func(null);
    }

    addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const existing = getJsonItem(
            this.store,
            keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
        );
        if (!existing) {
            this.storeEndToEndInboundGroupSession(
                senderCurve25519Key, sessionId, sessionData, txn,
            );
        }
    }

    storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        setJsonItem(
            this.store,
            keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
            sessionData,
        );
    }

    getEndToEndDeviceData(txn, func) {
        func(getJsonItem(
            this.store, KEY_DEVICE_DATA,
        ));
    }

    storeEndToEndDeviceData(deviceData, txn) {
        setJsonItem(
            this.store, KEY_DEVICE_DATA, deviceData,
        );
    }

    storeEndToEndRoom(roomId, roomInfo, txn) {
        setJsonItem(
            this.store, keyEndToEndRoomsPrefix(roomId), roomInfo,
        );
    }

    getEndToEndRooms(txn, func) {
        const result = {};
        const prefix = keyEndToEndRoomsPrefix('');

        for (let i = 0; i < this.store.length; ++i) {
            const key = this.store.key(i);
            if (key.startsWith(prefix)) {
                const roomId = key.substr(prefix.length);
                result[roomId] = getJsonItem(this.store, key);
            }
        }
        func(result);
    }

    getSessionsNeedingBackup(limit) {
        const sessionsNeedingBackup
              = getJsonItem(this.store, KEY_SESSIONS_NEEDING_BACKUP) || {};
        const sessions = [];

        for (const session in sessionsNeedingBackup) {
            if (Object.prototype.hasOwnProperty.call(sessionsNeedingBackup, session)) {
                // see getAllEndToEndInboundGroupSessions for the magic number explanations
                const senderKey = session.substr(0, 43);
                const sessionId = session.substr(44);
                this.getEndToEndInboundGroupSession(
                    senderKey, sessionId, null,
                    (sessionData) => {
                        sessions.push({
                            senderKey: senderKey,
                            sessionId: sessionId,
                            sessionData: sessionData,
                        });
                    },
                );
                if (limit && session.length >= limit) {
                    break;
                }
            }
        }
        return Promise.resolve(sessions);
    }

    unmarkSessionsNeedingBackup(sessions) {
        const sessionsNeedingBackup
              = getJsonItem(this.store, KEY_SESSIONS_NEEDING_BACKUP) || {};
        for (const session of sessions) {
            delete sessionsNeedingBackup[session.senderKey + '/' + session.sessionId];
        }
        setJsonItem(
            this.store, KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup,
        );
        return Promise.resolve();
    }

    markSessionsNeedingBackup(sessions) {
        const sessionsNeedingBackup
              = getJsonItem(this.store, KEY_SESSIONS_NEEDING_BACKUP) || {};
        for (const session of sessions) {
            sessionsNeedingBackup[session.senderKey + '/' + session.sessionId] = true;
        }
        setJsonItem(
            this.store, KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup,
        );
        return Promise.resolve();
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} Promise which resolves when the store has been cleared.
     */
    deleteAllData() {
        this.store.removeItem(KEY_END_TO_END_ACCOUNT);
        return Promise.resolve();
    }

    // Olm account

    getAccount(txn, func) {
        const account = getJsonItem(this.store, KEY_END_TO_END_ACCOUNT);
        func(account);
    }

    storeAccount(txn, newData) {
        setJsonItem(
            this.store, KEY_END_TO_END_ACCOUNT, newData,
        );
    }

    doTxn(mode, stores, func) {
        return Promise.resolve(func(null));
    }
}

function getJsonItem(store, key) {
    try {
        // if the key is absent, store.getItem() returns null, and
        // JSON.parse(null) === null, so this returns null.
        return JSON.parse(store.getItem(key));
    } catch (e) {
        logger.log("Error: Failed to get key %s: %s", key, e.stack || e);
        logger.log(e.stack);
    }
    return null;
}

function setJsonItem(store, key, val) {
    store.setItem(key, JSON.stringify(val));
}
