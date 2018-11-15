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
import utils from '../../utils';

/**
 * Internal module. in-memory storage for e2e.
 *
 * @module
 */

/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
export default class MemoryCryptoStore {
    constructor() {
        this._outgoingRoomKeyRequests = [];
        this._account = null;

        // Map of {devicekey -> {sessionId -> session pickle}}
        this._sessions = {};
        // Map of {senderCurve25519Key+'/'+sessionId -> session data object}
        this._inboundGroupSessions = {};
        // Opaque device data object
        this._deviceData = null;
        // roomId -> Opaque roomInfo object
        this._rooms = {};
        // Set of {senderCurve25519Key+'/'+sessionId}
        this._sessionsNeedingBackup = {};
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} Promise which resolves when the store has been cleared.
     */
    deleteAllData() {
        return Promise.resolve();
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

        return Promise.try(() => {
            // first see if we already have an entry for this request.
            const existing = this._getOutgoingRoomKeyRequest(requestBody);

            if (existing) {
                // this entry matches the request - return it.
                logger.log(
                    `already have key request outstanding for ` +
                    `${requestBody.room_id} / ${requestBody.session_id}: ` +
                    `not sending another`,
                );
                return existing;
            }

            // we got to the end of the list without finding a match
            // - add the new request.
            logger.log(
                `enqueueing key request for ${requestBody.room_id} / ` +
                requestBody.session_id,
            );
            this._outgoingRoomKeyRequests.push(request);
            return request;
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
        return Promise.resolve(this._getOutgoingRoomKeyRequest(requestBody));
    }

    /**
     * Looks for existing room key request, and returns the result synchronously.
     *
     * @internal
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    existing request to look for
     *
     * @return {module:crypto/store/base~OutgoingRoomKeyRequest?}
     *    the matching request, or null if not found
     */
    _getOutgoingRoomKeyRequest(requestBody) {
        for (const existing of this._outgoingRoomKeyRequests) {
            if (utils.deepCompare(existing.requestBody, requestBody)) {
                return existing;
            }
        }
        return null;
    }

    /**
     * Look for room key requests by state
     *
     * @param {Array<Number>} wantedStates list of acceptable states
     *
     * @return {Promise} resolves to the a
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    there are no pending requests in those states
     */
    getOutgoingRoomKeyRequestByState(wantedStates) {
        for (const req of this._outgoingRoomKeyRequests) {
            for (const state of wantedStates) {
                if (req.state === state) {
                    return Promise.resolve(req);
                }
            }
        }
        return Promise.resolve(null);
    }

    getOutgoingRoomKeyRequestsByTarget(userId, deviceId, wantedStates) {
        const results = [];

        for (const req of this._outgoingRoomKeyRequests) {
            for (const state of wantedStates) {
                if (req.state === state && req.recipients.includes({userId, deviceId})) {
                    results.push(req);
                }
            }
        }
        return Promise.resolve(results);
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
        for (const req of this._outgoingRoomKeyRequests) {
            if (req.requestId !== requestId) {
                continue;
            }

            if (req.state != expectedState) {
                logger.warn(
                    `Cannot update room key request from ${expectedState} ` +
                    `as it was already updated to ${req.state}`,
                );
                return Promise.resolve(null);
            }
            Object.assign(req, updates);
            return Promise.resolve(req);
        }

        return Promise.resolve(null);
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
        for (let i = 0; i < this._outgoingRoomKeyRequests.length; i++) {
            const req = this._outgoingRoomKeyRequests[i];

            if (req.requestId !== requestId) {
                continue;
            }

            if (req.state != expectedState) {
                logger.warn(
                    `Cannot delete room key request in state ${req.state} `
                    + `(expected ${expectedState})`,
                );
                return Promise.resolve(null);
            }

            this._outgoingRoomKeyRequests.splice(i, 1);
            return Promise.resolve(req);
        }

        return Promise.resolve(null);
    }

    // Olm Account

    getAccount(txn, func) {
        func(this._account);
    }

    storeAccount(txn, newData) {
        this._account = newData;
    }

    // Olm Sessions

    countEndToEndSessions(txn, func) {
        return Object.keys(this._sessions).length;
    }

    getEndToEndSession(deviceKey, sessionId, txn, func) {
        const deviceSessions = this._sessions[deviceKey] || {};
        func(deviceSessions[sessionId] || null);
    }

    getEndToEndSessions(deviceKey, txn, func) {
        func(this._sessions[deviceKey] || {});
    }

    storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
        let deviceSessions = this._sessions[deviceKey];
        if (deviceSessions === undefined) {
            deviceSessions = {};
            this._sessions[deviceKey] = deviceSessions;
        }
        deviceSessions[sessionId] = sessionInfo;
    }

    // Inbound Group Sessions

    getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        func(this._inboundGroupSessions[senderCurve25519Key+'/'+sessionId] || null);
    }

    getAllEndToEndInboundGroupSessions(txn, func) {
        for (const key of Object.keys(this._inboundGroupSessions)) {
            // we can't use split, as the components we are trying to split out
            // might themselves contain '/' characters. We rely on the
            // senderKey being a (32-byte) curve25519 key, base64-encoded
            // (hence 43 characters long).

            func({
                senderKey: key.substr(0, 43),
                sessionId: key.substr(44),
                sessionData: this._inboundGroupSessions[key],
            });
        }
        func(null);
    }

    addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const k = senderCurve25519Key+'/'+sessionId;
        if (this._inboundGroupSessions[k] === undefined) {
            this._inboundGroupSessions[k] = sessionData;
        }
    }

    storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        this._inboundGroupSessions[senderCurve25519Key+'/'+sessionId] = sessionData;
    }

    // Device Data

    getEndToEndDeviceData(txn, func) {
        func(this._deviceData);
    }

    storeEndToEndDeviceData(deviceData, txn) {
        this._deviceData = deviceData;
    }

    // E2E rooms

    storeEndToEndRoom(roomId, roomInfo, txn) {
        this._rooms[roomId] = roomInfo;
    }

    getEndToEndRooms(txn, func) {
        func(this._rooms);
    }

    getSessionsNeedingBackup(limit) {
        const sessions = [];
        for (const session in this._sessionsNeedingBackup) {
            if (this._inboundGroupSessions[session]) {
                sessions.push({
                    senderKey: session.substr(0, 43),
                    sessionId: session.substr(44),
                    sessionData: this._inboundGroupSessions[session],
                });
                if (limit && session.length >= limit) {
                    break;
                }
            }
        }
        return Promise.resolve(sessions);
    }

    unmarkSessionsNeedingBackup(sessions) {
        for (const session of sessions) {
            const sessionKey = session.senderKey + '/' + session.sessionId;
            delete this._sessionsNeedingBackup[sessionKey];
        }
        return Promise.resolve();
    }

    markSessionsNeedingBackup(sessions) {
        for (const session of sessions) {
            const sessionKey = session.senderKey + '/' + session.sessionId;
            this._sessionsNeedingBackup[sessionKey] = true;
        }
        return Promise.resolve();
    }

    // Session key backups

    doTxn(mode, stores, func) {
        return Promise.resolve(func(null));
    }
}
