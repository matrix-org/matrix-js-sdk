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
import SyncAccumulator from "../sync-accumulator";
import utils from "../utils";

const VERSION = 1;

function createDatabase(db) {
    // Make user store, clobber based on user ID. (userId property of User objects)
    db.createObjectStore("users", { keyPath: ["userId"] });

    // Make account data store, clobber based on event type.
    // (event.type property of MatrixEvent objects)
    db.createObjectStore("accountData", { keyPath: ["type"] });

    // Make /sync store (sync tokens, room data, etc), always clobber (const key).
    db.createObjectStore("sync", { keyPath: ["clobber"] });
}

/**
 * Helper method to collect results from a Cursor and promiseify it.
 * @param {ObjectStore|Index} store The store to perform openCursor on.
 * @param {IDBKeyRange=} keyRange Optional key range to apply on the cursor.
 * @param {Function} resultMapper A function which is repeatedly called with a
 * Cursor.
 * Return the data you want to keep.
 * @return {Promise<T[]>} Resolves to an array of whatever you returned from
 * resultMapper.
 */
function selectQuery(store, keyRange, resultMapper) {
    const query = store.openCursor(keyRange);
    return new Promise((resolve, reject) => {
        const results = [];
        query.onerror = (event) => {
            reject(new Error("Query failed: " + event.target.errorCode));
        };
        // collect results
        query.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                resolve(results);
                return; // end of results
            }
            results.push(resultMapper(cursor));
            cursor.continue();
        };
    });
}

function promiseifyTxn(txn) {
    return new Promise((resolve, reject) => {
        txn.oncomplete = function(event) {
            resolve(event);
        };
        txn.onerror = function(event) {
            reject(event);
        };
    });
}

function promiseifyRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = function(event) {
            resolve(event);
        };
        req.onerror = function(event) {
            reject(event);
        };
    });
}

/**
 * Does the actual reading from and writing to the indexeddb
 *
 * Construct a new Indexed Database store backend. This requires a call to
 * <code>connect()</code> before this store can be used.
 * @constructor
 * @param {Object} indexedDBInterface The Indexed DB interface e.g
 * <code>window.indexedDB</code>
 * @param {string=} dbName Optional database name. The same name must be used
 * to open the same database.
 */
const LocalIndexedDBStoreBackend = function LocalIndexedDBStoreBackend(
    indexedDBInterface, dbName,
) {
    this.indexedDB = indexedDBInterface;
    this._dbName = "matrix-js-sdk:" + (dbName || "default");
    this.db = null;
    this._syncAccumulator = new SyncAccumulator();
};


LocalIndexedDBStoreBackend.prototype = {
    /**
     * Attempt to connect to the database. This can fail if the user does not
     * grant permission.
     * @return {Promise} Resolves if successfully connected.
     */
    connect: function() {
        if (this.db) {
            console.log(
                `LocalIndexedDBStoreBackend.connect: already connected`,
            );
            return Promise.resolve();
        }

        console.log(
            `LocalIndexedDBStoreBackend.connect: connecting`,
        );
        const req = this.indexedDB.open(this._dbName, VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            const oldVersion = ev.oldVersion;
            console.log(
                `LocalIndexedDBStoreBackend.connect: upgrading from ${oldVersion}`,
            );
            if (oldVersion < 1) { // The database did not previously exist.
                createDatabase(db);
            }
            // Expand as needed.
        };

        req.onblocked = () => {
            console.log(
                `can't yet open LocalIndexedDBStoreBackend because it is open elsewhere`,
            );
        };

        console.log(
            `LocalIndexedDBStoreBackend.connect: awaiting connection`,
        );
        return promiseifyRequest(req).then((ev) => {
            console.log(
                `LocalIndexedDBStoreBackend.connect: connected`,
            );
            this.db = ev.target.result;

            // add a poorly-named listener for when deleteDatabase is called
            // so we can close our db connections.
            this.db.onversionchange = () => {
                this.db.close();
            };

            return this._init();
        });
    },

    /**
     * Having connected, load initial data from the database and prepare for use
     * @return {Promise} Resolves on success
     */
    _init: function() {
        return Promise.all([
            this._loadAccountData(),
            this._loadSyncData(),
        ]).then(([accountData, syncData]) => {
            console.log(
                `LocalIndexedDBStoreBackend: loaded initial data`,
            );
            this._syncAccumulator.accumulate({
                next_batch: syncData.nextBatch,
                rooms: syncData.roomsData,
                account_data: {
                    events: accountData,
                },
            });
        });
    },

    /**
     * Clear the entire database. This should be used when logging out of a client
     * to prevent mixing data between accounts.
     * @return {Promise} Resolved when the database is cleared.
     */
    clearDatabase: function() {
        return new Promise((resolve, reject) => {
            console.log(`Removing indexeddb instance: ${this._dbName}`);
            const req = this.indexedDB.deleteDatabase(this._dbName);

            req.onblocked = () => {
                console.log(
                    `can't yet delete indexeddb ${this._dbName}` +
                    ` because it is open elsewhere`,
                );
            };

            req.onerror = (ev) => {
                // in firefox, with indexedDB disabled, this fails with a
                // DOMError. We treat this as non-fatal, so that we can still
                // use the app.
                console.warn(
                    `unable to delete js-sdk store indexeddb: ${ev.target.error}`,
                );
                resolve();
            };

            req.onsuccess = () => {
                console.log(`Removed indexeddb instance: ${this._dbName}`);
                resolve();
            };
        });
    },

    /**
     * @param {boolean=} copy If false, the data returned is from internal
     * buffers and must not be muated. Otherwise, a copy is made before
     * returning such that the data can be safely mutated. Default: true.
     *
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync: function(copy) {
        if (copy === undefined) copy = true;

        const data = this._syncAccumulator.getJSON();
        if (!data.nextBatch) return Promise.resolve(null);
        if (copy) {
            // We must deep copy the stored data so that the /sync processing code doesn't
            // corrupt the internal state of the sync accumulator (it adds non-clonable keys)
            return Promise.resolve(utils.deepCopy(data));
        } else {
            return Promise.resolve(data);
        }
    },

    setSyncData: function(syncData) {
        return Promise.resolve().then(() => {
            this._syncAccumulator.accumulate(syncData);
        });
    },

    syncToDatabase: function(userTuples) {
        const syncData = this._syncAccumulator.getJSON();

        return Promise.all([
            this._persistUserPresenceEvents(userTuples),
            this._persistAccountData(syncData.accountData),
            this._persistSyncData(syncData.nextBatch, syncData.roomsData),
        ]);
    },

    /**
     * Persist rooms /sync data along with the next batch token.
     * @param {string} nextBatch The next_batch /sync value.
     * @param {Object} roomsData The 'rooms' /sync data from a SyncAccumulator
     * @return {Promise} Resolves if the data was persisted.
     */
    _persistSyncData: function(nextBatch, roomsData) {
        console.log("Persisting sync data up to ", nextBatch);
        return Promise.try(() => {
            const txn = this.db.transaction(["sync"], "readwrite");
            const store = txn.objectStore("sync");
            store.put({
                clobber: "-", // constant key so will always clobber
                nextBatch: nextBatch,
                roomsData: roomsData,
            }); // put == UPSERT
            return promiseifyTxn(txn);
        });
    },

    /**
     * Persist a list of account data events. Events with the same 'type' will
     * be replaced.
     * @param {Object[]} accountData An array of raw user-scoped account data events
     * @return {Promise} Resolves if the events were persisted.
     */
    _persistAccountData: function(accountData) {
        return Promise.try(() => {
            const txn = this.db.transaction(["accountData"], "readwrite");
            const store = txn.objectStore("accountData");
            for (let i = 0; i < accountData.length; i++) {
                store.put(accountData[i]); // put == UPSERT
            }
            return promiseifyTxn(txn);
        });
    },

    /**
     * Persist a list of [user id, presence event] they are for.
     * Users with the same 'userId' will be replaced.
     * Presence events should be the event in its raw form (not the Event
     * object)
     * @param {Object[]} tuples An array of [userid, event] tuples
     * @return {Promise} Resolves if the users were persisted.
     */
    _persistUserPresenceEvents: function(tuples) {
        return Promise.try(() => {
            const txn = this.db.transaction(["users"], "readwrite");
            const store = txn.objectStore("users");
            for (const tuple of tuples) {
                store.put({
                    userId: tuple[0],
                    event: tuple[1],
                }); // put == UPSERT
            }
            return promiseifyTxn(txn);
        });
    },

    /**
     * Load all user presence events from the database. This is not cached.
     * FIXME: It would probably be more sensible to store the events in the
     * sync.
     * @return {Promise<Object[]>} A list of presence events in their raw form.
     */
    getUserPresenceEvents: function() {
        return Promise.try(() => {
            const txn = this.db.transaction(["users"], "readonly");
            const store = txn.objectStore("users");
            return selectQuery(store, undefined, (cursor) => {
                return [cursor.value.userId, cursor.value.event];
            });
        });
    },

    /**
     * Load all the account data events from the database. This is not cached.
     * @return {Promise<Object[]>} A list of raw global account events.
     */
    _loadAccountData: function() {
        console.log(
            `LocalIndexedDBStoreBackend: loading account data`,
        );
        return Promise.try(() => {
            console.log(
                `LocalIndexedDBStoreBackend: loaded account data`,
            );
            const txn = this.db.transaction(["accountData"], "readonly");
            const store = txn.objectStore("accountData");
            return selectQuery(store, undefined, (cursor) => {
                return cursor.value;
            });
        });
    },

    /**
     * Load the sync data from the database.
     * @return {Promise<Object>} An object with "roomsData" and "nextBatch" keys.
     */
    _loadSyncData: function() {
        console.log(
            `LocalIndexedDBStoreBackend: loaded sync data`,
        );
        return Promise.try(() => {
            console.log(
                `LocalIndexedDBStoreBackend: loaded sync data`,
            );
            const txn = this.db.transaction(["sync"], "readonly");
            const store = txn.objectStore("sync");
            return selectQuery(store, undefined, (cursor) => {
                return cursor.value;
            }).then((results) => {
                if (results.length > 1) {
                    console.warn("loadSyncData: More than 1 sync row found.");
                }
                return (results.length > 0 ? results[0] : {});
            });
        });
    },
};

export default LocalIndexedDBStoreBackend;
