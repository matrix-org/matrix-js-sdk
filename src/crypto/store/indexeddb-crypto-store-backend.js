/*
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import {logger} from '../../logger';
import * as utils from "../../utils";

export const VERSION = 9;

/**
 * Implementation of a CryptoStore which is backed by an existing
 * IndexedDB connection. Generally you want IndexedDBCryptoStore
 * which connects to the database and defers to one of these.
 *
 * @implements {module:crypto/store/base~CryptoStore}
 */
export class Backend {
    /**
     * @param {IDBDatabase} db
     */
    constructor(db) {
        this._db = db;

        // make sure we close the db on `onversionchange` - otherwise
        // attempts to delete the database will block (and subsequent
        // attempts to re-create it will also block).
        db.onversionchange = (ev) => {
            logger.log(`versionchange for indexeddb ${this._dbName}: closing`);
            db.close();
        };
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

        return new Promise((resolve, reject) => {
            const txn = this._db.transaction("outgoingRoomKeyRequests", "readwrite");
            txn.onerror = reject;

            // first see if we already have an entry for this request.
            this._getOutgoingRoomKeyRequest(txn, requestBody, (existing) => {
                if (existing) {
                    // this entry matches the request - return it.
                    logger.log(
                        `already have key request outstanding for ` +
                            `${requestBody.room_id} / ${requestBody.session_id}: ` +
                            `not sending another`,
                    );
                    resolve(existing);
                    return;
                }

                // we got to the end of the list without finding a match
                // - add the new request.
                logger.log(
                    `enqueueing key request for ${requestBody.room_id} / ` +
                        requestBody.session_id,
                );
                txn.oncomplete = () => {resolve(request);};
                const store = txn.objectStore("outgoingRoomKeyRequests");
                store.add(request);
            });
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
        return new Promise((resolve, reject) => {
            const txn = this._db.transaction("outgoingRoomKeyRequests", "readonly");
            txn.onerror = reject;

            this._getOutgoingRoomKeyRequest(txn, requestBody, (existing) => {
                resolve(existing);
            });
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
            if (!cursor) {
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
            return Promise.resolve(null);
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

        const txn = this._db.transaction("outgoingRoomKeyRequests", "readonly");
        const store = txn.objectStore("outgoingRoomKeyRequests");

        const wantedState = wantedStates[stateIndex];
        const cursorReq = store.index("state").openCursor(wantedState);
        cursorReq.onsuccess = onsuccess;

        return promiseifyTxn(txn).then(() => result);
    }

    /**
     *
     * @param {Number} wantedState
     * @return {Promise<Array<*>>} All elements in a given state
     */
    getAllOutgoingRoomKeyRequestsByState(wantedState) {
        return new Promise((resolve, reject) => {
            const txn = this._db.transaction("outgoingRoomKeyRequests", "readonly");
            const store = txn.objectStore("outgoingRoomKeyRequests");
            const index = store.index("state");
            const request = index.getAll(wantedState);

            request.onsuccess = (ev) => resolve(ev.target.result);
            request.onerror = (ev) => reject(ev.target.error);
        });
    }

    getOutgoingRoomKeyRequestsByTarget(userId, deviceId, wantedStates) {
        let stateIndex = 0;
        const results = [];

        function onsuccess(ev) {
            const cursor = ev.target.result;
            if (cursor) {
                const keyReq = cursor.value;
                if (keyReq.recipients.includes({userId, deviceId})) {
                    results.push(keyReq);
                }
                cursor.continue();
            } else {
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
        }

        const txn = this._db.transaction("outgoingRoomKeyRequests", "readonly");
        const store = txn.objectStore("outgoingRoomKeyRequests");

        const wantedState = wantedStates[stateIndex];
        const cursorReq = store.index("state").openCursor(wantedState);
        cursorReq.onsuccess = onsuccess;

        return promiseifyTxn(txn).then(() => results);
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
                logger.warn(
                    `Cannot update room key request from ${expectedState} ` +
                    `as it was already updated to ${data.state}`,
                );
                return;
            }
            Object.assign(data, updates);
            cursor.update(data);
            result = data;
        }

        const txn = this._db.transaction("outgoingRoomKeyRequests", "readwrite");
        const cursorReq = txn.objectStore("outgoingRoomKeyRequests")
                  .openCursor(requestId);
        cursorReq.onsuccess = onsuccess;
        return promiseifyTxn(txn).then(() => result);
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
        const txn = this._db.transaction("outgoingRoomKeyRequests", "readwrite");
        const cursorReq = txn.objectStore("outgoingRoomKeyRequests")
                  .openCursor(requestId);
        cursorReq.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) {
                return;
            }
            const data = cursor.value;
            if (data.state != expectedState) {
                logger.warn(
                    `Cannot delete room key request in state ${data.state} `
                        + `(expected ${expectedState})`,
                );
                return;
            }
            cursor.delete();
        };
        return promiseifyTxn(txn);
    }

    // Olm Account

    getAccount(txn, func) {
        const objectStore = txn.objectStore("account");
        const getReq = objectStore.get("-");
        getReq.onsuccess = function() {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    storeAccount(txn, newData) {
        const objectStore = txn.objectStore("account");
        objectStore.put(newData, "-");
    }

    getCrossSigningKeys(txn, func) {
        const objectStore = txn.objectStore("account");
        const getReq = objectStore.get("crossSigningKeys");
        getReq.onsuccess = function() {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    getSecretStorePrivateKey(txn, func, type) {
        const objectStore = txn.objectStore("account");
        const getReq = objectStore.get(`ssss_cache:${type}`);
        getReq.onsuccess = function() {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    storeCrossSigningKeys(txn, keys) {
        const objectStore = txn.objectStore("account");
        objectStore.put(keys, "crossSigningKeys");
    }

    storeSecretStorePrivateKey(txn, type, key) {
        const objectStore = txn.objectStore("account");
        objectStore.put(key, `ssss_cache:${type}`);
    }

    // Olm Sessions

    countEndToEndSessions(txn, func) {
        const objectStore = txn.objectStore("sessions");
        const countReq = objectStore.count();
        countReq.onsuccess = function() {
            try {
                func(countReq.result);
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    getEndToEndSessions(deviceKey, txn, func) {
        const objectStore = txn.objectStore("sessions");
        const idx = objectStore.index("deviceKey");
        const getReq = idx.openCursor(deviceKey);
        const results = {};
        getReq.onsuccess = function() {
            const cursor = getReq.result;
            if (cursor) {
                results[cursor.value.sessionId] = {
                    session: cursor.value.session,
                    lastReceivedMessageTs: cursor.value.lastReceivedMessageTs,
                };
                cursor.continue();
            } else {
                try {
                    func(results);
                } catch (e) {
                    abortWithException(txn, e);
                }
            }
        };
    }

    getEndToEndSession(deviceKey, sessionId, txn, func) {
        const objectStore = txn.objectStore("sessions");
        const getReq = objectStore.get([deviceKey, sessionId]);
        getReq.onsuccess = function() {
            try {
                if (getReq.result) {
                    func({
                        session: getReq.result.session,
                        lastReceivedMessageTs: getReq.result.lastReceivedMessageTs,
                    });
                } else {
                    func(null);
                }
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    getAllEndToEndSessions(txn, func) {
        const objectStore = txn.objectStore("sessions");
        const getReq = objectStore.openCursor();
        getReq.onsuccess = function() {
            try {
                const cursor = getReq.result;
                if (cursor) {
                    func(cursor.value);
                    cursor.continue();
                } else {
                    func(null);
                }
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
        const objectStore = txn.objectStore("sessions");
        objectStore.put({
            deviceKey,
            sessionId,
            session: sessionInfo.session,
            lastReceivedMessageTs: sessionInfo.lastReceivedMessageTs,
        });
    }

    async storeEndToEndSessionProblem(deviceKey, type, fixed) {
        const txn = this._db.transaction("session_problems", "readwrite");
        const objectStore = txn.objectStore("session_problems");
        objectStore.put({
            deviceKey,
            type,
            fixed,
            time: Date.now(),
        });
        return promiseifyTxn(txn);
    }

    async getEndToEndSessionProblem(deviceKey, timestamp) {
        let result;
        const txn = this._db.transaction("session_problems", "readwrite");
        const objectStore = txn.objectStore("session_problems");
        const index = objectStore.index("deviceKey");
        const req = index.getAll(deviceKey);
        req.onsuccess = (event) => {
            const problems = req.result;
            if (!problems.length) {
                result = null;
                return;
            }
            problems.sort((a, b) => {
                return a.time - b.time;
            });
            const lastProblem = problems[problems.length - 1];
            for (const problem of problems) {
                if (problem.time > timestamp) {
                    result = Object.assign({}, problem, {fixed: lastProblem.fixed});
                    return;
                }
            }
            if (lastProblem.fixed) {
                result = null;
            } else {
                result = lastProblem;
            }
        };
        await promiseifyTxn(txn);
        return result;
    }

    // FIXME: we should probably prune this when devices get deleted
    async filterOutNotifiedErrorDevices(devices) {
        const txn = this._db.transaction("notified_error_devices", "readwrite");
        const objectStore = txn.objectStore("notified_error_devices");

        const ret = [];

        await Promise.all(devices.map((device) => {
            return new Promise((resolve) => {
                const {userId, deviceInfo} = device;
                const getReq = objectStore.get([userId, deviceInfo.deviceId]);
                getReq.onsuccess = function() {
                    if (!getReq.result) {
                        objectStore.put({userId, deviceId: deviceInfo.deviceId});
                        ret.push(device);
                    }
                    resolve();
                };
            });
        }));

        return ret;
    }

    // Inbound group sessions

    getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        let session = false;
        let withheld = false;
        const objectStore = txn.objectStore("inbound_group_sessions");
        const getReq = objectStore.get([senderCurve25519Key, sessionId]);
        getReq.onsuccess = function() {
            try {
                if (getReq.result) {
                    session = getReq.result.session;
                } else {
                    session = null;
                }
                if (withheld !== false) {
                    func(session, withheld);
                }
            } catch (e) {
                abortWithException(txn, e);
            }
        };

        const withheldObjectStore = txn.objectStore("inbound_group_sessions_withheld");
        const withheldGetReq = withheldObjectStore.get([senderCurve25519Key, sessionId]);
        withheldGetReq.onsuccess = function() {
            try {
                if (withheldGetReq.result) {
                    withheld = withheldGetReq.result.session;
                } else {
                    withheld = null;
                }
                if (session !== false) {
                    func(session, withheld);
                }
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    getAllEndToEndInboundGroupSessions(txn, func) {
        const objectStore = txn.objectStore("inbound_group_sessions");
        const getReq = objectStore.openCursor();
        getReq.onsuccess = function() {
            const cursor = getReq.result;
            if (cursor) {
                try {
                    func({
                        senderKey: cursor.value.senderCurve25519Key,
                        sessionId: cursor.value.sessionId,
                        sessionData: cursor.value.session,
                    });
                } catch (e) {
                    abortWithException(txn, e);
                }
                cursor.continue();
            } else {
                try {
                    func(null);
                } catch (e) {
                    abortWithException(txn, e);
                }
            }
        };
    }

    addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const objectStore = txn.objectStore("inbound_group_sessions");
        const addReq = objectStore.add({
            senderCurve25519Key, sessionId, session: sessionData,
        });
        addReq.onerror = (ev) => {
            if (addReq.error.name === 'ConstraintError') {
                // This stops the error from triggering the txn's onerror
                ev.stopPropagation();
                // ...and this stops it from aborting the transaction
                ev.preventDefault();
                logger.log(
                    "Ignoring duplicate inbound group session: " +
                    senderCurve25519Key + " / " + sessionId,
                );
            } else {
                abortWithException(txn, new Error(
                    "Failed to add inbound group session: " + addReq.error,
                ));
            }
        };
    }

    storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const objectStore = txn.objectStore("inbound_group_sessions");
        objectStore.put({
            senderCurve25519Key, sessionId, session: sessionData,
        });
    }

    storeEndToEndInboundGroupSessionWithheld(
        senderCurve25519Key, sessionId, sessionData, txn,
    ) {
        const objectStore = txn.objectStore("inbound_group_sessions_withheld");
        objectStore.put({
            senderCurve25519Key, sessionId, session: sessionData,
        });
    }

    getEndToEndDeviceData(txn, func) {
        const objectStore = txn.objectStore("device_data");
        const getReq = objectStore.get("-");
        getReq.onsuccess = function() {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    storeEndToEndDeviceData(deviceData, txn) {
        const objectStore = txn.objectStore("device_data");
        objectStore.put(deviceData, "-");
    }

    storeEndToEndRoom(roomId, roomInfo, txn) {
        const objectStore = txn.objectStore("rooms");
        objectStore.put(roomInfo, roomId);
    }

    getEndToEndRooms(txn, func) {
        const rooms = {};
        const objectStore = txn.objectStore("rooms");
        const getReq = objectStore.openCursor();
        getReq.onsuccess = function() {
            const cursor = getReq.result;
            if (cursor) {
                rooms[cursor.key] = cursor.value;
                cursor.continue();
            } else {
                try {
                    func(rooms);
                } catch (e) {
                    abortWithException(txn, e);
                }
            }
        };
    }

    // session backups

    getSessionsNeedingBackup(limit) {
        return new Promise((resolve, reject) => {
            const sessions = [];

            const txn = this._db.transaction(
                ["sessions_needing_backup", "inbound_group_sessions"],
                "readonly",
            );
            txn.onerror = reject;
            txn.oncomplete = function() {
                resolve(sessions);
            };
            const objectStore = txn.objectStore("sessions_needing_backup");
            const sessionStore = txn.objectStore("inbound_group_sessions");
            const getReq = objectStore.openCursor();
            getReq.onsuccess = function() {
                const cursor = getReq.result;
                if (cursor) {
                    const sessionGetReq = sessionStore.get(cursor.key);
                    sessionGetReq.onsuccess = function() {
                        sessions.push({
                            senderKey: sessionGetReq.result.senderCurve25519Key,
                            sessionId: sessionGetReq.result.sessionId,
                            sessionData: sessionGetReq.result.session,
                        });
                    };
                    if (!limit || sessions.length < limit) {
                        cursor.continue();
                    }
                }
            };
        });
    }

    countSessionsNeedingBackup(txn) {
        if (!txn) {
            txn = this._db.transaction("sessions_needing_backup", "readonly");
        }
        const objectStore = txn.objectStore("sessions_needing_backup");
        return new Promise((resolve, reject) => {
            const req = objectStore.count();
            req.onerror = reject;
            req.onsuccess = () => resolve(req.result);
        });
    }

    unmarkSessionsNeedingBackup(sessions, txn) {
        if (!txn) {
            txn = this._db.transaction("sessions_needing_backup", "readwrite");
        }
        const objectStore = txn.objectStore("sessions_needing_backup");
        return Promise.all(sessions.map((session) => {
            return new Promise((resolve, reject) => {
                const req = objectStore.delete([session.senderKey, session.sessionId]);
                req.onsuccess = resolve;
                req.onerror = reject;
            });
        }));
    }

    markSessionsNeedingBackup(sessions, txn) {
        if (!txn) {
            txn = this._db.transaction("sessions_needing_backup", "readwrite");
        }
        const objectStore = txn.objectStore("sessions_needing_backup");
        return Promise.all(sessions.map((session) => {
            return new Promise((resolve, reject) => {
                const req = objectStore.put({
                    senderCurve25519Key: session.senderKey,
                    sessionId: session.sessionId,
                });
                req.onsuccess = resolve;
                req.onerror = reject;
            });
        }));
    }

    doTxn(mode, stores, func) {
        const txn = this._db.transaction(stores, mode);
        const promise = promiseifyTxn(txn);
        const result = func(txn);
        return promise.then(() => {
            return result;
        });
    }
}

export function upgradeDatabase(db, oldVersion) {
    logger.log(
        `Upgrading IndexedDBCryptoStore from version ${oldVersion}`
            + ` to ${VERSION}`,
    );
    if (oldVersion < 1) { // The database did not previously exist.
        createDatabase(db);
    }
    if (oldVersion < 2) {
        db.createObjectStore("account");
    }
    if (oldVersion < 3) {
        const sessionsStore = db.createObjectStore("sessions", {
            keyPath: ["deviceKey", "sessionId"],
        });
        sessionsStore.createIndex("deviceKey", "deviceKey");
    }
    if (oldVersion < 4) {
        db.createObjectStore("inbound_group_sessions", {
            keyPath: ["senderCurve25519Key", "sessionId"],
        });
    }
    if (oldVersion < 5) {
        db.createObjectStore("device_data");
    }
    if (oldVersion < 6) {
        db.createObjectStore("rooms");
    }
    if (oldVersion < 7) {
        db.createObjectStore("sessions_needing_backup", {
            keyPath: ["senderCurve25519Key", "sessionId"],
        });
    }
    if (oldVersion < 8) {
        db.createObjectStore("inbound_group_sessions_withheld", {
            keyPath: ["senderCurve25519Key", "sessionId"],
        });
    }
    if (oldVersion < 9) {
        const problemsStore = db.createObjectStore("session_problems", {
            keyPath: ["deviceKey", "time"],
        });
        problemsStore.createIndex("deviceKey", "deviceKey");

        db.createObjectStore("notified_error_devices", {
            keyPath: ["userId", "deviceId"],
        });
    }
    // Expand as needed.
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

/*
 * Aborts a transaction with a given exception
 * The transaction promise will be rejected with this exception.
 */
function abortWithException(txn, e) {
    // We cheekily stick our exception onto the transaction object here
    // We could alternatively make the thing we pass back to the app
    // an object containing the transaction and exception.
    txn._mx_abortexception = e;
    try {
        txn.abort();
    } catch (e) {
        // sometimes we won't be able to abort the transaction
        // (ie. if it's aborted or completed)
    }
}

function promiseifyTxn(txn) {
    return new Promise((resolve, reject) => {
        txn.oncomplete = () => {
            if (txn._mx_abortexception !== undefined) {
                reject(txn._mx_abortexception);
            }
            resolve();
        };
        txn.onerror = (event) => {
            if (txn._mx_abortexception !== undefined) {
                reject(txn._mx_abortexception);
            } else {
                logger.log("Error performing indexeddb txn", event);
                reject(event.target.error);
            }
        };
        txn.onabort = (event) => {
            if (txn._mx_abortexception !== undefined) {
                reject(txn._mx_abortexception);
            } else {
                logger.log("Error performing indexeddb txn", event);
                reject(event.target.error);
            }
        };
    });
}
