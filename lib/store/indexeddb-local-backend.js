"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.LocalIndexedDBStoreBackend = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _syncAccumulator = require("../sync-accumulator");

var utils = _interopRequireWildcard(require("../utils"));

var IndexedDBHelpers = _interopRequireWildcard(require("../indexeddb-helpers"));

var _logger = require("../logger");

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

/*
Copyright 2017 - 2021 The Matrix.org Foundation C.I.C.

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
const VERSION = 3;

function createDatabase(db) {
  // Make user store, clobber based on user ID. (userId property of User objects)
  db.createObjectStore("users", {
    keyPath: ["userId"]
  }); // Make account data store, clobber based on event type.
  // (event.type property of MatrixEvent objects)

  db.createObjectStore("accountData", {
    keyPath: ["type"]
  }); // Make /sync store (sync tokens, room data, etc), always clobber (const key).

  db.createObjectStore("sync", {
    keyPath: ["clobber"]
  });
}

function upgradeSchemaV2(db) {
  const oobMembersStore = db.createObjectStore("oob_membership_events", {
    keyPath: ["room_id", "state_key"]
  });
  oobMembersStore.createIndex("room", "room_id");
}

function upgradeSchemaV3(db) {
  db.createObjectStore("client_options", {
    keyPath: ["clobber"]
  });
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

    query.onerror = () => {
      reject(new Error("Query failed: " + query.error));
    }; // collect results


    query.onsuccess = () => {
      const cursor = query.result;

      if (!cursor) {
        resolve(results);
        return; // end of results
      }

      results.push(resultMapper(cursor));
      cursor.continue();
    };
  });
}

function txnAsPromise(txn) {
  return new Promise((resolve, reject) => {
    txn.oncomplete = function (event) {
      resolve(event);
    };

    txn.onerror = function () {
      reject(txn.error);
    };
  });
}

function reqAsEventPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = function (event) {
      resolve(event);
    };

    req.onerror = function () {
      reject(req.error);
    };
  });
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req);

    req.onerror = err => reject(err);
  });
}

function reqAsCursorPromise(req) {
  return reqAsEventPromise(req).then(event => req.result);
}

class LocalIndexedDBStoreBackend {
  static exists(indexedDB, dbName) {
    dbName = "matrix-js-sdk:" + (dbName || "default");
    return IndexedDBHelpers.exists(indexedDB, dbName);
  }

  /**
   * Does the actual reading from and writing to the indexeddb
   *
   * Construct a new Indexed Database store backend. This requires a call to
   * <code>connect()</code> before this store can be used.
   * @constructor
   * @param {Object} indexedDB The Indexed DB interface e.g
   * <code>window.indexedDB</code>
   * @param {string=} dbName Optional database name. The same name must be used
   * to open the same database.
   */
  constructor(indexedDB, dbName) {
    this.indexedDB = indexedDB;
    (0, _defineProperty2.default)(this, "dbName", void 0);
    (0, _defineProperty2.default)(this, "syncAccumulator", void 0);
    (0, _defineProperty2.default)(this, "db", null);
    (0, _defineProperty2.default)(this, "disconnected", true);
    (0, _defineProperty2.default)(this, "_isNewlyCreated", false);
    this.dbName = "matrix-js-sdk:" + (dbName || "default");
    this.syncAccumulator = new _syncAccumulator.SyncAccumulator();
  }
  /**
   * Attempt to connect to the database. This can fail if the user does not
   * grant permission.
   * @return {Promise} Resolves if successfully connected.
   */


  connect() {
    if (!this.disconnected) {
      _logger.logger.log(`LocalIndexedDBStoreBackend.connect: already connected or connecting`);

      return Promise.resolve();
    }

    this.disconnected = false;

    _logger.logger.log(`LocalIndexedDBStoreBackend.connect: connecting...`);

    const req = this.indexedDB.open(this.dbName, VERSION);

    req.onupgradeneeded = ev => {
      const db = req.result;
      const oldVersion = ev.oldVersion;

      _logger.logger.log(`LocalIndexedDBStoreBackend.connect: upgrading from ${oldVersion}`);

      if (oldVersion < 1) {
        // The database did not previously exist.
        this._isNewlyCreated = true;
        createDatabase(db);
      }

      if (oldVersion < 2) {
        upgradeSchemaV2(db);
      }

      if (oldVersion < 3) {
        upgradeSchemaV3(db);
      } // Expand as needed.

    };

    req.onblocked = () => {
      _logger.logger.log(`can't yet open LocalIndexedDBStoreBackend because it is open elsewhere`);
    };

    _logger.logger.log(`LocalIndexedDBStoreBackend.connect: awaiting connection...`);

    return reqAsEventPromise(req).then(() => {
      _logger.logger.log(`LocalIndexedDBStoreBackend.connect: connected`);

      this.db = req.result; // add a poorly-named listener for when deleteDatabase is called
      // so we can close our db connections.

      this.db.onversionchange = () => {
        this.db.close();
      };

      return this.init();
    });
  }
  /** @return {boolean} whether or not the database was newly created in this session. */


  isNewlyCreated() {
    return Promise.resolve(this._isNewlyCreated);
  }
  /**
   * Having connected, load initial data from the database and prepare for use
   * @return {Promise} Resolves on success
   */


  init() {
    return Promise.all([this.loadAccountData(), this.loadSyncData()]).then(([accountData, syncData]) => {
      _logger.logger.log(`LocalIndexedDBStoreBackend: loaded initial data`);

      this.syncAccumulator.accumulate({
        next_batch: syncData.nextBatch,
        rooms: syncData.roomsData,
        groups: syncData.groupsData,
        account_data: {
          events: accountData
        }
      }, true);
    });
  }
  /**
   * Returns the out-of-band membership events for this room that
   * were previously loaded.
   * @param {string} roomId
   * @returns {Promise<event[]>} the events, potentially an empty array if OOB loading didn't yield any new members
   * @returns {null} in case the members for this room haven't been stored yet
   */


  getOutOfBandMembers(roomId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["oob_membership_events"], "readonly");
      const store = tx.objectStore("oob_membership_events");
      const roomIndex = store.index("room");
      const range = IDBKeyRange.only(roomId);
      const request = roomIndex.openCursor(range);
      const membershipEvents = []; // did we encounter the oob_written marker object
      // amongst the results? That means OOB member
      // loading already happened for this room
      // but there were no members to persist as they
      // were all known already

      let oobWritten = false;

      request.onsuccess = () => {
        const cursor = request.result;

        if (!cursor) {
          // Unknown room
          if (!membershipEvents.length && !oobWritten) {
            return resolve(null);
          }

          return resolve(membershipEvents);
        }

        const record = cursor.value;

        if (record.oob_written) {
          oobWritten = true;
        } else {
          membershipEvents.push(record);
        }

        cursor.continue();
      };

      request.onerror = err => {
        reject(err);
      };
    }).then(events => {
      _logger.logger.log(`LL: got ${events && events.length} membershipEvents from storage for room ${roomId} ...`);

      return events;
    });
  }
  /**
   * Stores the out-of-band membership events for this room. Note that
   * it still makes sense to store an empty array as the OOB status for the room is
   * marked as fetched, and getOutOfBandMembers will return an empty array instead of null
   * @param {string} roomId
   * @param {event[]} membershipEvents the membership events to store
   */


  async setOutOfBandMembers(roomId, membershipEvents) {
    _logger.logger.log(`LL: backend about to store ${membershipEvents.length}` + ` members for ${roomId}`);

    const tx = this.db.transaction(["oob_membership_events"], "readwrite");
    const store = tx.objectStore("oob_membership_events");
    membershipEvents.forEach(e => {
      store.put(e);
    }); // aside from all the events, we also write a marker object to the store
    // to mark the fact that OOB members have been written for this room.
    // It's possible that 0 members need to be written as all where previously know
    // but we still need to know whether to return null or [] from getOutOfBandMembers
    // where null means out of band members haven't been stored yet for this room

    const markerObject = {
      room_id: roomId,
      oob_written: true,
      state_key: 0
    };
    store.put(markerObject);
    await txnAsPromise(tx);

    _logger.logger.log(`LL: backend done storing for ${roomId}!`);
  }

  async clearOutOfBandMembers(roomId) {
    // the approach to delete all members for a room
    // is to get the min and max state key from the index
    // for that room, and then delete between those
    // keys in the store.
    // this should be way faster than deleting every member
    // individually for a large room.
    const readTx = this.db.transaction(["oob_membership_events"], "readonly");
    const store = readTx.objectStore("oob_membership_events");
    const roomIndex = store.index("room");
    const roomRange = IDBKeyRange.only(roomId);
    const minStateKeyProm = reqAsCursorPromise(roomIndex.openKeyCursor(roomRange, "next")).then(cursor => cursor && cursor.primaryKey[1]);
    const maxStateKeyProm = reqAsCursorPromise(roomIndex.openKeyCursor(roomRange, "prev")).then(cursor => cursor && cursor.primaryKey[1]);
    const [minStateKey, maxStateKey] = await Promise.all([minStateKeyProm, maxStateKeyProm]);
    const writeTx = this.db.transaction(["oob_membership_events"], "readwrite");
    const writeStore = writeTx.objectStore("oob_membership_events");
    const membersKeyRange = IDBKeyRange.bound([roomId, minStateKey], [roomId, maxStateKey]);

    _logger.logger.log(`LL: Deleting all users + marker in storage for room ${roomId}, with key range:`, [roomId, minStateKey], [roomId, maxStateKey]);

    await reqAsPromise(writeStore.delete(membersKeyRange));
  }
  /**
   * Clear the entire database. This should be used when logging out of a client
   * to prevent mixing data between accounts.
   * @return {Promise} Resolved when the database is cleared.
   */


  clearDatabase() {
    return new Promise(resolve => {
      _logger.logger.log(`Removing indexeddb instance: ${this.dbName}`);

      const req = this.indexedDB.deleteDatabase(this.dbName);

      req.onblocked = () => {
        _logger.logger.log(`can't yet delete indexeddb ${this.dbName} because it is open elsewhere`);
      };

      req.onerror = () => {
        // in firefox, with indexedDB disabled, this fails with a
        // DOMError. We treat this as non-fatal, so that we can still
        // use the app.
        _logger.logger.warn(`unable to delete js-sdk store indexeddb: ${req.error}`);

        resolve();
      };

      req.onsuccess = () => {
        _logger.logger.log(`Removed indexeddb instance: ${this.dbName}`);

        resolve();
      };
    });
  }
  /**
   * @param {boolean=} copy If false, the data returned is from internal
   * buffers and must not be mutated. Otherwise, a copy is made before
   * returning such that the data can be safely mutated. Default: true.
   *
   * @return {Promise} Resolves with a sync response to restore the
   * client state to where it was at the last save, or null if there
   * is no saved sync data.
   */


  getSavedSync(copy = true) {
    const data = this.syncAccumulator.getJSON();
    if (!data.nextBatch) return Promise.resolve(null);

    if (copy) {
      // We must deep copy the stored data so that the /sync processing code doesn't
      // corrupt the internal state of the sync accumulator (it adds non-clonable keys)
      return Promise.resolve(utils.deepCopy(data));
    } else {
      return Promise.resolve(data);
    }
  }

  getNextBatchToken() {
    return Promise.resolve(this.syncAccumulator.getNextBatchToken());
  }

  setSyncData(syncData) {
    return Promise.resolve().then(() => {
      this.syncAccumulator.accumulate(syncData);
    });
  }

  async syncToDatabase(userTuples) {
    const syncData = this.syncAccumulator.getJSON(true);
    await Promise.all([this.persistUserPresenceEvents(userTuples), this.persistAccountData(syncData.accountData), this.persistSyncData(syncData.nextBatch, syncData.roomsData, syncData.groupsData)]);
  }
  /**
   * Persist rooms /sync data along with the next batch token.
   * @param {string} nextBatch The next_batch /sync value.
   * @param {Object} roomsData The 'rooms' /sync data from a SyncAccumulator
   * @param {Object} groupsData The 'groups' /sync data from a SyncAccumulator
   * @return {Promise} Resolves if the data was persisted.
   */


  persistSyncData(nextBatch, roomsData, groupsData) {
    _logger.logger.log("Persisting sync data up to", nextBatch);

    return utils.promiseTry(() => {
      const txn = this.db.transaction(["sync"], "readwrite");
      const store = txn.objectStore("sync");
      store.put({
        clobber: "-",
        // constant key so will always clobber
        nextBatch,
        roomsData,
        groupsData
      }); // put == UPSERT

      return txnAsPromise(txn).then();
    });
  }
  /**
   * Persist a list of account data events. Events with the same 'type' will
   * be replaced.
   * @param {Object[]} accountData An array of raw user-scoped account data events
   * @return {Promise} Resolves if the events were persisted.
   */


  persistAccountData(accountData) {
    return utils.promiseTry(() => {
      const txn = this.db.transaction(["accountData"], "readwrite");
      const store = txn.objectStore("accountData");

      for (let i = 0; i < accountData.length; i++) {
        store.put(accountData[i]); // put == UPSERT
      }

      return txnAsPromise(txn).then();
    });
  }
  /**
   * Persist a list of [user id, presence event] they are for.
   * Users with the same 'userId' will be replaced.
   * Presence events should be the event in its raw form (not the Event
   * object)
   * @param {Object[]} tuples An array of [userid, event] tuples
   * @return {Promise} Resolves if the users were persisted.
   */


  persistUserPresenceEvents(tuples) {
    return utils.promiseTry(() => {
      const txn = this.db.transaction(["users"], "readwrite");
      const store = txn.objectStore("users");

      for (const tuple of tuples) {
        store.put({
          userId: tuple[0],
          event: tuple[1]
        }); // put == UPSERT
      }

      return txnAsPromise(txn).then();
    });
  }
  /**
   * Load all user presence events from the database. This is not cached.
   * FIXME: It would probably be more sensible to store the events in the
   * sync.
   * @return {Promise<Object[]>} A list of presence events in their raw form.
   */


  getUserPresenceEvents() {
    return utils.promiseTry(() => {
      const txn = this.db.transaction(["users"], "readonly");
      const store = txn.objectStore("users");
      return selectQuery(store, undefined, cursor => {
        return [cursor.value.userId, cursor.value.event];
      });
    });
  }
  /**
   * Load all the account data events from the database. This is not cached.
   * @return {Promise<Object[]>} A list of raw global account events.
   */


  loadAccountData() {
    _logger.logger.log(`LocalIndexedDBStoreBackend: loading account data...`);

    return utils.promiseTry(() => {
      const txn = this.db.transaction(["accountData"], "readonly");
      const store = txn.objectStore("accountData");
      return selectQuery(store, undefined, cursor => {
        return cursor.value;
      }).then(result => {
        _logger.logger.log(`LocalIndexedDBStoreBackend: loaded account data`);

        return result;
      });
    });
  }
  /**
   * Load the sync data from the database.
   * @return {Promise<Object>} An object with "roomsData" and "nextBatch" keys.
   */


  loadSyncData() {
    _logger.logger.log(`LocalIndexedDBStoreBackend: loading sync data...`);

    return utils.promiseTry(() => {
      const txn = this.db.transaction(["sync"], "readonly");
      const store = txn.objectStore("sync");
      return selectQuery(store, undefined, cursor => {
        return cursor.value;
      }).then(results => {
        _logger.logger.log(`LocalIndexedDBStoreBackend: loaded sync data`);

        if (results.length > 1) {
          _logger.logger.warn("loadSyncData: More than 1 sync row found.");
        }

        return results.length > 0 ? results[0] : {};
      });
    });
  }

  getClientOptions() {
    return Promise.resolve().then(() => {
      const txn = this.db.transaction(["client_options"], "readonly");
      const store = txn.objectStore("client_options");
      return selectQuery(store, undefined, cursor => {
        if (cursor.value && cursor.value && cursor.value.options) {
          return cursor.value.options;
        }
      }).then(results => results[0]);
    });
  }

  async storeClientOptions(options) {
    const txn = this.db.transaction(["client_options"], "readwrite");
    const store = txn.objectStore("client_options");
    store.put({
      clobber: "-",
      // constant key so will always clobber
      options: options
    }); // put == UPSERT

    await txnAsPromise(txn);
  }

}

exports.LocalIndexedDBStoreBackend = LocalIndexedDBStoreBackend;