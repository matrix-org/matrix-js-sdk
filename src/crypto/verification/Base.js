/*
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

/**
 * Base class for verification methods.
 * @module crypto/verification/Base
 */

import {MatrixEvent} from '../../models/event';
import {EventEmitter} from 'events';
import {logger} from '../../logger';
import {DeviceInfo} from '../deviceinfo';
import {newTimeoutError} from "./Error";
import {requestKeysDuringVerification} from "../CrossSigning";

const timeoutException = new Error("Verification timed out");

export class SwitchStartEventError extends Error {
    constructor(startEvent) {
        super();
        this.startEvent = startEvent;
    }
}

export class VerificationBase extends EventEmitter {
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
     * @param {module:base-apis~Channel} channel the verification channel to send verification messages over.
     *
     * @param {module:base-apis~MatrixBaseApis} baseApis base matrix api interface
     *
     * @param {string} userId the user ID that is being verified
     *
     * @param {string} deviceId the device ID that is being verified
     *
     * @param {object} [startEvent] the m.key.verification.start event that
     * initiated this verification, if any
     *
     * @param {object} [request] the key verification request object related to
     * this verification, if any
     */
    constructor(channel, baseApis, userId, deviceId, startEvent, request) {
        super();
        this._channel = channel;
        this._baseApis = baseApis;
        this.userId = userId;
        this.deviceId = deviceId;
        this.startEvent = startEvent;
        this.request = request;

        this.cancelled = false;
        this._done = false;
        this._promise = null;
        this._transactionTimeoutTimer = null;
    }

    get initiatedByMe() {
        // if there is no start event yet,
        // we probably want to send it,
        // which happens if we initiate
        if (!this.startEvent) {
            return true;
        }
        const sender = this.startEvent.getSender();
        const content = this.startEvent.getContent();
        return sender === this._baseApis.getUserId() &&
            content.from_device === this._baseApis.getDeviceId();
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

    _send(type, uncompletedContent) {
        return this._channel.send(type, uncompletedContent);
    }

    _waitForEvent(type) {
        if (this._done) {
            return Promise.reject(new Error("Verification is already done"));
        }
        const existingEvent = this.request.getEventFromOtherParty(type);
        if (existingEvent) {
            return Promise.resolve(existingEvent);
        }

        this._expectedEvent = type;
        return new Promise((resolve, reject) => {
            this._resolveEvent = resolve;
            this._rejectEvent = reject;
        });
    }

    canSwitchStartEvent() {
        return false;
    }

    switchStartEvent(event) {
        if (this.canSwitchStartEvent(event)) {
            logger.log("Verification Base: switching verification start event",
                {restartingFlow: !!this._rejectEvent});
            if (this._rejectEvent) {
                const reject = this._rejectEvent;
                this._rejectEvent = undefined;
                reject(new SwitchStartEventError(event));
            } else {
                this.startEvent = event;
            }
        }
    }

    handleEvent(e) {
        if (this._done) {
            return;
        } else if (e.getType() === this._expectedEvent) {
            // if we receive an expected m.key.verification.done, then just
            // ignore it, since we don't need to do anything about it
            if (this._expectedEvent !== "m.key.verification.done") {
                this._expectedEvent = undefined;
                this._rejectEvent = undefined;
                this._resetTimer();
                this._resolveEvent(e);
            }
        } else if (e.getType() === "m.key.verification.cancel") {
            const reject = this._reject;
            this._reject = undefined;
            // there is only promise to reject if verify has been called
            if (reject) {
                const content = e.getContent();
                const {reason, code} = content;
                reject(new Error(`Other side cancelled verification ` +
                    `because ${reason} (${code})`));
            }
        } else if (this._expectedEvent) {
            // only cancel if there is an event expected.
            // if there is no event expected, it means verify() wasn't called
            // and we're just replaying the timeline events when syncing
            // after a refresh when the events haven't been stored in the cache yet.
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
            this.request.onVerifierFinished();
            this._resolve();
            return requestKeysDuringVerification(this._baseApis, this.userId, this.deviceId);
        }
    }

    cancel(e) {
        this._endTimer(); // always kill the activity timer
        if (!this._done) {
            this.cancelled = true;
            this.request.onVerifierCancelled();
            if (this.userId && this.deviceId) {
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
                            this._send("m.key.verification.cancel", content);
                        } else {
                            this._send("m.key.verification.cancel", {
                                code: "m.unknown",
                                reason: content.body || "Unknown reason",
                            });
                        }
                    }
                } else {
                    this._send("m.key.verification.cancel", {
                        code: "m.unknown",
                        reason: e.toString(),
                    });
                }
            }
            if (this._promise !== null) {
                // when we cancel without a promise, we end up with a promise
                // but no reject function. If cancel is called again, we'd error.
                if (this._reject) this._reject(e);
            } else {
                // FIXME: this causes an "Uncaught promise" console message
                // if nothing ends up chaining this promise.
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
                resolve(...args);
            };
            this._reject = (...args) => {
                this._done = true;
                this._endTimer();
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
            const device = this._baseApis.getStoredDevice(userId, deviceId);
            if (device) {
                await verifier(keyId, device, keyInfo);
                verifiedDevices.push(deviceId);
            } else {
                const crossSigningInfo = this._baseApis._crypto._deviceList
                      .getStoredCrossSigningForUser(userId);
                if (crossSigningInfo && crossSigningInfo.getId() === deviceId) {
                    await verifier(keyId, DeviceInfo.fromStorage({
                        keys: {
                            [keyId]: deviceId,
                        },
                    }, deviceId), keyInfo);
                    verifiedDevices.push(deviceId);
                } else {
                    logger.warn(
                        `verification: Could not find device ${deviceId} to verify`,
                    );
                }
            }
        }

        // if none of the keys could be verified, then error because the app
        // should be informed about that
        if (!verifiedDevices.length) {
            throw new Error("No devices could be verified");
        }

        logger.info(
            "Verification completed! Marking devices verified: ",
            verifiedDevices,
        );
        // TODO: There should probably be a batch version of this, otherwise it's going
        // to upload each signature in a separate API call which is silly because the
        // API supports as many signatures as you like.
        for (const deviceId of verifiedDevices) {
            await this._baseApis.setDeviceVerified(userId, deviceId);
        }
    }
}
