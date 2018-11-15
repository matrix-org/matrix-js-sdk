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

import Promise from 'bluebird';

import logger from '../logger';
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
 * The state machine looks like:
 *
 *     |         (cancellation sent)
 *     | .-------------------------------------------------.
 *     | |                                                 |
 *     V V       (cancellation requested)                  |
 *   UNSENT  -----------------------------+                |
 *     |                                  |                |
 *     |                                  |                |
 *     | (send successful)                |  CANCELLATION_PENDING_AND_WILL_RESEND
 *     V                                  |                Λ
 *    SENT                                |                |
 *     |--------------------------------  |  --------------'
 *     |                                  |  (cancellation requested with intent
 *     |                                  |   to resend the original request)
 *     |                                  |
 *     | (cancellation requested)         |
 *     V                                  |
 * CANCELLATION_PENDING                   |
 *     |                                  |
 *     | (cancellation sent)              |
 *     V                                  |
 * (deleted)  <---------------------------+
 *
 * @enum {number}
 */
const ROOM_KEY_REQUEST_STATES = {
    /** request not yet sent */
    UNSENT: 0,

    /** request sent, awaiting reply */
    SENT: 1,

    /** reply received, cancellation not yet sent */
    CANCELLATION_PENDING: 2,

    /**
     * Cancellation not yet sent and will transition to UNSENT instead of
     * being deleted once the cancellation has been sent.
     */
    CANCELLATION_PENDING_AND_WILL_RESEND: 3,
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
        logger.log('stopping OutgoingRoomKeyRequestManager');
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

    /**
     * Cancel room key requests, if any match the given requestBody
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     * @param {boolean} andResend if true, transition to UNSENT instead of
     *                            deleting after sending cancellation.
     *
     * @returns {Promise} resolves when the request has been updated in our
     *    pending list.
     */
    cancelRoomKeyRequest(requestBody, andResend=false) {
        return this._cryptoStore.getOutgoingRoomKeyRequest(
            requestBody,
        ).then((req) => {
            if (!req) {
                // no request was made for this key
                return;
            }
            switch (req.state) {
                case ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING:
                case ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND:
                    // nothing to do here
                    return;

                case ROOM_KEY_REQUEST_STATES.UNSENT:
                    // just delete it

                    // FIXME: ghahah we may have attempted to send it, and
                    // not yet got a successful response. So the server
                    // may have seen it, so we still need to send a cancellation
                    // in that case :/

                    logger.log(
                        'deleting unnecessary room key request for ' +
                        stringifyRequestBody(requestBody),
                    );
                    return this._cryptoStore.deleteOutgoingRoomKeyRequest(
                        req.requestId, ROOM_KEY_REQUEST_STATES.UNSENT,
                    );

                case ROOM_KEY_REQUEST_STATES.SENT: {
                    // If `andResend` is set, transition to UNSENT once the
                    // cancellation has successfully been sent.
                    const state = andResend ?
                        ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND :
                        ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING;
                    // send a cancellation.
                    return this._cryptoStore.updateOutgoingRoomKeyRequest(
                        req.requestId, ROOM_KEY_REQUEST_STATES.SENT, {
                            state,
                            cancellationTxnId: this._baseApis.makeTxnId(),
                        },
                    ).then((updatedReq) => {
                        if (!updatedReq) {
                            // updateOutgoingRoomKeyRequest couldn't find the
                            // request in state ROOM_KEY_REQUEST_STATES.SENT,
                            // so we must have raced with another tab to mark
                            // the request cancelled. There is no point in
                            // sending another cancellation since the other tab
                            // will do it.
                            logger.log(
                                'Tried to cancel room key request for ' +
                                stringifyRequestBody(requestBody) +
                                ' but it was already cancelled in another tab',
                            );
                            return;
                        }

                        // We don't want to wait for the timer, so we send it
                        // immediately. (We might actually end up racing with the timer,
                        // but that's ok: even if we make the request twice, we'll do it
                        // with the same transaction_id, so only one message will get
                        // sent).
                        //
                        // (We also don't want to wait for the response from the server
                        // here, as it will slow down processing of received keys if we
                        // do.)
                        this._sendOutgoingRoomKeyRequestCancellation(
                            updatedReq,
                            andResend,
                        ).catch((e) => {
                            logger.error(
                                "Error sending room key request cancellation;"
                                + " will retry later.", e,
                            );
                            this._startTimer();
                        }).then(() => {
                            if (!andResend) return;
                            // The request has transitioned from
                            // CANCELLATION_PENDING_AND_WILL_RESEND to UNSENT. We
                            // still need to resend the request which is now UNSENT, so
                            // start the timer if it isn't already started.
                            this._startTimer();
                        });
                    });
                }
                default:
                    throw new Error('unhandled state: ' + req.state);
            }
        });
    }

    /**
     * Look for room key requests by target device and state
     *
     * @param {string} userId Target user ID
     * @param {string} deviceId Target device ID
     *
     * @return {Promise} resolves to a list of all the
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
     */
    getOutgoingSentRoomKeyRequest(userId, deviceId) {
        return this._cryptoStore.getOutgoingRoomKeyRequestsByTarget(
            userId, deviceId, [ROOM_KEY_REQUEST_STATES.SENT],
        );
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
            }).catch((e) => {
                // this should only happen if there is an indexeddb error,
                // in which case we're a bit stuffed anyway.
                logger.warn(
                    `error in OutgoingRoomKeyRequestManager: ${e}`,
                );
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
            return Promise.resolve();
        }

        logger.log("Looking for queued outgoing room key requests");

        return this._cryptoStore.getOutgoingRoomKeyRequestByState([
            ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING,
            ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND,
            ROOM_KEY_REQUEST_STATES.UNSENT,
        ]).then((req) => {
            if (!req) {
                logger.log("No more outgoing room key requests");
                this._sendOutgoingRoomKeyRequestsTimer = null;
                return;
            }

            let prom;
            switch (req.state) {
                case ROOM_KEY_REQUEST_STATES.UNSENT:
                    prom = this._sendOutgoingRoomKeyRequest(req);
                    break;
                case ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING:
                    prom = this._sendOutgoingRoomKeyRequestCancellation(req);
                    break;
                case ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND:
                    prom = this._sendOutgoingRoomKeyRequestCancellation(req, true);
                    break;
            }

            return prom.then(() => {
                // go around the loop again
                return this._sendOutgoingRoomKeyRequests();
            }).catch((e) => {
                logger.error("Error sending room key request; will retry later.", e);
                this._sendOutgoingRoomKeyRequestsTimer = null;
                this._startTimer();
            }).done();
        });
    }

    // given a RoomKeyRequest, send it and update the request record
    _sendOutgoingRoomKeyRequest(req) {
        logger.log(
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

    // Given a RoomKeyRequest, cancel it and delete the request record unless
    // andResend is set, in which case transition to UNSENT.
    _sendOutgoingRoomKeyRequestCancellation(req, andResend) {
        logger.log(
            `Sending cancellation for key request for ` +
            `${stringifyRequestBody(req.requestBody)} to ` +
            `${stringifyRecipientList(req.recipients)} ` +
            `(cancellation id ${req.cancellationTxnId})`,
        );

        const requestMessage = {
            action: "request_cancellation",
            requesting_device_id: this._deviceId,
            request_id: req.requestId,
        };

        return this._sendMessageToDevices(
            requestMessage, req.recipients, req.cancellationTxnId,
        ).then(() => {
            if (andResend) {
                // We want to resend, so transition to UNSENT
                return this._cryptoStore.updateOutgoingRoomKeyRequest(
                    req.requestId,
                    ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND,
                    { state: ROOM_KEY_REQUEST_STATES.UNSENT },
                );
            }
            return this._cryptoStore.deleteOutgoingRoomKeyRequest(
                req.requestId, ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING,
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

