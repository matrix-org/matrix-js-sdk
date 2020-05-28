/*
Copyright 2017, 2018 New Vector Ltd
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import {logger} from '../../logger';
import {MemoryCryptoStore} from './memory-crypto-store';

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
const KEY_CROSS_SIGNING_KEYS = E2E_PREFIX + "cross_signing_keys";
const KEY_NOTIFIED_ERROR_DEVICES = E2E_PREFIX + "notified_error_devices";
const KEY_DEVICE_DATA = E2E_PREFIX + "device_data";
const KEY_INBOUND_SESSION_PREFIX = E2E_PREFIX + "inboundgroupsessions/";
const KEY_INBOUND_SESSION_WITHHELD_PREFIX = E2E_PREFIX + "inboundgroupsessions.withheld/";
const KEY_ROOMS_PREFIX = E2E_PREFIX + "rooms/";
const KEY_SESSIONS_NEEDING_BACKUP = E2E_PREFIX + "sessionsneedingbackup";

function keyEndToEndSessions(deviceKey) {
    return E2E_PREFIX + "sessions/" + deviceKey;
}

function keyEndToEndSessionProblems(deviceKey) {
    return E2E_PREFIX + "session.problems/" + deviceKey;
}

function keyEndToEndInboundGroupSession(senderKey, sessionId) {
    return KEY_INBOUND_SESSION_PREFIX + senderKey + "/" + sessionId;
}

function keyEndToEndInboundGroupSessionWithheld(senderKey, sessionId) {
    return KEY_INBOUND_SESSION_WITHHELD_PREFIX + senderKey + "/" + sessionId;
}

function keyEndToEndRoomsPrefix(roomId) {
    return KEY_ROOMS_PREFIX + roomId;
}

/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
export class LocalStorageCryptoStore extends MemoryCryptoStore {
    constructor(webStore) {
        super();
        this.store = webStore;
    }

    static exists(webStore) {
        const length = webStore.length;
        for (let i = 0; i < length; i++) {
            if (webStore.key(i).startsWith(E2E_PREFIX)) {
                return true;
            }
        }
        return false;
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

    getAllEndToEndSessions(txn, func) {
        for (let i = 0; i < this.store.length; ++i) {
            if (this.store.key(i).startsWith(keyEndToEndSessions(''))) {
                const deviceKey = this.store.key(i).split('/')[1];
                for (const sess of Object.values(this._getEndToEndSessions(deviceKey))) {
                    func(sess);
                }
            }
        }
    }

    storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
        const sessions = this._getEndToEndSessions(deviceKey) || {};
        sessions[sessionId] = sessionInfo;
        setJsonItem(
            this.store, keyEndToEndSessions(deviceKey), sessions,
        );
    }

    async storeEndToEndSessionProblem(deviceKey, type, fixed) {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = getJsonItem(this.store, key) || [];
        problems.push({type, fixed, time: Date.now()});
        problems.sort((a, b) => {
            return a.time - b.time;
        });
        setJsonItem(this.store, key, problems);
    }

    async getEndToEndSessionProblem(deviceKey, timestamp) {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = getJsonItem(this.store, key) || [];
        if (!problems.length) {
            return null;
        }
        const lastProblem = problems[problems.length - 1];
        for (const problem of problems) {
            if (problem.time > timestamp) {
                return Object.assign({}, problem, {fixed: lastProblem.fixed});
            }
        }
        if (lastProblem.fixed) {
            return null;
        } else {
            return lastProblem;
        }
    }

    async filterOutNotifiedErrorDevices(devices) {
        const notifiedErrorDevices =
              getJsonItem(this.store, KEY_NOTIFIED_ERROR_DEVICES) || {};
        const ret = [];

        for (const device of devices) {
            const {userId, deviceInfo} = device;
            if (userId in notifiedErrorDevices) {
                if (!(deviceInfo.deviceId in notifiedErrorDevices[userId])) {
                    ret.push(device);
                    notifiedErrorDevices[userId][deviceInfo.deviceId] = true;
                }
            } else {
                ret.push(device);
                notifiedErrorDevices[userId] = {[deviceInfo.deviceId]: true };
            }
        }

        setJsonItem(this.store, KEY_NOTIFIED_ERROR_DEVICES, notifiedErrorDevices);

        return ret;
    }

    // Inbound Group Sessions

    getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        func(
            getJsonItem(
                this.store,
                keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
            ),
            getJsonItem(
                this.store,
                keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
            ),
        );
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

    storeEndToEndInboundGroupSessionWithheld(
        senderCurve25519Key, sessionId, sessionData, txn,
    ) {
        setJsonItem(
            this.store,
            keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
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

    countSessionsNeedingBackup() {
        const sessionsNeedingBackup
              = getJsonItem(this.store, KEY_SESSIONS_NEEDING_BACKUP) || {};
        return Promise.resolve(Object.keys(sessionsNeedingBackup).length);
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

    getCrossSigningKeys(txn, func) {
        const keys = getJsonItem(this.store, KEY_CROSS_SIGNING_KEYS);
        func(keys);
    }

    getSecretStorePrivateKey(txn, func, type) {
        const key = getJsonItem(this.store, E2E_PREFIX + `ssss_cache.${type}`);
        func(key);
    }

    storeCrossSigningKeys(txn, keys) {
        setJsonItem(
            this.store, KEY_CROSS_SIGNING_KEYS, keys,
        );
    }

    storeSecretStorePrivateKey(txn, type, key) {
        setJsonItem(
            this.store, E2E_PREFIX + `ssss_cache.${type}`, key,
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
