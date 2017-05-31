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

import utils from '../utils';

/**
 * Internal module. Management of outgoing room key requests.
 *
 * See https://docs.google.com/document/d/1m4gQkcnJkxNuBmb5NoFCIadIY-DyqqNAS3lloE73BlQ
 * for draft documentation on what we're supposed to be implementing here.
 *
 * @module
 */

// delay between deciding we want some keys, and sending out the request, to
// allow for (a) it turning up anyway, (b) grouping requests together
const SEND_KEY_REQUESTS_DELAY_MS = 500;

/** possible states for a room key request
 *
 * @enum {number}
 */
const ROOM_KEY_REQUEST_STATES = {
    /** request not yet sent */
    UNSENT: 0,

    /** request sent, awaiting reply */
    SENT: 1,
};

export default class OutgoingRoomKeyRequestManager {
    constructor(baseApis, deviceId, cryptoStore) {
        this._baseApis = baseApis;
        this._deviceId = deviceId;
        this._cryptoStore = cryptoStore;

        // handle for the delayed call to _sendOutgoingRoomKeyRequests. Non-null
        // if the callback has been set, or if it is still running.
        this._sendOutgoingRoomKeyRequestsTimer = null;

        // sanity check to ensure that we don't end up with two concurrent runs
        // of _sendOutgoingRoomKeyRequests
        this._sendOutgoingRoomKeyRequestsRunning = false;

        this._clientRunning = false;
    }

    /**
     * Called when the client is started. Sets background processes running.
     */
    start() {
        this._clientRunning = true;

        // set the timer going, to handle any requests which didn't get sent
        // on the previous run of the client.
        this._startTimer();
    }

    /**
     * Called when the client is stopped. Stops any running background processes.
     */
    stop() {
        // stop the timer on the next run
        this._clientRunning = false;
    }

    /**
     * Send off a room key request, if we haven't already done so.
     *
     * The `requestBody` is compared (with a deep-equality check) against
     * previous queued or sent requests and if it matches, no change is made.
     * Otherwise, a request is added to the pending list, and a job is started
     * in the background to send it.
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     * @param {Array<{userId: string, deviceId: string}>} recipients
     *
     * @returns {Promise} resolves when the request has been added to the
     *    pending list (or we have established that a similar request already
     *    exists)
     */
    sendRoomKeyRequest(requestBody, recipients) {
        return this._cryptoStore.getOrAddOutgoingRoomKeyRequest({
            requestBody: requestBody,
            recipients: recipients,
            requestId: this._baseApis.makeTxnId(),
            state: ROOM_KEY_REQUEST_STATES.UNSENT,
        }).then((req) => {
            if (req.state === ROOM_KEY_REQUEST_STATES.UNSENT) {
                this._startTimer();
            }
        });
    }

    // start the background timer to send queued requests, if the timer isn't
    // already running
    _startTimer() {
        if (this._sendOutgoingRoomKeyRequestsTimer) {
            return;
        }

        const startSendingOutgoingRoomKeyRequests = () => {
            if (this._sendOutgoingRoomKeyRequestsRunning) {
                throw new Error("RoomKeyRequestSend already in progress!");
            }
            this._sendOutgoingRoomKeyRequestsRunning = true;

            this._sendOutgoingRoomKeyRequests().finally(() => {
                this._sendOutgoingRoomKeyRequestsRunning = false;
            }).done();
        };

        this._sendOutgoingRoomKeyRequestsTimer = global.setTimeout(
            startSendingOutgoingRoomKeyRequests,
            SEND_KEY_REQUESTS_DELAY_MS,
        );
    }

    // look for and send any queued requests. Runs itself recursively until
    // there are no more requests, or there is an error (in which case, the
    // timer will be restarted before the promise resolves).
    _sendOutgoingRoomKeyRequests() {
        if (!this._clientRunning) {
            this._sendOutgoingRoomKeyRequestsTimer = null;
            return q();
        }

        console.log("Looking for queued outgoing room key requests");

        return this._cryptoStore.getOutgoingRoomKeyRequestByState([
            ROOM_KEY_REQUEST_STATES.UNSENT,
        ]).then((req) => {
            if (!req) {
                console.log("No more outgoing room key requests");
                this._sendOutgoingRoomKeyRequestsTimer = null;
                return;
            }

            return this._sendOutgoingRoomKeyRequest(req).then(() => {
                // go around the loop again
                return this._sendOutgoingRoomKeyRequests();
            }).catch((e) => {
                console.error("Error sending room key request; will retry later.", e);
                this._sendOutgoingRoomKeyRequestsTimer = null;
                this._startTimer();
            }).done();
        });
    }

    // given a RoomKeyRequest, send it and update the request record
    _sendOutgoingRoomKeyRequest(req) {
        console.log(
            `Requesting keys for ${stringifyRequestBody(req.requestBody)}` +
            ` from ${stringifyRecipientList(req.recipients)}` +
            `(id ${req.requestId})`,
        );

        const requestMessage = {
            action: "request",
            requesting_device_id: this._deviceId,
            request_id: req.requestId,
            body: req.requestBody,
        };

        return this._sendMessageToDevices(
            requestMessage, req.recipients, req.requestId,
        ).then(() => {
            return this._cryptoStore.updateOutgoingRoomKeyRequest(
                req.requestId, ROOM_KEY_REQUEST_STATES.UNSENT,
                { state: ROOM_KEY_REQUEST_STATES.SENT },
            );
        });
    }

    // send a RoomKeyRequest to a list of recipients
    _sendMessageToDevices(message, recipients, txnId) {
        const contentMap = {};
        for (const recip of recipients) {
            if (!contentMap[recip.userId]) {
                contentMap[recip.userId] = {};
            }
            contentMap[recip.userId][recip.deviceId] = message;
        }

        return this._baseApis.sendToDevice(
            'm.room_key_request', contentMap, txnId,
        );
    }
}

function stringifyRequestBody(requestBody) {
    // we assume that the request is for megolm keys, which are identified by
    // room id and session id
    return requestBody.room_id + " / " + requestBody.session_id;
}

function stringifyRecipientList(recipients) {
    return '['
        + utils.map(recipients, (r) => `${r.userId}:${r.deviceId}`).join(",")
        + ']';
}

