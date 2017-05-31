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

import q from 'q';

/**
 * Internal module. indexeddb storage for e2e.
 *
 * @module
 */

const VERSION = 1;

/**
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
        if (!indexedDB) {
            throw new Error("must pass indexedDB into IndexedDBCryptoStore");
        }
        this._indexedDB = indexedDB;
        this._dbName = dbName;
        this._dbPromise = null;
    }

    /**
     * Ensure the database exists and is up-to-date
     *
     * @return {Promise} resolves to an instance of IDBDatabase when
     * the database is ready
     */
    connect() {
        if (this._dbPromise) {
            return this._dbPromise;
        }

        this._dbPromise = new q.Promise((resolve, reject) => {
            const req = this._indexedDB.open(this._dbName, VERSION);

            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                const oldVersion = ev.oldVersion;
                console.log(
                    `Upgrading IndexedDBCryptoStore from version ${oldVersion}`
                    + ` to ${VERSION}`,
                );
                if (oldVersion < 1) { // The database did not previously exist.
                    createDatabase(db);
                }
                // Expand as needed.
            };

            req.onblocked = () => {
                reject(new Error(
                    "unable to upgrade indexeddb because it is open elsewhere",
                ));
            };

            req.onerror = (ev) => {
                reject(new Error(
                    "unable to connect to indexeddb: " + ev.target.error,
                ));
            };

            req.onsuccess = (r) => {
                resolve(r.target.result);
            };
        });
        return this._dbPromise;
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} resolves when the store has been cleared.
     */
    deleteAllData() {
        return new q.Promise((resolve, reject) => {
            console.log(`Removing indexeddb instance: ${this._dbName}`);
            const req = this._indexedDB.deleteDatabase(this._dbName);
            req.onerror = (ev) => {
                reject(new Error(
                    "unable to delete indexeddb: " + ev.target.error,
                ));
            };

            req.onsuccess = () => {
                console.log(`Removed indexeddb instance: ${this._dbName}`);
                resolve();
            };
        });
    }
}

function createDatabase(db) {
    const outgoingRoomKeyRequestsStore =
        db.createObjectStore("outgoingRoomKeyRequests", { keyPath: "requestId" });

    // we assume that the RoomKeyRequestBody will have room_id and session_id
    // properties, to make the index efficient.
    outgoingRoomKeyRequestsStore.createIndex("session",
        ["requestBody.room_id", "requestBody.session_id"],
    );

    outgoingRoomKeyRequestsStore.createIndex("state", "state");
}
