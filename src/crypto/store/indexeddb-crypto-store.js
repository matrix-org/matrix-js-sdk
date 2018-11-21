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

import logger from '../../logger';
import LocalStorageCryptoStore from './localStorage-crypto-store';
import MemoryCryptoStore from './memory-crypto-store';
import * as IndexedDBCryptoStoreBackend from './indexeddb-crypto-store-backend';
import {InvalidCryptoStoreError} from '../../errors';

/**
 * Internal module. indexeddb storage for e2e.
 *
 * @module
 */

/**
 * An implementation of CryptoStore, which is normally backed by an indexeddb,
 * but with fallback to MemoryCryptoStore.
 *
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
        this._indexedDB = indexedDB;
        this._dbName = dbName;
        this._backendPromise = null;
    }

    /**
     * Ensure the database exists and is up-to-date, or fall back to
     * a local storage or in-memory store.
     *
     * @return {Promise} resolves to either an IndexedDBCryptoStoreBackend.Backend,
     * or a MemoryCryptoStore
     */
    _connect() {
        if (this._backendPromise) {
            return this._backendPromise;
        }

        this._backendPromise = new Promise((resolve, reject) => {
            if (!this._indexedDB) {
                reject(new Error('no indexeddb support available'));
                return;
            }

            logger.log(`connecting to indexeddb ${this._dbName}`);

            const req = this._indexedDB.open(
                this._dbName, IndexedDBCryptoStoreBackend.VERSION,
            );

            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                const oldVersion = ev.oldVersion;
                IndexedDBCryptoStoreBackend.upgradeDatabase(db, oldVersion);
            };

            req.onblocked = () => {
                logger.log(
                    `can't yet open IndexedDBCryptoStore because it is open elsewhere`,
                );
            };

            req.onerror = (ev) => {
                reject(ev.target.error);
            };

            req.onsuccess = (r) => {
                const db = r.target.result;

                logger.log(`connected to indexeddb ${this._dbName}`);
                resolve(new IndexedDBCryptoStoreBackend.Backend(db));
            };
        }).then((backend) => {
            // Edge has IndexedDB but doesn't support compund keys which we use fairly extensively.
            // Try a dummy query which will fail if the browser doesn't support compund keys, so
            // we can fall back to a different backend.
            return backend.doTxn(
                'readonly',
                [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS],
                (txn) => {
                    backend.getEndToEndInboundGroupSession('', '', txn, () => {});
                }).then(() => {
                    return backend;
                },
            );
        }).catch((e) => {
            if (e.name === 'VersionError') {
                logger.warn("Crypto DB is too new for us to use!", e);
                // don't fall back to a different store: the user has crypto data
                // in this db so we should use it or nothing at all.
                throw new InvalidCryptoStoreError(InvalidCryptoStoreError.TOO_NEW);
            }
            logger.warn(
                `unable to connect to indexeddb ${this._dbName}` +
                    `: falling back to localStorage store: ${e}`,
            );

            try {
                return new LocalStorageCryptoStore(global.localStorage);
            } catch (e) {
                logger.warn(
                    `unable to open localStorage: falling back to in-memory store: ${e}`,
                );
                return new MemoryCryptoStore();
            }
        });

        return this._backendPromise;
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} resolves when the store has been cleared.
     */
    deleteAllData() {
        return new Promise((resolve, reject) => {
            if (!this._indexedDB) {
                reject(new Error('no indexeddb support available'));
                return;
            }

            logger.log(`Removing indexeddb instance: ${this._dbName}`);
            const req = this._indexedDB.deleteDatabase(this._dbName);

            req.onblocked = () => {
                logger.log(
                    `can't yet delete IndexedDBCryptoStore because it is open elsewhere`,
                );
            };

            req.onerror = (ev) => {
                reject(ev.target.error);
            };

            req.onsuccess = () => {
                logger.log(`Removed indexeddb instance: ${this._dbName}`);
                resolve();
            };
        }).catch((e) => {
            // in firefox, with indexedDB disabled, this fails with a
            // DOMError. We treat this as non-fatal, so that people can
            // still use the app.
            logger.warn(`unable to delete IndexedDBCryptoStore: ${e}`);
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
        return this._connect().then((backend) => {
            return backend.getOrAddOutgoingRoomKeyRequest(request);
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
        return this._connect().then((backend) => {
            return backend.getOutgoingRoomKeyRequest(requestBody);
        });
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
        return this._connect().then((backend) => {
            return backend.getOutgoingRoomKeyRequestByState(wantedStates);
        });
    }

    /**
     * Look for room key requests by target device and state
     *
     * @param {string} userId Target user ID
     * @param {string} deviceId Target device ID
     * @param {Array<Number>} wantedStates list of acceptable states
     *
     * @return {Promise} resolves to a list of all the
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
     */
    getOutgoingRoomKeyRequestsByTarget(userId, deviceId, wantedStates) {
        return this._connect().then((backend) => {
            return backend.getOutgoingRoomKeyRequestsByTarget(
                userId, deviceId, wantedStates,
            );
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
        return this._connect().then((backend) => {
            return backend.updateOutgoingRoomKeyRequest(
                requestId, expectedState, updates,
            );
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
        return this._connect().then((backend) => {
            return backend.deleteOutgoingRoomKeyRequest(requestId, expectedState);
        });
    }

    // Olm Account

    /*
     * Get the account pickle from the store.
     * This requires an active transaction. See doTxn().
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(string)} func Called with the account pickle
     */
    getAccount(txn, func) {
        this._backendPromise.value().getAccount(txn, func);
    }

    /*
     * Write the account pickle to the store.
     * This requires an active transaction. See doTxn().
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {string} newData The new account pickle to store.
     */
    storeAccount(txn, newData) {
        this._backendPromise.value().storeAccount(txn, newData);
    }

    // Olm sessions

    /**
     * Returns the number of end-to-end sessions in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(int)} func Called with the count of sessions
     */
    countEndToEndSessions(txn, func) {
        this._backendPromise.value().countEndToEndSessions(txn, func);
    }

    /**
     * Retrieve a specific end-to-end session between the logged-in user
     * and another device.
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID of the session to retrieve
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to session information object with 'session' key being the
     *     Base64 end-to-end session and lastReceivedMessageTs being the
     *     timestamp in milliseconds at which the session last received
     *     a message.
     */
    getEndToEndSession(deviceKey, sessionId, txn, func) {
        this._backendPromise.value().getEndToEndSession(deviceKey, sessionId, txn, func);
    }

    /**
     * Retrieve the end-to-end sessions between the logged-in user and another
     * device.
     * @param {string} deviceKey The public key of the other device.
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to session information object with 'session' key being the
     *     Base64 end-to-end session and lastReceivedMessageTs being the
     *     timestamp in milliseconds at which the session last received
     *     a message.
     */
    getEndToEndSessions(deviceKey, txn, func) {
        this._backendPromise.value().getEndToEndSessions(deviceKey, txn, func);
    }

    /**
     * Store a session between the logged-in user and another device
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID for this end-to-end session.
     * @param {string} sessionInfo Session information object
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
        this._backendPromise.value().storeEndToEndSession(
            deviceKey, sessionId, sessionInfo, txn,
        );
    }

    // Inbound group saessions

    /**
     * Retrieve the end-to-end inbound group session for a given
     * server key and session ID
     * @param {string} senderCurve25519Key The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to Base64 end-to-end session.
     */
    getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        this._backendPromise.value().getEndToEndInboundGroupSession(
            senderCurve25519Key, sessionId, txn, func,
        );
    }

    /**
     * Fetches all inbound group sessions in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called once for each group session
     *     in the store with an object having keys {senderKey, sessionId,
     *     sessionData}, then once with null to indicate the end of the list.
     */
    getAllEndToEndInboundGroupSessions(txn, func) {
        this._backendPromise.value().getAllEndToEndInboundGroupSessions(txn, func);
    }

    /**
     * Adds an end-to-end inbound group session to the store.
     * If there already exists an inbound group session with the same
     * senderCurve25519Key and sessionID, the session will not be added.
     * @param {string} senderCurve25519Key The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {object} sessionData The session data structure
     * @param {*} txn An active transaction. See doTxn().
     */
    addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        this._backendPromise.value().addEndToEndInboundGroupSession(
            senderCurve25519Key, sessionId, sessionData, txn,
        );
    }

    /**
     * Writes an end-to-end inbound group session to the store.
     * If there already exists an inbound group session with the same
     * senderCurve25519Key and sessionID, it will be overwritten.
     * @param {string} senderCurve25519Key The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {object} sessionData The session data structure
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        this._backendPromise.value().storeEndToEndInboundGroupSession(
            senderCurve25519Key, sessionId, sessionData, txn,
        );
    }

    // End-to-end device tracking

    /**
     * Store the state of all tracked devices
     * This contains devices for each user, a tracking state for each user
     * and a sync token matching the point in time the snapshot represents.
     * These all need to be written out in full each time such that the snapshot
     * is always consistent, so they are stored in one object.
     *
     * @param {Object} deviceData
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndDeviceData(deviceData, txn) {
        this._backendPromise.value().storeEndToEndDeviceData(deviceData, txn);
    }

    /**
     * Get the state of all tracked devices
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(Object)} func Function called with the
     *     device data
     */
    getEndToEndDeviceData(txn, func) {
        this._backendPromise.value().getEndToEndDeviceData(txn, func);
    }

    // End to End Rooms

    /**
     * Store the end-to-end state for a room.
     * @param {string} roomId The room's ID.
     * @param {object} roomInfo The end-to-end info for the room.
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndRoom(roomId, roomInfo, txn) {
        this._backendPromise.value().storeEndToEndRoom(roomId, roomInfo, txn);
    }

    /**
     * Get an object of roomId->roomInfo for all e2e rooms in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(Object)} func Function called with the end to end encrypted rooms
     */
    getEndToEndRooms(txn, func) {
        this._backendPromise.value().getEndToEndRooms(txn, func);
    }

    // session backups

    /**
     * Get the inbound group sessions that need to be backed up.
     * @param {integer} limit The maximum number of sessions to retrieve.  0
     * for no limit.
     * @returns {Promise} resolves to an array of inbound group sessions
     */
    getSessionsNeedingBackup(limit) {
        return this._connect().then((backend) => {
            return backend.getSessionsNeedingBackup(limit);
        });
    }

    /**
     * Unmark sessions as needing to be backed up.
     * @param {Array<object>} sessions The sessions that need to be backed up.
     * @returns {Promise} resolves when the sessions are unmarked
     */
    unmarkSessionsNeedingBackup(sessions) {
        return this._connect().then((backend) => {
            return backend.unmarkSessionsNeedingBackup(sessions);
        });
    }

    /**
     * Mark sessions as needing to be backed up.
     * @param {Array<object>} sessions The sessions that need to be backed up.
     * @param {*} txn An active transaction. See doTxn(). (optional)
     * @returns {Promise} resolves when the sessions are marked
     */
    markSessionsNeedingBackup(sessions, txn) {
        return this._connect().then((backend) => {
            return backend.markSessionsNeedingBackup(sessions, txn);
        });
    }

    /**
     * Perform a transaction on the crypto store. Any store methods
     * that require a transaction (txn) object to be passed in may
     * only be called within a callback of either this function or
     * one of the store functions operating on the same transaction.
     *
     * @param {string} mode 'readwrite' if you need to call setter
     *     functions with this transaction. Otherwise, 'readonly'.
     * @param {string[]} stores List IndexedDBCryptoStore.STORE_*
     *     options representing all types of object that will be
     *     accessed or written to with this transaction.
     * @param {function(*)} func Function called with the
     *     transaction object: an opaque object that should be passed
     *     to store functions.
     * @return {Promise} Promise that resolves with the result of the `func`
     *     when the transaction is complete. If the backend is
     *     async (ie. the indexeddb backend) any of the callback
     *     functions throwing an exception will cause this promise to
     *     reject with that exception. On synchronous backends, the
     *     exception will propagate to the caller of the getFoo method.
     */
    doTxn(mode, stores, func) {
        return this._connect().then((backend) => {
            return backend.doTxn(mode, stores, func);
        });
    }
}

IndexedDBCryptoStore.STORE_ACCOUNT = 'account';
IndexedDBCryptoStore.STORE_SESSIONS = 'sessions';
IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS = 'inbound_group_sessions';
IndexedDBCryptoStore.STORE_DEVICE_DATA = 'device_data';
IndexedDBCryptoStore.STORE_ROOMS = 'rooms';
IndexedDBCryptoStore.STORE_BACKUP = 'sessions_needing_backup';
