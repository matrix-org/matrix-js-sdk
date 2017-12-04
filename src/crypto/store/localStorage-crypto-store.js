/*
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

import Promise from 'bluebird';
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

function keyEndToEndSessions(deviceKey) {
    return E2E_PREFIX + "sessions/" + deviceKey;
}

/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
export default class LocalStorageCryptoStore extends MemoryCryptoStore {
    constructor() {
        super();
        this.store = global.localStorage;
    }

    _getEndToEndSessions(deviceKey, txn, func) {
        return getJsonItem(this.store, keyEndToEndSessions(deviceKey));
    }

    getEndToEndSession(deviceKey, sessionId, txn, func) {
        const sessions = this._getEndToEndSessions(deviceKey);
        func(sessions[sessionId] || {});
    }

    getEndToEndSessions(deviceKey, txn, func) {
        func(this._getEndToEndSessions(deviceKey) || {});
    }

    storeEndToEndSession(deviceKey, sessionId, session, txn) {
        const sessions = this._getEndToEndSessions(deviceKey) || {};
        sessions[sessionId] = session;
        setJsonItem(
            this.store, keyEndToEndSessions(deviceKey), sessions,
        );
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

    getAccount(txn, func) {
        const account = this.store.getItem(KEY_END_TO_END_ACCOUNT);
        func(account);
    }

    storeAccount(txn, newData) {
        this.store.setItem(KEY_END_TO_END_ACCOUNT, newData);
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
        console.log("Failed to get key %s: %s", key, e);
        console.log(e.stack);
    }
    return null;
}

function setJsonItem(store, key, val) {
    store.setItem(key, JSON.stringify(val));
}
