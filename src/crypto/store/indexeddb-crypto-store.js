/*
Copyright 2017 Vector Creations Ltd

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

import LocalStorageCryptoStore from './localStorage-crypto-store';
import MemoryCryptoStore from './memory-crypto-store';
import * as IndexedDBCryptoStoreBackend from './indexeddb-crypto-store-backend';

/**
 * Internal module. indexeddb storage for e2e.
 *
 * @module
 */

/**
 * An implementation of CryptoStore, which is normally backed by an indexeddb,
 * but with fallback to MemoryCryptoStore.
 *
 * @implements {module:crypto/store/base~CryptoStore}
 */
export default class IndexedDBCryptoStore {
    /**
     * Create a new IndexedDBCryptoStore
     *
     * @param {IDBFactory} indexedDB  global indexedDB instance
     * @param {string} dbName   name of db to connect to
     */
    constructor(indexedDB, dbName) {
        this._indexedDB = indexedDB;
        this._dbName = dbName;
        this._backendPromise = null;
    }

    /**
     * Ensure the database exists and is up-to-date, or fall back to
     * a local storage or in-memory store.
     *
     * @return {Promise} resolves to either an IndexedDBCryptoStoreBackend.Backend,
     * or a MemoryCryptoStore
     */
    _connect() {
        if (this._backendPromise) {
            return this._backendPromise;
        }

        this._backendPromise = new Promise((resolve, reject) => {
            if (!this._indexedDB) {
                reject(new Error('no indexeddb support available'));
                return;
            }

            console.log(`connecting to indexeddb ${this._dbName}`);

            const req = this._indexedDB.open(
                this._dbName, IndexedDBCryptoStoreBackend.VERSION,
            );

            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                const oldVersion = ev.oldVersion;
                IndexedDBCryptoStoreBackend.upgradeDatabase(db, oldVersion);
            };

            req.onblocked = () => {
                console.log(
                    `can't yet open IndexedDBCryptoStore because it is open elsewhere`,
                );
            };

            req.onerror = (ev) => {
                reject(ev.target.error);
            };

            req.onsuccess = (r) => {
                const db = r.target.result;

                console.log(`connected to indexeddb ${this._dbName}`);
                resolve(new IndexedDBCryptoStoreBackend.Backend(db));
            };
        }).catch((e) => {
            console.warn(
                `unable to connect to indexeddb ${this._dbName}` +
                    `: falling back to localStorage store: ${e}`,
            );
            return new LocalStorageCryptoStore();
        }).catch((e) => {
            console.warn(
                `unable to open localStorage: falling back to in-memory store: ${e}`,
            );
            return new MemoryCryptoStore();
        });

        return this._backendPromise;
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} resolves when the store has been cleared.
     */
    deleteAllData() {
        return new Promise((resolve, reject) => {
            if (!this._indexedDB) {
                reject(new Error('no indexeddb support available'));
                return;
            }

            console.log(`Removing indexeddb instance: ${this._dbName}`);
            const req = this._indexedDB.deleteDatabase(this._dbName);

            req.onblocked = () => {
                console.log(
                    `can't yet delete IndexedDBCryptoStore because it is open elsewhere`,
                );
            };

            req.onerror = (ev) => {
                reject(ev.target.error);
            };

            req.onsuccess = () => {
                console.log(`Removed indexeddb instance: ${this._dbName}`);
                resolve();
            };
        }).catch((e) => {
            // in firefox, with indexedDB disabled, this fails with a
            // DOMError. We treat this as non-fatal, so that people can
            // still use the app.
            console.warn(`unable to delete IndexedDBCryptoStore: ${e}`);
        });
    }

    /**
     * Look for an existing outgoing room key request, and if none is found,
     * add a new one
     *
     * @param {module:crypto/store/base~OutgoingRoomKeyRequest} request
     *
     * @returns {Promise} resolves to
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}: either the
     *    same instance as passed in, or the existing one.
     */
    getOrAddOutgoingRoomKeyRequest(request) {
        return this._connect().then((backend) => {
            return backend.getOrAddOutgoingRoomKeyRequest(request);
        });
    }

    /**
     * Look for an existing room key request
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    existing request to look for
     *
     * @return {Promise} resolves to the matching
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    not found
     */
    getOutgoingRoomKeyRequest(requestBody) {
        return this._connect().then((backend) => {
            return backend.getOutgoingRoomKeyRequest(requestBody);
        });
    }

    /**
     * Look for room key requests by state
     *
     * @param {Array<Number>} wantedStates list of acceptable states
     *
     * @return {Promise} resolves to the a
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    there are no pending requests in those states. If there are multiple
     *    requests in those states, an arbitrary one is chosen.
     */
    getOutgoingRoomKeyRequestByState(wantedStates) {
        return this._connect().then((backend) => {
            return backend.getOutgoingRoomKeyRequestByState(wantedStates);
        });
    }

    /**
     * Look for an existing room key request by id and state, and update it if
     * found
     *
     * @param {string} requestId      ID of request to update
     * @param {number} expectedState  state we expect to find the request in
     * @param {Object} updates        name/value map of updates to apply
     *
     * @returns {Promise} resolves to
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
     *    updated request, or null if no matching row was found
     */
    updateOutgoingRoomKeyRequest(requestId, expectedState, updates) {
        return this._connect().then((backend) => {
            return backend.updateOutgoingRoomKeyRequest(
                requestId, expectedState, updates,
            );
        });
    }

    /**
     * Look for an existing room key request by id and state, and delete it if
     * found
     *
     * @param {string} requestId      ID of request to update
     * @param {number} expectedState  state we expect to find the request in
     *
     * @returns {Promise} resolves once the operation is completed
     */
    deleteOutgoingRoomKeyRequest(requestId, expectedState) {
        return this._connect().then((backend) => {
            return backend.deleteOutgoingRoomKeyRequest(requestId, expectedState);
        });
    }

    /*
     * Get the account pickle from the store.
     * This requires an active transaction. See doTxn().
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(string)} func Called with the account pickle
     */
    getAccount(txn, func) {
        this._backendPromise.value().getAccount(txn, func);
    }

    /*
     * Write the account pickle to the store.
     * This requires an active transaction. See doTxn().
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {string} newData The new account pickle to store.
     */
    storeAccount(txn, newData) {
        this._backendPromise.value().storeAccount(txn, newData);
    }

    /**
     * Returns the number of end-to-end sessions in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(int)} func Called with the count of sessions
     */
    countEndToEndSessions(txn, func) {
        this._backendPromise.value().countEndToEndSessions(txn, func);
    }

    /**
     * Retrieve a specific end-to-end session between the logged-in user
     * and another device.
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID of the session to retrieve
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to Base64 end-to-end session.
     */
    getEndToEndSession(deviceKey, sessionId, txn, func) {
        this._backendPromise.value().getEndToEndSession(deviceKey, sessionId, txn, func);
    }

    /**
     * Retrieve the end-to-end sessions between the logged-in user and another
     * device.
     * @param {string} deviceKey The public key of the other device.
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to Base64 end-to-end session.
     */
    getEndToEndSessions(deviceKey, txn, func) {
        this._backendPromise.value().getEndToEndSessions(deviceKey, txn, func);
    }

    /**
     * Store a session between the logged-in user and another device
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID for this end-to-end session.
     * @param {string} session Base64 encoded end-to-end session.
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndSession(deviceKey, sessionId, session, txn) {
        this._backendPromise.value().storeEndToEndSession(
            deviceKey, sessionId, session, txn,
        );
    }

    /**
     * Perform a transaction on the crypto store. Any store methods
     * that require a transaction (txn) object to be passed in may
     * only be called within a callback of either this function or
     * one of the store functions operating on the same transaction.
     *
     * @param {string} mode 'readwrite' if you need to call setter
     *     functions with this transaction. Otherwise, 'readonly'.
     * @param {string[]} stores List IndexedDBCryptoStore.STORE_*
     *     options representing all types of object that will be
     *     accessed or written to with this transaction.
     * @param {function(*)} func Function called with the
     *     transaction object: an opaque object that should be passed
     *     to store functions.
     * @return {Promise} Promise that resolves with the result of the `func`
     *     when the transaction is complete. If the backend is
     *     async (ie. the indexeddb backend) any of the callback
     *     functions throwing an exception will cause this promise to
     *     reject with that exception. On synchronous backends, the
     *     exception will propagate to the caller of the getFoo method.
     */
    doTxn(mode, stores, func) {
        return this._connect().then((backend) => {
            return backend.doTxn(mode, stores, func);
        });
    }
}

IndexedDBCryptoStore.STORE_ACCOUNT = 'account';
IndexedDBCryptoStore.STORE_SESSIONS = 'sessions';
