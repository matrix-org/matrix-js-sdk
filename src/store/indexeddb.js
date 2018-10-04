/*
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd

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
        console.log(`IndexedDBStore.startup: already started`);
        return Promise.resolve();
    }

    console.log(`IndexedDBStore.startup: connecting to backend`);
    return this.backend.connect().then(() => {
        console.log(`IndexedDBStore.startup: loading presence events`);
        return this.backend.getUserPresenceEvents();
    }).then((userPresenceEvents) => {
        console.log(`IndexedDBStore.startup: processing presence events`);
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

/** @return {Promise<bool>} whether or not the database was newly created in this session. */
IndexedDBStore.prototype.isNewlyCreated = function() {
    return this.backend.isNewlyCreated();
};

/**
 * @return {Promise} If there is a saved sync, the nextBatch token
 * for this sync, otherwise null.
 */
IndexedDBStore.prototype.getSavedSyncToken = function() {
    return this.backend.getNextBatchToken();
},

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
 * Whether this store would like to save its data
 * Note that obviously whether the store wants to save or
 * not could change between calling this function and calling
 * save().
 *
 * @return {boolean} True if calling save() will actually save
 *     (at the time this function is called).
 */
IndexedDBStore.prototype.wantsSave = function() {
    const now = Date.now();
    return now - this._syncTs > WRITE_DELAY_MS;
};

/**
 * Possibly write data to the database.
 * @return {Promise} Promise resolves after the write completes
 *     (or immediately if no write is performed)
 */
IndexedDBStore.prototype.save = function() {
    if (this.wantsSave()) {
        return this._reallySave();
    }
    return Promise.resolve();
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

/**
 * Returns the out-of-band membership events for this room that
 * were previously loaded.
 * @param {string} roomId
 * @returns {event[]} the events, potentially an empty array if OOB loading didn't yield any new members
 * @returns {null} in case the members for this room haven't been stored yet
 */
IndexedDBStore.prototype.getOutOfBandMembers = function(roomId) {
    return this.backend.getOutOfBandMembers(roomId);
};

/**
 * Stores the out-of-band membership events for this room. Note that
 * it still makes sense to store an empty array as the OOB status for the room is
 * marked as fetched, and getOutOfBandMembers will return an empty array instead of null
 * @param {string} roomId
 * @param {event[]} membershipEvents the membership events to store
 * @returns {Promise} when all members have been stored
 */
IndexedDBStore.prototype.setOutOfBandMembers = function(roomId, membershipEvents) {
    return this.backend.setOutOfBandMembers(roomId, membershipEvents);
};

IndexedDBStore.prototype.clearOutOfBandMembers = function(roomId) {
    return this.backend.clearOutOfBandMembers(roomId);
};

IndexedDBStore.prototype.getClientOptions = function() {
    return this.backend.getClientOptions();
};

IndexedDBStore.prototype.storeClientOptions = function(options) {
    return this.backend.storeClientOptions(options);
};

module.exports.IndexedDBStore = IndexedDBStore;
