/*
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import logger from '../../../logger';
import ProxyMedium from "./ProxyMedium";
import {EventEmitter} from 'events';
import {
    newUnknownMethodError,
    newUnexpectedMessageError,
    errorFromEvent,
    errorFactory,
} from "../Error";

// the recommended amount of time before a verification request
// should be (automatically) cancelled without user interaction
// and ignored.
const VERIFICATION_REQUEST_TIMEOUT = 5 * 60 * 1000; //5m
// to avoid almost expired verification notifications
// from showing a notification and almost immediately
// disappearing, also ignore verification requests that
// are this amount of time away from expiring.
// const VERIFICATION_REQUEST_MARGIN = 3 * 1000; //3s


export const EVENT_PREFIX = "m.key.verification.";
export const REQUEST_TYPE = EVENT_PREFIX + "request";
export const START_TYPE = EVENT_PREFIX + "start";
export const CANCEL_TYPE = EVENT_PREFIX + "cancel";
export const DONE_TYPE = EVENT_PREFIX + "done";
// export const READY_TYPE = EVENT_PREFIX + "ready";

export const PHASE_UNSENT = 1;
export const PHASE_REQUESTED = 2;
// const PHASE_READY = 3;
export const PHASE_STARTED = 4;
export const PHASE_CANCELLED = 5;
export const PHASE_DONE = 6;

// also !validateEvent, if it happens on a .request, ignore, otherwise, cancel

export default class VerificationRequest extends EventEmitter {
    constructor(medium, verificationMethods, userId, client) {
        super();
        this.medium = medium;
        this._verificationMethods = verificationMethods;
        this._client = client;
        this._commonMethods = [];
        this._setPhase(PHASE_UNSENT, false);
        // .request event from other side, only set if this is the receiving end.
        this._requestEvent = null;
        this._otherUserId = userId;
        this._initiatedByMe = null;
    }

    static validateEvent(type, event, client) {
        const content = event.getContent();

        if (!type.startsWith(EVENT_PREFIX)) {
            console.log("VerificationRequest: invalid " + type + " event because wrong prefix");
            return false;
        }

        if (type === REQUEST_TYPE) {
            if (!Array.isArray(content.methods)) {
                console.log("VerificationRequest: invalid " + type + " event because methods");
                return false;
            }
        }
        if (type === REQUEST_TYPE || type === START_TYPE) {
            if (typeof content.from_device !== "string" ||
                content.from_device.length === 0
            ) {
                console.log("VerificationRequest: invalid " + type + " event because from_device");
                return false;
            }
        }
        return true;
    }

    get methods() {
        return this._commonMethods;
    }

    get timeout() {
        return VERIFICATION_REQUEST_TIMEOUT;
    }

    get event() {
        return this._requestEvent;
    }

    get phase() {
        return this._phase;
    }

    get verifier() {
        return this._verifier;
    }

    get inProgress() {
        return this._phase !== PHASE_UNSENT
            && this._phase !== PHASE_DONE
            && this._phase !== PHASE_CANCELLED;
    }

    get initiatedByMe() {
        return this._initiatedByMe;
    }

    get requestingUserId() {
        if (this.initiatedByMe) {
            return this._client.getUserId();
        } else {
            return this._otherUserId;
        }
    }

    get receivingUserId() {
        if (this.initiatedByMe) {
            return this._otherUserId;
        } else {
            return this._client.getUserId();
        }
    }

    // @param deviceId only needed if there is no .request event
    beginKeyVerification(method, targetDevice = null) {
        // need to allow also when unsent in case of to_device
        if (!this._verifier) {
            if (this._hasValidPreStartPhase()) {
                // when called on a request that was initiated with .request event
                // check the method is supported by both sides
                if (this._commonMethods.length && !this._commonMethods.includes(method)) {
                    throw newUnknownMethodError();
                }
                this._verifier = this._createVerifier(method, null, targetDevice);
                if (!this._verifier) {
                    throw newUnknownMethodError();
                }
            }
        }
        return this._verifier;
    }

    async sendRequest() {
        if (this._phase === PHASE_UNSENT) {
            //TODO: add from_device here, as it is handled here as well?
            this._initiatedByMe = true;
            this._setPhase(PHASE_REQUESTED, false);
            const methods = [...this._verificationMethods.keys()];
            await this.medium.send(REQUEST_TYPE, {methods});
            this.emit("change");
        }
    }

    async cancel({reason = "User declined", code = "m.user"} = {}) {
        if (this._phase !== PHASE_CANCELLED) {
            if (this._verifier) {
                return this._verifier.cancel(errorFactory(code, reason));
            } else {
                this._setPhase(PHASE_CANCELLED, false);
                await this.medium.send(CANCEL_TYPE, {code, reason});
            }
            this.emit("change");
        }
    }

    waitForVerifier() {
        if (this.verifier) {
            return Promise.resolve(this.verifier);
        } else {
            return new Promise(resolve => {
                const checkVerifier = () => {
                    if (this.verifier) {
                        this.off("change", checkVerifier);
                        resolve(this.verifier);
                    }
                };
                this.on("change", checkVerifier);
            });
        }
    }

    _setPhase(phase, notify = true) {
        console.trace(`VerificationRequest: setting phase from ${this._phase} to ${phase}`);
        this._phase = phase;
        if (notify) {
            this.emit("change");
        }
    }

    handleEvent(type, event) {
        const content = event.getContent();
        if (type === REQUEST_TYPE) {
            this._handleRequest(content, event);
        } else if (type === START_TYPE) {
            this._handleStart(content, event);
        }

        if (this._verifier) {
            // TODO: how will the phase change here once the verifier sends .done?
            // maybe we shouldn't handle .done here?
            // but also, how will this class know about cancel?
            // wrap the medium?
            if (this._verifier.events
                && this._verifier.events.includes(type)) {
                this._verifier.handleEvent(event);
            }
        }

        if (type === CANCEL_TYPE) {
            this._handleCancel();
        } else if (type === DONE_TYPE) {
            this._handleDone();
        }
    }

    async _handleRequest(content, event) {
        if (this._phase === PHASE_UNSENT) {
            const otherMethods = content.methods;
            this._commonMethods = otherMethods.
                filter(m => this._verificationMethods.has(m));
            this._requestEvent = event;
            this._initiatedByMe = this._wasSentByMe(event);
            this._setPhase(PHASE_REQUESTED);
        } else {
            console.log("VerificationRequest: Ignoring flagged verification request from " +
                event.getSender());
            logger.warn("Ignoring flagged verification request from " +
                event.getSender());
            this.cancel(errorFromEvent(newUnexpectedMessageError()));
        }
    }

    _hasValidPreStartPhase() {
        return this._phase === PHASE_REQUESTED ||
            (
                this.medium.constructor.canCreateRequest(START_TYPE) &&
                this._phase === PHASE_UNSENT
            );
    }

    async _handleStart(content, event) {
        console.log("VerificationRequest: got a start back!!");
        if (this._hasValidPreStartPhase()) {
            const {method} = content;
            if (!this._verificationMethods.has(method)) {
                await this.cancel(errorFromEvent(newUnknownMethodError()));
            } else {
                // if not in requested phase
                if (this.phase === PHASE_UNSENT) {
                    this._initiatedByMe = this._wasSentByMe(event);
                }
                this._verifier = this._createVerifier(method, event);
                this._setPhase(PHASE_STARTED);
            }
        } else {
            console.log("VerificationRequest: currently in phase " + this._phase + ", not expecting a .start");
            // TODO: cancel?
        }
    }

    handleVerifierSend(type, content) {
        if (type === CANCEL_TYPE) {
            this._handleCancel();
        } else if (type === START_TYPE) {
            this._handleVerifierStart();
        }
    }

    _handleVerifierStart() {
        if (this._phase === PHASE_UNSENT || this._phase === PHASE_REQUESTED) {
            // if unsent, we're sending a (first) .start event and hence requesting the verification
            // in any other situation, the request was initiated by the other party.
            this._initiatedByMe = this.phase === PHASE_UNSENT;
            this._setPhase(PHASE_STARTED);
        }
    }

    // also called from verifier through ProxyMedium
    _handleCancel() {
        if (this._phase !== PHASE_CANCELLED) {
            this._setPhase(PHASE_CANCELLED);
        }
    }

    _handleDone() {
        if (this._phase === PHASE_STARTED) {
            this._setPhase(PHASE_DONE);
        }
    }


    _createVerifier(method, startEvent = null, targetDevice = null) {
        const startSentByMe = startEvent && this._wasSentByMe(startEvent);
        const {userId, deviceId} = this._getVerifierTarget(startEvent, targetDevice);

        const VerifierCtor = this._verificationMethods.get(method);
        if (!VerifierCtor) {
            return;
        }
        const proxyMedium = new ProxyMedium(this, this.medium);
        return new VerifierCtor(
            proxyMedium,
            this._client,
            userId,
            deviceId,
            startSentByMe ? null : startEvent,
        );
    }

    _getVerifierTarget(startEvent, targetDevice) {
        // creating a verifier for to_device before the .start event has been sent,
        // so the userId and deviceId are provided
        if (targetDevice) {
            console.log("VerificationRequest: _getVerifierTarget: choosing targetDevice");
            return targetDevice;
        } else {
            let targetEvent;
            if (startEvent && !this._wasSentByMe(startEvent)) {
                console.log("VerificationRequest: _getVerifierTarget: choosing startEvent");
                targetEvent = startEvent;
            } else if (this._requestEvent && !this._wasSentByMe(this._requestEvent)) {
                console.log("VerificationRequest: _getVerifierTarget: choosing this._requestEvent");
                targetEvent = this._requestEvent;
            } else {
                throw new Error(
                    "can't determine who the verifier should be targeted at. " +
                    "No .request or .start event and no targetDevice");
            }
            const userId = targetEvent.getSender();
            const content = targetEvent.getContent();
            const deviceId = content && content.from_device;
            return {userId, deviceId};
        }
    }

    // only for .request and .start
    _wasSentByMe(event) {
        if (event.getSender() !== this._client.getUserId()) {
            return false;
        }
        const content = event.getContent();
        if (!content || content.from_device !== this._client.getDeviceId()) {
            return false;
        }
        return true;
    }
}
