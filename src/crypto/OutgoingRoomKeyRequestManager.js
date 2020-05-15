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

import {logger} from '../logger';
import * as utils from '../utils';

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
export const ROOM_KEY_REQUEST_STATES = {
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

export class OutgoingRoomKeyRequestManager {
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
     * Send any requests that have been queued
     */
    sendQueuedRequests() {
        this._startTimer();
    }

    /**
     * Queue up a room key request, if we haven't already queued or sent one.
     *
     * The `requestBody` is compared (with a deep-equality check) against
     * previous queued or sent requests and if it matches, no change is made.
     * Otherwise, a request is added to the pending list, and a job is started
     * in the background to send it.
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     * @param {Array<{userId: string, deviceId: string}>} recipients
     * @param {boolean} resend whether to resend the key request if there is
     *    already one
     *
     * @returns {Promise} resolves when the request has been added to the
     *    pending list (or we have established that a similar request already
     *    exists)
     */
    async queueRoomKeyRequest(requestBody, recipients, resend=false) {
        const req = await this._cryptoStore.getOutgoingRoomKeyRequest(
            requestBody,
        );
        if (!req) {
            await this._cryptoStore.getOrAddOutgoingRoomKeyRequest({
                requestBody: requestBody,
                recipients: recipients,
                requestId: this._baseApis.makeTxnId(),
                state: ROOM_KEY_REQUEST_STATES.UNSENT,
            });
        } else {
            switch (req.state) {
            case ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND:
            case ROOM_KEY_REQUEST_STATES.UNSENT:
                // nothing to do here, since we're going to send a request anyways
                return;

            case ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING: {
                // existing request is about to be cancelled.  If we want to
                // resend, then change the state so that it resends after
                // cancelling.  Otherwise, just cancel the cancellation.
                const state = resend ?
                    ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND :
                    ROOM_KEY_REQUEST_STATES.SENT;
                await this._cryptoStore.updateOutgoingRoomKeyRequest(
                    req.requestId, ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING, {
                        state,
                        cancellationTxnId: this._baseApis.makeTxnId(),
                    },
                );
                break;
            }
            case ROOM_KEY_REQUEST_STATES.SENT: {
                // a request has already been sent.  If we don't want to
                // resend, then do nothing.  If we do want to, then cancel the
                // existing request and send a new one.
                if (resend) {
                    const state =
                          ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND;
                    const updatedReq =
                          await this._cryptoStore.updateOutgoingRoomKeyRequest(
                              req.requestId, ROOM_KEY_REQUEST_STATES.SENT, {
                                  state,
                                  cancellationTxnId: this._baseApis.makeTxnId(),
                                  // need to use a new transaction ID so that
                                  // the request gets sent
                                  requestTxnId: this._baseApis.makeTxnId(),
                              },
                          );
                    if (!updatedReq) {
                        // updateOutgoingRoomKeyRequest couldn't find the request
                        // in state ROOM_KEY_REQUEST_STATES.SENT, so we must have
                        // raced with another tab to mark the request cancelled.
                        // Try again, to make sure the request is resent.
                        return await this.queueRoomKeyRequest(
                            requestBody, recipients, resend,
                        );
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
                    try {
                        await this._sendOutgoingRoomKeyRequestCancellation(
                            updatedReq,
                            true,
                        );
                    } catch (e) {
                        logger.error(
                            "Error sending room key request cancellation;"
                                + " will retry later.", e,
                        );
                    }
                    // The request has transitioned from
                    // CANCELLATION_PENDING_AND_WILL_RESEND to UNSENT. We
                    // still need to resend the request which is now UNSENT, so
                    // start the timer if it isn't already started.
                }
                break;
            }
            default:
                throw new Error('unhandled state: ' + req.state);
            }
        }
    }

    /**
     * Cancel room key requests, if any match the given requestBody
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *
     * @returns {Promise} resolves when the request has been updated in our
     *    pending list.
     */
    cancelRoomKeyRequest(requestBody) {
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
                    // send a cancellation.
                    return this._cryptoStore.updateOutgoingRoomKeyRequest(
                        req.requestId, ROOM_KEY_REQUEST_STATES.SENT, {
                            state: ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING,
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
                        ).catch((e) => {
                            logger.error(
                                "Error sending room key request cancellation;"
                                + " will retry later.", e,
                            );
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

    /**
     * Find anything in `sent` state, and kick it around the loop again.
     * This is intended for situations where something substantial has changed, and we
     * don't really expect the other end to even care about the cancellation.
     * For example, after initialization or self-verification.
     * @return {Promise} An array of `queueRoomKeyRequest` outputs.
     */
    async cancelAndResendAllOutgoingRequests() {
        const outgoings = await this._cryptoStore.getAllOutgoingRoomKeyRequestsByState(
            ROOM_KEY_REQUEST_STATES.SENT,
        );
        return Promise.all(outgoings.map(({ requestBody, recipients }) =>
            this.queueRoomKeyRequest(requestBody, recipients, true)));
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
            });
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

        return this._cryptoStore.getOutgoingRoomKeyRequestByState([
            ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING,
            ROOM_KEY_REQUEST_STATES.CANCELLATION_PENDING_AND_WILL_RESEND,
            ROOM_KEY_REQUEST_STATES.UNSENT,
        ]).then((req) => {
            if (!req) {
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
            });
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
            requestMessage, req.recipients, req.requestTxnId || req.requestId,
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

