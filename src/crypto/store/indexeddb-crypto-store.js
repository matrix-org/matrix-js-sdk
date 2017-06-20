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
import utils from '../../utils';

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
            console.log(`connecting to indexeddb ${this._dbName}`);
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
                console.log(
                    `can't yet open IndexedDBCryptoStore because it is open elsewhere`,
                );
            };

            req.onerror = (ev) => {
                reject(new Error(
                    "unable to connect to indexeddb: " + ev.target.error,
                ));
            };

            req.onsuccess = (r) => {
                const db = r.target.result;

                // make sure we close the db on `onversionchange` - otherwise
                // attempts to delete the database will block (and subsequent
                // attempts to re-create it will also block).
                db.onversionchange = (ev) => {
                    console.log(`versionchange for indexeddb ${this._dbName}: closing`);
                    db.close();
                };

                console.log(`connected to indexeddb ${this._dbName}`);
                resolve(db);
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

            req.onblocked = () => {
                console.log(
                    `can't yet delete IndexedDBCryptoStore because it is open elsewhere`,
                );
            };

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
        const requestBody = request.requestBody;

        return this.connect().then((db) => {
            const deferred = q.defer();
            const txn = db.transaction("outgoingRoomKeyRequests", "readwrite");
            txn.onerror = deferred.reject;

            // first see if we already have an entry for this request.
            this._getOutgoingRoomKeyRequest(txn, requestBody, (existing) => {
                if (existing) {
                    // this entry matches the request - return it.
                    console.log(
                        `already have key request outstanding for ` +
                        `${requestBody.room_id} / ${requestBody.session_id}: ` +
                        `not sending another`,
                    );
                    deferred.resolve(existing);
                    return;
                }

                // we got to the end of the list without finding a match
                // - add the new request.
                console.log(
                    `enqueueing key request for ${requestBody.room_id} / ` +
                    requestBody.session_id,
                );
                const store = txn.objectStore("outgoingRoomKeyRequests");
                store.add(request);
                txn.onsuccess = () => { deferred.resolve(request); };
            });

            return deferred.promise;
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
        return this.connect().then((db) => {
            const deferred = q.defer();

            const txn = db.transaction("outgoingRoomKeyRequests", "readonly");
            txn.onerror = deferred.reject;

            this._getOutgoingRoomKeyRequest(txn, requestBody, (existing) => {
                deferred.resolve(existing);
            });
            return deferred.promise;
        });
    }

    /**
     * look for an existing room key request in the db
     *
     * @private
     * @param {IDBTransaction} txn  database transaction
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    existing request to look for
     * @param {Function} callback  function to call with the results of the
     *    search. Either passed a matching
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    not found.
     */
    _getOutgoingRoomKeyRequest(txn, requestBody, callback) {
        const store = txn.objectStore("outgoingRoomKeyRequests");

        const idx = store.index("session");
        const cursorReq = idx.openCursor([
            requestBody.room_id,
            requestBody.session_id,
        ]);

        cursorReq.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if(!cursor) {
                // no match found
                callback(null);
                return;
            }

            const existing = cursor.value;

            if (utils.deepCompare(existing.requestBody, requestBody)) {
                // got a match
                callback(existing);
                return;
            }

            // look at the next entry in the index
            cursor.continue();
        };
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
        if (wantedStates.length === 0) {
            return q(null);
        }

        // this is a bit tortuous because we need to make sure we do the lookup
        // in a single transaction, to avoid having a race with the insertion
        // code.

        // index into the wantedStates array
        let stateIndex = 0;
        let result;

        function onsuccess(ev) {
            const cursor = ev.target.result;
            if (cursor) {
                // got a match
                result = cursor.value;
                return;
            }

            // try the next state in the list
            stateIndex++;
            if (stateIndex >= wantedStates.length) {
                // no matches
                return;
            }

            const wantedState = wantedStates[stateIndex];
            const cursorReq = ev.target.source.openCursor(wantedState);
            cursorReq.onsuccess = onsuccess;
        }

        return this.connect().then((db) => {
            const txn = db.transaction("outgoingRoomKeyRequests", "readonly");
            const store = txn.objectStore("outgoingRoomKeyRequests");

            const wantedState = wantedStates[stateIndex];
            const cursorReq = store.index("state").openCursor(wantedState);
            cursorReq.onsuccess = onsuccess;

            return promiseifyTxn(txn).then(() => result);
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
        let result = null;

        function onsuccess(ev) {
            const cursor = ev.target.result;
            if (!cursor) {
                return;
            }
            const data = cursor.value;
            if (data.state != expectedState) {
                console.warn(
                    `Cannot update room key request from ${expectedState} ` +
                    `as it was already updated to ${data.state}`,
                );
                return;
            }
            Object.assign(data, updates);
            cursor.update(data);
            result = data;
        }

        return this.connect().then((db) => {
            const txn = db.transaction("outgoingRoomKeyRequests", "readwrite");
            const cursorReq = txn.objectStore("outgoingRoomKeyRequests")
                .openCursor(requestId);
            cursorReq.onsuccess = onsuccess;
            return promiseifyTxn(txn).then(() => result);
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
        return this.connect().then((db) => {
            const txn = db.transaction("outgoingRoomKeyRequests", "readwrite");
            const cursorReq = txn.objectStore("outgoingRoomKeyRequests")
                .openCursor(requestId);
            cursorReq.onsuccess = (ev) => {
                const cursor = ev.target.result;
                if (!cursor) {
                    return;
                }
                const data = cursor.value;
                if (data.state != expectedState) {
                    console.warn(
                        `Cannot delete room key request in state ${data.state} `
                        + `(expected ${expectedState})`,
                    );
                    return;
                }
                cursor.delete();
            };
            return promiseifyTxn(txn);
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

function promiseifyTxn(txn) {
    return new q.Promise((resolve, reject) => {
        txn.oncomplete = resolve;
        txn.onerror = reject;
    });
}
