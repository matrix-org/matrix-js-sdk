/*
Copyright 2017 OpenMarket Ltd

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
import Room from "../models/room";
import {MatrixEvent} from "../models/event";
import utils from "../utils";

/**
 * This is an internal module. See {@link IndexedDBStore} for the public class.
 * @module store/indexeddb
 */

const VERSION = 1;

/**
 * Construct a new Indexed Database store backend. This requires a call to
 * <code>connect()</code> before this store can be used.
 * @constructor
 * @param {Object} indexedDBInterface The Indexed DB interface e.g
 * <code>window.indexedDB</code>
 */
const IndexedDBStoreBackend = function IndexedDBStoreBackend(indexedDBInterface) {
    this.indexedDB = indexedDBInterface;
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
        const req = this.indexedDB.open("matrix-js-sdk", VERSION);
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
        });
    },

    /**
     * Clear the entire database. This should be used when logging out of a client
     * to prevent mixing data between accounts.
     * @return {Promise} Resolved when the database is cleared.
     */
    clearDatabase: function() {
        return promiseifyRequest(this.indexedDB.deleteDatabase("matrix-js-sdk"));
    },

    /**
     * Persist a list of Room objects. Rooms with the same 'roomId' will be replaced.
     * @param {Room[]} rooms An array of rooms
     * @return {Promise} Resolves if the rooms were persisted.
     */
    persistRooms: function(rooms) {
        return this._upsert("rooms", rooms);
    },

    /**
     * Persist a sync token. This will replace any existing sync token.
     * @param {string} syncToken The token to persist.
     * @return {Promise} Resolves if the token was persisted.
     */
    persistSyncToken: function(syncToken) {
        const obj = {
            clobber: "-", // constant key so will always clobber
            syncToken: syncToken,
        };
        return this._upsert("config", [obj]);
    },

    /**
     * Persist a list of account data events. Events with the same 'type' will
     * be replaced.
     * @param {MatrixEvent[]} accountData An array of user-scoped account data events
     * @return {Promise} Resolves if the events were persisted.
     */
    persistAccountData: function(accountData) {
        return this._upsert("accountData", accountData);
    },

    /**
     * Persist a list of User objects. Users with the same 'userId' will be
     * replaced.
     * @param {User[]} users An array of users
     * @return {Promise} Resolves if the users were persisted.
     */
    persistUsers: function(users) {
        return this._upsert("users", users);
    },

    /**
     * Load all the users from the database. This is not cached.
     * @return {Promise<User[]>} A list of users.
     */
    loadUsers: function() {
        return this._deserializeAll("users", User);
    },

    /**
     * Load all the rooms from the database. This is not cached.
     * @return {Promise<Room[]>} A list of rooms.
     */
    loadRooms: function() {
        return this._deserializeAll("rooms", Room);
    },

    /**
     * Load all the account data events from the database. This is not cached.
     * @return {Promise<MatrixEvent[]>} A list of events.
     */
    loadAccountData: function() {
        return this._deserializeAll("accountData", MatrixEvent);
    },

    /**
     * Load the sync token from the database.
     * @return {Promise<?string>} The sync token
     */
    loadSyncToken: function() {
        return q.try(() => {
            const txn = this.db.transaction(["config"], "readonly");
            const store = txn.objectStore("config");
            const results = selectQuery(store, undefined, (cursor) => {
                return cursor.value;
            });
            if (results.length > 1) {
                console.warn("loadSyncToken: More than 1 config row found.");
            }
            return (results.length > 0 ? results[0].syncToken : null);
        });
    },

    _upsert: function(storeName, rows) {
        return q.try(() => {
            const txn = this.db.transaction([storeName], "readwrite");
            const store = txn.objectStore(storeName);
            for (let i = 0; i < rows.length; i++) {
                if (typeof rows[i].serialize === "function") {
                    store.put(rows[i].serialize()); // put == UPSERT
                } else {
                    store.put(rows[i]); // put == UPSERT
                }
            }
            return promiseifyTxn(txn);
        });
    },

    _deserializeAll: function(storeName, Cls) {
        return q.try(() => {
            const txn = this.db.transaction([storeName], "readonly");
            const store = txn.objectStore(storeName);
            return selectQuery(store, undefined, (cursor) => {
                return Cls.deserialize(cursor.value);
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
 * let store = new IndexedDBStore(new IndexedDBStoreBackend(window.indexedDB), opts);
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
 * @param {IndexedDBStoreBackend} backend The indexed db backend instance.
 * @param {Object=} opts Options for MatrixInMemoryStore.
 * @prop {IndexedDBStoreBackend} backend The backend instance. Call through to
 * this API if you need to perform specific indexeddb actions like deleting the
 * database.
 */
const IndexedDBStore = function IndexedDBStore(backend, opts) {
    MatrixInMemoryStore.call(this, opts);
    this.backend = backend;
    this.startedUp = false;
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
        return this.backend.loadUsers();
    }).then((users) => {
        users.forEach((u) => {
            this.storeUser(u);
        });
    });
};

function createDatabase(db) {
    // Make room store, clobber based on room ID. (roomId property of Room objects)
    db.createObjectStore("rooms", { keyPath: ["roomId"] });

    // Make user store, clobber based on user ID. (userId property of User objects)
    db.createObjectStore("users", { keyPath: ["userId"] });

    // Make account data store, clobber based on event type.
    // (event.type property of MatrixEvent objects)
    db.createObjectStore("accountData", { keyPath: ["event.type"] });

    // Make configuration store (sync tokens, etc), always clobber (const key).
    db.createObjectStore("config", { keyPath: ["clobber"] });
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
