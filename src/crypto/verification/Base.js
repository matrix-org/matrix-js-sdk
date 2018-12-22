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
 * @module crypto/verification/Base
 *
 * Base class for verification methods.
 */

import {EventEmitter} from 'events';

export default class VerificationBase extends EventEmitter {
    /**
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
        this._eventHandlers = {};
        this._done = false;
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
    }

    _sendToDevice(type, content) {
        content.transaction_id = this.transactionId;
        return this._baseApis.sendToDevice(type, {
            [this.userId]: { [this.deviceId]: content },
        });
    }

    _expectEvents(map) {
        this._eventHandlers = map || {};
    }

    /** Wrapper around _expectEvents, for when only one event type is expected
     */
    _expectEvent(type, handler) {
        return this._expectEvents({[type]: handler});
    }

    handleEvent(e) {
        const handler = this._eventHandlers[e.getType()];
        if (!handler) {
            this._eventHandlers = {};
            return this.cancel(new Error("Unexpected message"));
        }
        return handler.call(this, e);
    }

    done() {
        if (!this._done) {
            this._resolve();
        }
    }

    cancel(e) {
        if (!this._done) {
            this._reject(e);
        }
    }

    verify() {
        return this._promise;
    }
}
