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

export const PHASE_UNSENT = 1;
export const PHASE_REQUESTED = 2;
// const PHASE_ACCEPTED = 3;
export const PHASE_STARTED = 4;
export const PHASE_CANCELLED = 5;
export const PHASE_DONE = 6;

// also !validateEvent, if it happens on a .request, ignore, otherwise, cancel

export class VerificationRequest extends EventEmitter {
    constructor(medium, verificationMethods) {
        super();
        this.medium = medium;
        this._verificationMethods = verificationMethods;
        this._commonMethods = [];
        this._phase = PHASE_UNSENT;
        // .request event from other side, only set if this is the receiving end.
        this._requestEvent = null;
    }

    static validateEvent(type, event, client) {
        const content = event.getContent();

        if (!type.startsWith(EVENT_PREFIX)) {
            return false;
        }

        if (type === REQUEST_TYPE || type === START_TYPE) {
            if (!Array.isArray(content.methods)) {
                return false;
            }
            if (typeof content.from_device !== "string" ||
                content.from_device.length === 0
            ) {
                return false;
            }
            if (event.getSender() === client.getUserId() &&
                    content.from_device == client.getDeviceId()
            ) {
                // ignore requests from ourselves, because it doesn't make sense for a
                // device to verify itself
                return false;
            }
        }
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

    async beginKeyVerification(method) {
        // need to allow also when unsent in case of to_device
        if (!this._verifier) {
            if ((this._phase === PHASE_UNSENT && this.medium.requestIsOptional) || (
                this._phase === PHASE_REQUESTED &&
                this._commonMethods &&
                this._commonMethods.includes(method)
            )) {
                this._verifier = this._createVerifier(method);
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
            this._phase = PHASE_REQUESTED;
            await this.medium.send(REQUEST_TYPE, {methods: this._methods});
            this.emit("change");
        }
    }

    async cancel({reason = "User declined", code = "m.user"}) {
        if (this._phase !== PHASE_CANCELLED) {
            if (this._verifier) {
                return this._verifier.cancel(errorFactory(code, reason));
            } else {
                this._phase = PHASE_CANCELLED;
                await this.medium.send(CANCEL_TYPE, {code, reason});
            }
            this.emit("change");
        }
    }

    _setPhase(phase) {
        this._phase = phase;
        this.emit("change");
    }

    handleEvent(type, event) {
        const content = event.getContent();
        if (type === REQUEST_TYPE) {
            this._handleRequest(content, event);
        } else if (type === START_TYPE) {
            this._handleStart(content, event);
        }

        if (type.startsWith(EVENT_PREFIX) && this._verifier) {
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
            this._setPhase(PHASE_REQUESTED);
        } else {
            logger.warn("Ignoring flagged verification request from " +
                event.getSender());
            this.cancel(errorFromEvent(newUnexpectedMessageError()));
        }
    }

    async _handleStart(content, event) {
        if (this._phase === PHASE_REQUESTED ||
            (this.medium.requestIsOptional &&
                this._phase === PHASE_UNSENT)
        ) {
            const {method} = content;
            if (!this._verificationMethods.has(method)) {
                await this.cancel(errorFromEvent(newUnknownMethodError()));
            } else {
                this._verifier = this._createVerifier(method, event);
                this._setPhase(PHASE_STARTED);
            }
        } else {
            // TODO: cancel?
        }
    }

    _handleVerifierStart() {
        if (this._phase === PHASE_UNSENT || this._phase === PHASE_REQUESTED) {
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

    _createVerifier(method, startEvent = null) {
        const requestOrStartEvent = startEvent || this._requestEvent;
        const sender = requestOrStartEvent.getSender();
        const content = requestOrStartEvent.getContent();
        const device = content && content.from_device;

        const VerifierCtor = this._verificationMethods.get(method);
        if (!VerifierCtor) {
            return;
        }
        const proxyMedium = new ProxyMedium(this, this.medium);
        return new VerifierCtor(
            proxyMedium,
            sender,
            device,
            startEvent,
        );
    }
}
