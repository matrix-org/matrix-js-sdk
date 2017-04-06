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

import q from "q";
import {MatrixInMemoryStore} from "./memory";
import utils from "../utils";
import LocalIndexedDBStoreBackend from "./indexeddb-local-backend.js";

/**
 * This is an internal module. See {@link IndexedDBStore} for the public class.
 * @module store/indexeddb
 */

// If this value is too small we'll be writing very often which will cause
// noticable stop-the-world pauses. If this value is too big we'll be writing
// so infrequently that the /sync size gets bigger on reload. Writing more
// often does not affect the length of the pause since the entire /sync
// response is persisted each time.
const WRITE_DELAY_MS = 1000 * 60 * 5; // once every 5 minutes


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
 * let store = new IndexedDBStore();
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

    this.backend = new LocalIndexedDBStoreBackend(opts.indexedDB, opts.dbName);
    this.startedUp = false;
    this._syncTs = Date.now(); // updated when writes to the database are performed
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
    return this.backend.getSavedSync();
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
        this._syncTs = Date.now(); // set now to guard against multi-writes
        return this.backend.syncToDatabase(this.getUsers()).catch((err) => {
            console.error("sync fail:", err);
        });
    }
    return q();
};

IndexedDBStore.prototype.setSyncData = function(syncData) {
    this.backend.setSyncData(syncData);
};

module.exports.IndexedDBStore = IndexedDBStore;
