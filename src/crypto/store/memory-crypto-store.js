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
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} Promise which resolves when the store has been cleared.
     */
    deleteAllData() {
        return q();
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

        // first see if we already have an entry for this request.
        return this.getOutgoingRoomKeyRequest(requestBody).then((existing) => {
            if (existing) {
                // this entry matches the request - return it.
                console.log(
                    `already have key request outstanding for ` +
                    `${requestBody.room_id} / ${requestBody.session_id}: ` +
                    `not sending another`,
                );
                return existing;
            }

            // we got to the end of the list without finding a match
            // - add the new request.
            console.log(
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
        for (const existing of this._outgoingRoomKeyRequests) {
            if (utils.deepCompare(existing.requestBody, requestBody)) {
                return q(existing);
            }
        }
        return q(null);
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
                    return q(req);
                }
            }
        }
        return q(null);
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
                console.warn(
                    `Cannot update room key request from ${expectedState} ` +
                    `as it was already updated to ${req.state}`,
                );
                return q(null);
            }
            Object.assign(req, updates);
            return q(req);
        }

        return q(null);
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
                console.warn(
                    `Cannot delete room key request in state ${req.state} `
                    + `(expected ${expectedState})`,
                );
                return q(null);
            }

            this._outgoingRoomKeyRequests.splice(i, 1);
            return q(req);
        }

        return q(null);
    }
}
