/*
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

/**
 * Base class for verification methods.
 * @module crypto/verification/Base
 */

import {MatrixEvent} from '../../models/event';
import {EventEmitter} from 'events';
import logger from '../../logger';
import {newTimeoutError} from "./Error";

const timeoutException = new Error("Verification timed out");

export default class VerificationBase extends EventEmitter {
    /**
     * Base class for verification methods.
     *
     * <p>Once a verifier object is created, the verification can be started by
     * calling the verify() method, which will return a promise that will
     * resolve when the verification is completed, or reject if it could not
     * complete.</p>
     *
     * <p>Subclasses must have a NAME class property.</p>
     *
     * @class
     *
     * @param {module:base-apis~MatrixBaseApis} baseApis base matrix api interface
     *
     * @param {string} userId the user ID that is being verified
     *
     * @param {string} deviceId the device ID that is being verified
     *
     * @param {string} transactionId the transaction ID to be used when sending events
     *
     * @param {string} [roomId] the room to use for verification
     *
     * @param {object} [startEvent] the m.key.verification.start event that
     * initiated this verification, if any
     *
     * @param {object} [request] the key verification request object related to
     * this verification, if any
     */
    constructor(baseApis, userId, deviceId, transactionId, roomId, startEvent, request) {
        super();
        this._baseApis = baseApis;
        this.userId = userId;
        this.deviceId = deviceId;
        this.transactionId = transactionId;
        if (typeof(roomId) === "string" || roomId instanceof String) {
            this.roomId = roomId;
            this.startEvent = startEvent;
            this.request = request;
        } else {
            // if room ID was omitted, but start event and request were not
            this.startEvent= roomId;
            this.request = startEvent;
        }
        this.cancelled = false;
        this._done = false;
        this._promise = null;
        this._transactionTimeoutTimer = null;

        // At this point, the verification request was received so start the timeout timer.
        this._resetTimer();

        if (this.roomId) {
            this._send = this._sendMessage;
        } else {
            this._send = this._sendToDevice;
        }
    }

    _resetTimer() {
        logger.info("Refreshing/starting the verification transaction timeout timer");
        if (this._transactionTimeoutTimer !== null) {
            clearTimeout(this._transactionTimeoutTimer);
        }
        this._transactionTimeoutTimer = setTimeout(() => {
            if (!this._done && !this.cancelled) {
                logger.info("Triggering verification timeout");
                this.cancel(timeoutException);
            }
        }, 10 * 60 * 1000); // 10 minutes
    }

    _endTimer() {
        if (this._transactionTimeoutTimer !== null) {
            clearTimeout(this._transactionTimeoutTimer);
            this._transactionTimeoutTimer = null;
        }
    }

    /* send a message to the other participant, using to-device messages
     */
    _sendToDevice(type, content) {
        if (this._done) {
            return Promise.reject(new Error("Verification is already done"));
        }
        content.transaction_id = this.transactionId;
        return this._baseApis.sendToDevice(type, {
            [this.userId]: { [this.deviceId]: content },
        });
    }

    /* send a message to the other participant, using in-roomm messages
     */
    _sendMessage(type, content) {
        if (this._done) {
            return Promise.reject(new Error("Verification is already done"));
        }
        // FIXME: if MSC1849 decides to use m.relationship instead of
        // m.relates_to, we should follow suit here
        content["m.relates_to"] = {
            rel_type: "m.reference",
            event_id: this.transactionId,
        };
        return this._baseApis.sendEvent(this.roomId, type, content);
    }

    _waitForEvent(type) {
        if (this._done) {
            return Promise.reject(new Error("Verification is already done"));
        }
        this._expectedEvent = type;
        return new Promise((resolve, reject) => {
            this._resolveEvent = resolve;
            this._rejectEvent = reject;
        });
    }

    handleEvent(e) {
        if (this._done) {
            return;
        } else if (e.getType() === this._expectedEvent) {
            this._expectedEvent = undefined;
            this._rejectEvent = undefined;
            this._resetTimer();
            this._resolveEvent(e);
        } else if (e.getType() === "m.key.verification.cancel") {
            const reject = this._reject;
            this._reject = undefined;
            reject(new Error("Other side cancelled verification"));
        } else {
            const exception = new Error(
                "Unexpected message: expecting " + this._expectedEvent
                    + " but got " + e.getType(),
            );
            this._expectedEvent = undefined;
            if (this._rejectEvent) {
                const reject = this._rejectEvent;
                this._rejectEvent = undefined;
                reject(exception);
            }
            this.cancel(exception);
        }
    }

    done() {
        this._endTimer(); // always kill the activity timer
        if (!this._done) {
            if (this.roomId) {
                // verification in DM requires a done message
                this._send("m.key.verification.done", {});
            }
            this._resolve();
        }
    }

    cancel(e) {
        this._endTimer(); // always kill the activity timer
        if (!this._done) {
            this.cancelled = true;
            if (this.userId && this.deviceId && this.transactionId) {
                // send a cancellation to the other user (if it wasn't
                // cancelled by the other user)
                if (e === timeoutException) {
                    const timeoutEvent = newTimeoutError();
                    this._send(timeoutEvent.getType(), timeoutEvent.getContent());
                } else if (e instanceof MatrixEvent) {
                    const sender = e.getSender();
                    if (sender !== this.userId) {
                        const content = e.getContent();
                        if (e.getType() === "m.key.verification.cancel") {
                            content.code = content.code || "m.unknown";
                            content.reason = content.reason || content.body
                                || "Unknown reason";
                            content.transaction_id = this.transactionId;
                            this._send("m.key.verification.cancel", content);
                        } else {
                            this._send("m.key.verification.cancel", {
                                code: "m.unknown",
                                reason: content.body || "Unknown reason",
                                transaction_id: this.transactionId,
                            });
                        }
                    }
                } else {
                    this._send("m.key.verification.cancel", {
                        code: "m.unknown",
                        reason: e.toString(),
                        transaction_id: this.transactionId,
                    });
                }
            }
            if (this._promise !== null) {
                // when we cancel without a promise, we end up with a promise
                // but no reject function. If cancel is called again, we'd error.
                if (this._reject) this._reject(e);
            } else {
                this._promise = Promise.reject(e);
            }
            // Also emit a 'cancel' event that the app can listen for to detect cancellation
            // before calling verify()
            this.emit('cancel', e);
        }
    }

    /**
     * Begin the key verification
     *
     * @returns {Promise} Promise which resolves when the verification has
     *     completed.
     */
    verify() {
        if (this._promise) return this._promise;

        this._promise = new Promise((resolve, reject) => {
            this._resolve = (...args) => {
                this._done = true;
                this._endTimer();
                if (this.handler) {
                    this._baseApis.off("event", this.handler);
                }
                resolve(...args);
            };
            this._reject = (...args) => {
                this._done = true;
                this._endTimer();
                if (this.handler) {
                    this._baseApis.off("event", this.handler);
                }
                reject(...args);
            };
        });
        if (this._doVerification && !this._started) {
            this._started = true;
            this._resetTimer(); // restart the timeout
            Promise.resolve(this._doVerification())
                .then(this.done.bind(this), this.cancel.bind(this));
        }
        return this._promise;
    }

    async _verifyKeys(userId, keys, verifier) {
        // we try to verify all the keys that we're told about, but we might
        // not know about all of them, so keep track of the keys that we know
        // about, and ignore the rest
        const verifiedDevices = [];

        for (const [keyId, keyInfo] of Object.entries(keys)) {
            const deviceId = keyId.split(':', 2)[1];
            const device = await this._baseApis.getStoredDevice(userId, deviceId);
            if (!device) {
                logger.warn(`verification: Could not find device ${deviceId} to verify`);
            } else {
                await verifier(keyId, device, keyInfo);
                verifiedDevices.push(deviceId);
            }
        }

        // if none of the keys could be verified, then error because the app
        // should be informed about that
        if (!verifiedDevices.length) {
            throw new Error("No devices could be verified");
        }

        for (const deviceId of verifiedDevices) {
            await this._baseApis.setDeviceVerified(userId, deviceId);
        }
    }
}
