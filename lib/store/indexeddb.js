"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.IndexedDBStore = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _events = require("events");

var _memory = require("./memory");

var _indexeddbLocalBackend = require("./indexeddb-local-backend");

var _indexeddbRemoteBackend = require("./indexeddb-remote-backend");

var _user = require("../models/user");

var _event = require("../models/event");

var _logger = require("../logger");

/*
Copyright 2017 - 2021 Vector Creations Ltd

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

/* eslint-disable @babel/no-invalid-this */

/**
 * This is an internal module. See {@link IndexedDBStore} for the public class.
 * @module store/indexeddb
 */
// If this value is too small we'll be writing very often which will cause
// noticeable stop-the-world pauses. If this value is too big we'll be writing
// so infrequently that the /sync size gets bigger on reload. Writing more
// often does not affect the length of the pause since the entire /sync
// response is persisted each time.
const WRITE_DELAY_MS = 1000 * 60 * 5; // once every 5 minutes

class IndexedDBStore extends _memory.MemoryStore {
  static exists(indexedDB, dbName) {
    return _indexeddbLocalBackend.LocalIndexedDBStoreBackend.exists(indexedDB, dbName);
  }

  /**
   * Construct a new Indexed Database store, which extends MemoryStore.
   *
   * This store functions like a MemoryStore except it periodically persists
   * the contents of the store to an IndexedDB backend.
   *
   * All data is still kept in-memory but can be loaded from disk by calling
   * <code>startup()</code>. This can make startup times quicker as a complete
   * sync from the server is not required. This does not reduce memory usage as all
   * the data is eagerly fetched when <code>startup()</code> is called.
   * <pre>
   * let opts = { indexedDB: window.indexedDB, localStorage: window.localStorage };
   * let store = new IndexedDBStore(opts);
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
   * @extends MemoryStore
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
  constructor(opts) {
    super(opts);
    (0, _defineProperty2.default)(this, "backend", void 0);
    (0, _defineProperty2.default)(this, "startedUp", false);
    (0, _defineProperty2.default)(this, "syncTs", 0);
    (0, _defineProperty2.default)(this, "userModifiedMap", {});
    (0, _defineProperty2.default)(this, "emitter", new _events.EventEmitter());
    (0, _defineProperty2.default)(this, "on", this.emitter.on.bind(this.emitter));
    (0, _defineProperty2.default)(this, "getSavedSync", this.degradable(() => {
      return this.backend.getSavedSync();
    }, "getSavedSync"));
    (0, _defineProperty2.default)(this, "isNewlyCreated", this.degradable(() => {
      return this.backend.isNewlyCreated();
    }, "isNewlyCreated"));
    (0, _defineProperty2.default)(this, "getSavedSyncToken", this.degradable(() => {
      return this.backend.getNextBatchToken();
    }, "getSavedSyncToken"));
    (0, _defineProperty2.default)(this, "deleteAllData", this.degradable(() => {
      super.deleteAllData();
      return this.backend.clearDatabase().then(() => {
        _logger.logger.log("Deleted indexeddb data.");
      }, err => {
        _logger.logger.error(`Failed to delete indexeddb data: ${err}`);

        throw err;
      });
    }));
    (0, _defineProperty2.default)(this, "reallySave", this.degradable(() => {
      this.syncTs = Date.now(); // set now to guard against multi-writes
      // work out changed users (this doesn't handle deletions but you
      // can't 'delete' users as they are just presence events).

      const userTuples = [];

      for (const u of this.getUsers()) {
        if (this.userModifiedMap[u.userId] === u.getLastModifiedTime()) continue;
        if (!u.events.presence) continue;
        userTuples.push([u.userId, u.events.presence.event]); // note that we've saved this version of the user

        this.userModifiedMap[u.userId] = u.getLastModifiedTime();
      }

      return this.backend.syncToDatabase(userTuples);
    }));
    (0, _defineProperty2.default)(this, "setSyncData", this.degradable(syncData => {
      return this.backend.setSyncData(syncData);
    }, "setSyncData"));
    (0, _defineProperty2.default)(this, "getOutOfBandMembers", this.degradable(roomId => {
      return this.backend.getOutOfBandMembers(roomId);
    }, "getOutOfBandMembers"));
    (0, _defineProperty2.default)(this, "setOutOfBandMembers", this.degradable((roomId, membershipEvents) => {
      super.setOutOfBandMembers(roomId, membershipEvents);
      return this.backend.setOutOfBandMembers(roomId, membershipEvents);
    }, "setOutOfBandMembers"));
    (0, _defineProperty2.default)(this, "clearOutOfBandMembers", this.degradable(roomId => {
      super.clearOutOfBandMembers(roomId);
      return this.backend.clearOutOfBandMembers(roomId);
    }, "clearOutOfBandMembers"));
    (0, _defineProperty2.default)(this, "getClientOptions", this.degradable(() => {
      return this.backend.getClientOptions();
    }, "getClientOptions"));
    (0, _defineProperty2.default)(this, "storeClientOptions", this.degradable(options => {
      super.storeClientOptions(options);
      return this.backend.storeClientOptions(options);
    }, "storeClientOptions"));

    if (!opts.indexedDB) {
      throw new Error('Missing required option: indexedDB');
    }

    if (opts.workerFactory) {
      this.backend = new _indexeddbRemoteBackend.RemoteIndexedDBStoreBackend(opts.workerFactory, opts.dbName);
    } else {
      this.backend = new _indexeddbLocalBackend.LocalIndexedDBStoreBackend(opts.indexedDB, opts.dbName);
    }
  }

  /**
   * @return {Promise} Resolved when loaded from indexed db.
   */
  startup() {
    if (this.startedUp) {
      _logger.logger.log(`IndexedDBStore.startup: already started`);

      return Promise.resolve();
    }

    _logger.logger.log(`IndexedDBStore.startup: connecting to backend`);

    return this.backend.connect().then(() => {
      _logger.logger.log(`IndexedDBStore.startup: loading presence events`);

      return this.backend.getUserPresenceEvents();
    }).then(userPresenceEvents => {
      _logger.logger.log(`IndexedDBStore.startup: processing presence events`);

      userPresenceEvents.forEach(([userId, rawEvent]) => {
        const u = new _user.User(userId);

        if (rawEvent) {
          u.setPresenceEvent(new _event.MatrixEvent(rawEvent));
        }

        this.userModifiedMap[u.userId] = u.getLastModifiedTime();
        this.storeUser(u);
      });
    });
  }
  /**
   * @return {Promise} Resolves with a sync response to restore the
   * client state to where it was at the last save, or null if there
   * is no saved sync data.
   */


  /**
   * Whether this store would like to save its data
   * Note that obviously whether the store wants to save or
   * not could change between calling this function and calling
   * save().
   *
   * @return {boolean} True if calling save() will actually save
   *     (at the time this function is called).
   */
  wantsSave() {
    const now = Date.now();
    return now - this.syncTs > WRITE_DELAY_MS;
  }
  /**
   * Possibly write data to the database.
   *
   * @param {boolean} force True to force a save to happen
   * @return {Promise} Promise resolves after the write completes
   *     (or immediately if no write is performed)
   */


  save(force = false) {
    if (force || this.wantsSave()) {
      return this.reallySave();
    }

    return Promise.resolve();
  }

  /**
   * All member functions of `IndexedDBStore` that access the backend use this wrapper to
   * watch for failures after initial store startup, including `QuotaExceededError` as
   * free disk space changes, etc.
   *
   * When IndexedDB fails via any of these paths, we degrade this back to a `MemoryStore`
   * in place so that the current operation and all future ones are in-memory only.
   *
   * @param {Function} func The degradable work to do.
   * @param {String} fallback The method name for fallback.
   * @returns {Function} A wrapped member function.
   */
  degradable(func, fallback) {
    const fallbackFn = super[fallback];
    return async (...args) => {
      try {
        return func.call(this, ...args);
      } catch (e) {
        _logger.logger.error("IndexedDBStore failure, degrading to MemoryStore", e);

        this.emitter.emit("degraded", e);

        try {
          // We try to delete IndexedDB after degrading since this store is only a
          // cache (the app will still function correctly without the data).
          // It's possible that deleting repair IndexedDB for the next app load,
          // potentially by making a little more space available.
          _logger.logger.log("IndexedDBStore trying to delete degraded data");

          await this.backend.clearDatabase();

          _logger.logger.log("IndexedDBStore delete after degrading succeeded");
        } catch (e) {
          _logger.logger.warn("IndexedDBStore delete after degrading failed", e);
        } // Degrade the store from being an instance of `IndexedDBStore` to instead be
        // an instance of `MemoryStore` so that future API calls use the memory path
        // directly and skip IndexedDB entirely. This should be safe as
        // `IndexedDBStore` already extends from `MemoryStore`, so we are making the
        // store become its parent type in a way. The mutator methods of
        // `IndexedDBStore` also maintain the state that `MemoryStore` uses (many are
        // not overridden at all).


        if (fallbackFn) {
          return fallbackFn(...args);
        }
      }
    };
  }

}

exports.IndexedDBStore = IndexedDBStore;