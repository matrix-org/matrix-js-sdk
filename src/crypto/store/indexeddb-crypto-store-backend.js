import Promise from 'bluebird';
import utils from '../../utils';

export const VERSION = 4;

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
            console.log(`versionchange for indexeddb ${this._dbName}: closing`);
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

        const deferred = Promise.defer();
        const txn = this._db.transaction("outgoingRoomKeyRequests", "readwrite");
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
        const deferred = Promise.defer();

        const txn = this._db.transaction("outgoingRoomKeyRequests", "readonly");
        txn.onerror = deferred.reject;

        this._getOutgoingRoomKeyRequest(txn, requestBody, (existing) => {
            deferred.resolve(existing);
        });
        return deferred.promise;
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
                console.warn(
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

    // Olm Sessions

    getEndToEndSessions(deviceKey, txn, func) {
        const objectStore = txn.objectStore("sessions");
        const idx = objectStore.index("deviceKey");
        const getReq = idx.openCursor(deviceKey);
        const results = {};
        getReq.onsuccess = function() {
            const cursor = getReq.result;
            if (cursor) {
                results[cursor.value.sessionId] = cursor.value.session;
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
                    func(getReq.result.session);
                } else {
                    func(null);
                }
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    storeEndToEndSession(deviceKey, sessionId, session, txn) {
        const objectStore = txn.objectStore("sessions");
        objectStore.put({deviceKey, sessionId, session});
    }

    // Inbound group sessions

    getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        const objectStore = txn.objectStore("inbound_group_sessions");
        const getReq = objectStore.get([senderCurve25519Key, sessionId]);
        getReq.onsuccess = function() {
            try {
                if (getReq.result) {
                    func(getReq.result.session);
                } else {
                    func(null);
                }
            } catch (e) {
                abortWithException(txn, e);
            }
        };
    }

    addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const objectStore = txn.objectStore("inbound_group_sessions");
        const addReq = objectStore.add({
            senderCurve25519Key, sessionId, session: sessionData,
        });
        addReq.onerror = () => {
            abortWithException(txn, new Error("Inbound Session already exists"));
        };
    }

    storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const objectStore = txn.objectStore("inbound_group_sessions");
        const addReq = objectStore.put({
            senderCurve25519Key, sessionId, session: sessionData,
        });
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
    console.log(
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
        txn.onerror = () => {
            if (txn._mx_abortexception !== undefined) {
                reject(txn._mx_abortexception);
            }
            reject();
        };
        txn.onabort = () => reject(txn._mx_abortexception);
    });
}
