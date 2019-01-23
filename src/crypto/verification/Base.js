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
     * @param {object} startEvent the m.key.verification.start event that
     * initiated this verification, if any
     *
     * @param {object} request the key verification request object related to
     * this verification, if any
     *
     * @param {object} parent parent verification for this verification, if any
     */
    constructor(baseApis, userId, deviceId, transactionId, startEvent, request, parent) {
        super();
        this._baseApis = baseApis;
        this.userId = userId;
        this.deviceId = deviceId;
        this.transactionId = transactionId;
        this.startEvent = startEvent;
        this.request = request;
        this._parent = parent;
        this._done = false;
        this._promise = null;
    }

    _sendToDevice(type, content) {
        if (this._done) {
            return Promise.reject(new Error("Verification is already done"));
        }
        content.transaction_id = this.transactionId;
        return this._baseApis.sendToDevice(type, {
            [this.userId]: { [this.deviceId]: content },
        });
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
            this._resolveEvent(e);
        } else {
            this._expectedEvent = undefined;
            const exception = new Error(
                "Unexpected message: expecting " + this._expectedEvent
                    + " but got " + e.getType(),
            );
            if (this._rejectEvent) {
                const reject = this._rejectEvent;
                this._rejectEvent = undefined;
                reject(exception);
            }
            this.cancel(exception);
        }
    }

    done() {
        if (!this._done) {
            this._resolve();
        }
    }

    cancel(e) {
        if (!this._done) {
            if (this.userId && this.deviceId && this.transactionId) {
                // send a cancellation to the other user (if it wasn't
                // cancelled by the other user)
                if (e instanceof MatrixEvent) {
                    const sender = e.getSender();
                    if (sender !== this.userId) {
                        const content = e.getContent();
                        if (e.getType() === "m.key.verification.cancel") {
                            content.code = content.code || "m.unknown";
                            content.reason = content.reason || content.body
                                || "Unknown reason";
                            content.transaction_id = this.transactionId;
                            this._sendToDevice("m.key.verification.cancel", content);
                        } else {
                            this._sendToDevice("m.key.verification.cancel", {
                                code: "m.unknown",
                                reason: content.body || "Unknown reason",
                                transaction_id: this.transactionId,
                            });
                        }
                    }
                } else {
                    this._sendToDevice("m.key.verification.cancel", {
                        code: "m.unknown",
                        reason: e.toString(),
                        transaction_id: this.transactionId,
                    });
                }
            }
            if (this._promise !== null) {
                this._reject(e);
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
                resolve(...args);
            };
            this._reject = (...args) => {
                this._done = true;
                reject(...args);
            };
        });
        if (this._doVerification && !this._started) {
            this._started = true;
            Promise.resolve(this._doVerification())
                .then(this.done.bind(this), this.cancel.bind(this));
        }
        return this._promise;
    }

    async _verifyKeys(userId, keys, verifier) {
        for (const [keyId, keyInfo] of Object.entries(keys)) {
            const deviceId = keyId.split(':', 2)[1];
            const device = await this._baseApis.getStoredDevice(userId, deviceId);
            if (!device) {
                throw new Error(`Could not find device ${deviceId}`);
            } else {
                await verifier(keyId, device, keyInfo);
            }
        }
        for (const keyId of Object.keys(keys)) {
            const deviceId = keyId.split(':', 2)[1];
            await this._baseApis.setDeviceVerified(userId, deviceId);
        }
    }
}
