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
"use strict";

import q from "q";
import {MatrixInMemoryStore} from "./memory";
import User from "../models/user";
import {MatrixEvent} from "../models/event";
import utils from "../utils";
import SyncAccumulator from "../sync-accumulator";

/**
 * This is an internal module. See {@link IndexedDBStore} for the public class.
 * @module store/indexeddb
 */

const VERSION = 1;

// If this value is too small we'll be writing very often which will cause
// noticable stop-the-world pauses. If this value is too big we'll be writing
// so infrequently that the /sync size gets bigger on reload. Writing more
// often does not affect the length of the pause since the entire /sync
// response is persisted each time.
const WRITE_DELAY_MS = 1000 * 60 * 5; // once every 5 minutes

/**
 * Construct a new Indexed Database store backend. This requires a call to
 * <code>connect()</code> before this store can be used.
 * @constructor
 * @param {Object} indexedDBInterface The Indexed DB interface e.g
 * <code>window.indexedDB</code>
 * @param {string=} dbName Optional database name. The same name must be used
 * to open the same database.
 */
const IndexedDBStoreBackend = function IndexedDBStoreBackend(indexedDBInterface,
                                                             dbName) {
    this.indexedDB = indexedDBInterface;
    this._dbName = "matrix-js-sdk:" + (dbName || "default");
    this.db = null;
};


IndexedDBStoreBackend.prototype = {
    /**
     * Attempt to connect to the database. This can fail if the user does not
     * grant permission.
     * @return {Promise} Resolves if successfully connected.
     */
    connect: function() {
        if (this.db) {
            return q();
        }
        const req = this.indexedDB.open(this._dbName, VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            const oldVersion = ev.oldVersion;
            if (oldVersion < 1) { // The database did not previously exist.
                createDatabase(db);
            }
            // Expand as needed.
        };

        return promiseifyRequest(req).then((ev) => {
            this.db = ev.target.result;

            // add a poorly-named listener for when deleteDatabase is called
            // so we can close our db connections.
            this.db.onversionchange = () => {
                this.db.close();
            };
        });
    },

    /**
     * Clear the entire database. This should be used when logging out of a client
     * to prevent mixing data between accounts.
     * @return {Promise} Resolved when the database is cleared.
     */
    clearDatabase: function() {
        console.log("Removing indexeddb instance: ", this._dbName);
        return promiseifyRequest(this.indexedDB.deleteDatabase(this._dbName));
    },

    /**
     * Persist rooms /sync data along with the next batch token.
     * @param {string} nextBatch The next_batch /sync value.
     * @param {Object} roomsData The 'rooms' /sync data from a SyncAccumulator
     * @return {Promise} Resolves if the data was persisted.
     */
    persistSyncData: function(nextBatch, roomsData) {
        console.log("Persisting sync data up to ", nextBatch);
        return q.try(() => {
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
    persistAccountData: function(accountData) {
        return q.try(() => {
            const txn = this.db.transaction(["accountData"], "readwrite");
            const store = txn.objectStore("accountData");
            for (let i = 0; i < accountData.length; i++) {
                store.put(accountData[i]); // put == UPSERT
            }
            return promiseifyTxn(txn);
        });
    },

    /**
     * Persist a list of User objects. Users with the same 'userId' will be
     * replaced.
     * @param {User[]} users An array of users
     * @return {Promise} Resolves if the users were persisted.
     */
    persistUsers: function(users) {
        return q.try(() => {
            const txn = this.db.transaction(["users"], "readwrite");
            const store = txn.objectStore("users");
            for (let i = 0; i < users.length; i++) {
                store.put({
                    userId: users[i].userId,
                    event: (users[i].events.presence ?
                                users[i].events.presence.event :
                                null),
                }); // put == UPSERT
            }
            return promiseifyTxn(txn);
        });
    },

    /**
     * Load all the users from the database. This is not cached.
     * @return {Promise<User[]>} A list of users.
     */
    loadUsers: function() {
        return q.try(() => {
            const txn = this.db.transaction(["users"], "readonly");
            const store = txn.objectStore("users");
            return selectQuery(store, undefined, (cursor) => {
                const user = new User(cursor.value.userId);
                if (cursor.value.event) {
                    user.setPresenceEvent(new MatrixEvent(cursor.value.event));
                }
                return user;
            });
        });
    },

    /**
     * Load all the account data events from the database. This is not cached.
     * @return {Promise<Object[]>} A list of raw global account events.
     */
    loadAccountData: function() {
        return q.try(() => {
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
    loadSyncData: function() {
        return q.try(() => {
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

/**
 * Construct a new Indexed Database store, which extends MatrixInMemoryStore.
 *
 * This store functions like a MatrixInMemoryStore except it periodically persists
 * the contents of the store to an IndexedDB backend.
 *
 * All data is still kept in-memory but can be loaded from disk by calling
 * <code>startup()</code>. This can make startup times quicker as a complete
 * sync from the server is not required. This does not reduce memory usage as all
 * the data is eagerly fetched when <code>startup()</code> is called.
 * <pre>
 * let opts = { localStorage: window.localStorage };
 * let store = new IndexedDBStore(
 *     new IndexedDBStoreBackend(window.indexedDB), syncAccumulator, opts
 * );
 * await store.startup(); // load from indexed db
 * let client = sdk.createClient({
 *     store: store,
 * });
 * client.startClient();
 * client.on("sync", function(state, prevState, data) {
 *     if (state === "PREPARED") {
 *         console.log("Started up, now with go faster stripes!");
 *     }
 * });
 * </pre>
 *
 * @constructor
 * @extends MatrixInMemoryStore
 * @param {Object} opts Options object.
 * @param {Object} opts.indexedDB The Indexed DB interface e.g.
 * <code>window.indexedDB</code>
 * @param {string=} opts.dbName Optional database name. The same name must be used
 * to open the same database.
 * @prop {IndexedDBStoreBackend} backend The backend instance. Call through to
 * this API if you need to perform specific indexeddb actions like deleting the
 * database.
 */
const IndexedDBStore = function IndexedDBStore(opts) {
    MatrixInMemoryStore.call(this, opts);

    if (!opts.indexedDB) {
        throw new Error('Missing required option: indexedDB');
    }

    this.backend = new IndexedDBStoreBackend(opts.indexedDB, opts.dbName);
    this.startedUp = false;
    this._syncTs = Date.now(); // updated when writes to the database are performed

    // internal structs to determine deltas for syncs to the database.
    this._userModifiedMap = {
        // user_id : timestamp
    };
    this._syncAccumulator = new SyncAccumulator();
};
utils.inherits(IndexedDBStore, MatrixInMemoryStore);

/**
 * @return {Promise} Resolved when loaded from indexed db.
  */
IndexedDBStore.prototype.startup = function() {
    if (this.startedUp) {
        return q();
    }
    return this.backend.connect().then(() => {
        return q.all([
            this.backend.loadUsers(),
            this.backend.loadAccountData(),
            this.backend.loadSyncData(),
        ]);
    }).then((values) => {
        const [users, accountData, syncData] = values;
        console.log(
            "Loaded data from database: sync from ", syncData.nextBatch,
            " -- Reticulating splines...",
        );
        users.forEach((u) => {
            this._userModifiedMap[u.userId] = u.getLastModifiedTime();
            this.storeUser(u);
        });
        this._syncTs = Date.now(); // pretend we've written so we don't rewrite
        this.setSyncToken(syncData.nextBatch);
        this.setSyncData({
            next_batch: syncData.nextBatch,
            rooms: syncData.roomsData,
            account_data: {
                events: accountData,
            },
        });
    });
};

/**
 * @return {Promise} Resolves with a sync response to restore the
 * client state to where it was at the last save, or null if there
 * is no saved sync data.
 */
IndexedDBStore.prototype.getSavedSync = function() {
    const data = this._syncAccumulator.getJSON();
    if (!data.nextBatch) return q(null);
    // We must deep copy the stored data so that the /sync processing code doesn't
    // corrupt the internal state of the sync accumulator (it adds non-clonable keys)
    return q(utils.deepCopy(data));
};

/**
 * Delete all data from this store.
 * @return {Promise} Resolves if the data was deleted from the database.
 */
IndexedDBStore.prototype.deleteAllData = function() {
    MatrixInMemoryStore.prototype.deleteAllData.call(this);
    return this.backend.clearDatabase().then(() => {
        console.log("Deleted indexeddb data.");
    }, (err) => {
        console.error("Failed to delete indexeddb data: ", err);
        throw err;
    });
};

/**
 * Possibly write data to the database.
 * @return {Promise} Promise resolves after the write completes.
 */
IndexedDBStore.prototype.save = function() {
    const now = Date.now();
    if (now - this._syncTs > WRITE_DELAY_MS) {
        return this._syncToDatabase().catch((err) => {console.error("sync fail:", err);});
    }
    return q();
};

IndexedDBStore.prototype.setSyncData = function(syncData) {
    this._syncAccumulator.accumulate(syncData);
};

IndexedDBStore.prototype._syncToDatabase = function() {
    this._syncTs = Date.now(); // set now to guard against multi-writes

    // work out changed users (this doesn't handle deletions but you
    // can't 'delete' users as they are just presence events).
    const changedUsers = this.getUsers().filter((user) => {
        return this._userModifiedMap[user.userId] !== user.getLastModifiedTime();
    });
    changedUsers.forEach((u) => { // update times
        this._userModifiedMap[u.userId] = u.getLastModifiedTime();
    });

    const syncData = this._syncAccumulator.getJSON();

    return q.all([
        this.backend.persistUsers(changedUsers),
        this.backend.persistAccountData(syncData.accountData),
        this.backend.persistSyncData(syncData.nextBatch, syncData.roomsData),
    ]);
};

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
    return q.Promise((resolve, reject) => { /*eslint new-cap: 0*/
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
    return new q.Promise((resolve, reject) => {
        txn.oncomplete = function(event) {
            resolve(event);
        };
        txn.onerror = function(event) {
            reject(event);
        };
    });
}

function promiseifyRequest(req) {
    return new q.Promise((resolve, reject) => {
        req.onsuccess = function(event) {
            resolve(event);
        };
        req.onerror = function(event) {
            reject(event);
        };
    });
}

module.exports.IndexedDBStore = IndexedDBStore;
module.exports.IndexedDBStoreBackend = IndexedDBStoreBackend;
