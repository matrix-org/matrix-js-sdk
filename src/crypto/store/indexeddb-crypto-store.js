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
     * an in-memory store.
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
            // Don't fall back to memory in this case: we'd end up recreating
            // a new Olm account in memory and advertising new keys for the
            // same device.
            if (e.name == 'VersionError') {
                throw e;
            }
            console.warn(
                `unable to connect to indexeddb ${this._dbName}` +
                    `: falling back to in-memory store: ${e}`,
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
}
