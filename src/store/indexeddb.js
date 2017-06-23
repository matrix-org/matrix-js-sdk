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
import RemoteIndexedDBStoreBackend from "./indexeddb-remote-backend.js";
import User from "../models/user";
import {MatrixEvent} from "../models/event";

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
 * @param {string=} opts.workerScript Optional URL to a script to invoke a web
 * worker with to run IndexedDB queries on the web worker. The IndexedDbStoreWorker
 * class is provided for this purpose and requires the application to provide a
 * trivial wrapper script around it.
 * @param {Object=} opts.workerApi The webWorker API object. If omitted, the global Worker
 * object will be used if it exists.
 * @prop {IndexedDBStoreBackend} backend The backend instance. Call through to
 * this API if you need to perform specific indexeddb actions like deleting the
 * database.
 */
const IndexedDBStore = function IndexedDBStore(opts) {
    MatrixInMemoryStore.call(this, opts);

    if (!opts.indexedDB) {
        throw new Error('Missing required option: indexedDB');
    }

    if (opts.workerScript) {
        // try & find a webworker-compatible API
        let workerApi = opts.workerApi;
        if (!workerApi) {
            // default to the global Worker object (which is where it in a browser)
            workerApi = global.Worker;
        }
        this.backend = new RemoteIndexedDBStoreBackend(
            opts.workerScript, opts.dbName, workerApi,
        );
    } else {
        this.backend = new LocalIndexedDBStoreBackend(opts.indexedDB, opts.dbName);
    }

    this.startedUp = false;
    this._syncTs = 0;

    // Records the last-modified-time of each user at the last point we saved
    // the database, such that we can derive the set if users that have been
    // modified since we last saved.
    this._userModifiedMap = {
        // user_id : timestamp
    };
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
        return this.backend.getUserPresenceEvents();
    }).then((userPresenceEvents) => {
        userPresenceEvents.forEach(([userId, rawEvent]) => {
            const u = new User(userId);
            if (rawEvent) {
                u.setPresenceEvent(new MatrixEvent(rawEvent));
            }
            this._userModifiedMap[u.userId] = u.getLastModifiedTime();
            this.storeUser(u);
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
        console.error(`Failed to delete indexeddb data: ${err}`);
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
        return this._reallySave();
    }
    return q();
};

IndexedDBStore.prototype._reallySave = function() {
    this._syncTs = Date.now(); // set now to guard against multi-writes

    // work out changed users (this doesn't handle deletions but you
    // can't 'delete' users as they are just presence events).
    const userTuples = [];
    for (const u of this.getUsers()) {
        if (this._userModifiedMap[u.userId] === u.getLastModifiedTime()) continue;
        if (!u.events.presence) continue;

        userTuples.push([u.userId, u.events.presence.event]);

        // note that we've saved this version of the user
        this._userModifiedMap[u.userId] = u.getLastModifiedTime();
    }

    return this.backend.syncToDatabase(userTuples).catch((err) => {
        console.error("sync fail:", err);
    });
};

IndexedDBStore.prototype.setSyncData = function(syncData) {
    return this.backend.setSyncData(syncData);
};

module.exports.IndexedDBStore = IndexedDBStore;
