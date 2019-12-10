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
import RequestCallbackChannel from "./RequestCallbackChannel";
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
const VERIFICATION_REQUEST_TIMEOUT = 10 * 60 * 1000; //10m
// to avoid almost expired verification notifications
// from showing a notification and almost immediately
// disappearing, also ignore verification requests that
// are this amount of time away from expiring.
const VERIFICATION_REQUEST_MARGIN = 3 * 1000; //3s


export const EVENT_PREFIX = "m.key.verification.";
export const REQUEST_TYPE = EVENT_PREFIX + "request";
export const START_TYPE = EVENT_PREFIX + "start";
export const CANCEL_TYPE = EVENT_PREFIX + "cancel";
export const DONE_TYPE = EVENT_PREFIX + "done";
export const READY_TYPE = EVENT_PREFIX + "ready";

export const PHASE_UNSENT = 1;
export const PHASE_REQUESTED = 2;
export const PHASE_READY = 3;
export const PHASE_STARTED = 4;
export const PHASE_CANCELLED = 5;
export const PHASE_DONE = 6;


/**
 * State machine for verification requests.
 * Things that differ based on what channel is used to
 * send and receive verification events are put in `InRoomChannel` or `ToDeviceChannel`.
 * @event "change" whenever the state of the request object has changed.
 */
export default class VerificationRequest extends EventEmitter {
    constructor(channel, verificationMethods, userId, client) {
        super();
        this.channel = channel;
        this._verificationMethods = verificationMethods;
        this._client = client;
        this._commonMethods = [];
        this._setPhase(PHASE_UNSENT, false);
        this._requestEvent = null;
        this._otherUserId = userId;
        this._initiatedByMe = null;
        this._startTimestamp = null;
    }

    /**
     * Stateless validation logic not specific to the channel.
     * Invoked by the same static method in either channel.
     * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
     * @param {MatrixEvent} event the event to validate. Don't call getType() on it but use the `type` parameter instead.
     * @param {number} timestamp the timestamp in milliseconds when this event was sent.
     * @param {MatrixClient} client the client to get the current user and device id from
     * @returns {bool} whether the event is valid and should be passed to handleEvent
     */
    static validateEvent(type, event, timestamp, client) {
        const content = event.getContent();

        if (!type.startsWith(EVENT_PREFIX)) {
            return false;
        }

        if (type === REQUEST_TYPE || type === READY_TYPE) {
            if (!Array.isArray(content.methods)) {
                return false;
            }
        }

        if (type === REQUEST_TYPE || type === READY_TYPE || type === START_TYPE) {
            if (typeof content.from_device !== "string" ||
                content.from_device.length === 0
            ) {
                return false;
            }
        }

        // a timestamp is not provided on all to_device events
        if (Number.isFinite(timestamp)) {
            const elapsed = Date.now() - timestamp;
            // ignore if event is too far in the past or too far in the future
            if (elapsed > (VERIFICATION_REQUEST_TIMEOUT - VERIFICATION_REQUEST_MARGIN) ||
                elapsed < -(VERIFICATION_REQUEST_TIMEOUT / 2)) {
                logger.log("received verification that is too old or from the future");
                return false;
            }
        }

        return true;
    }

    /** once the phase is PHASE_STARTED (and !initiatedByMe) or PHASE_READY: common methods supported by both sides */
    get methods() {
        return this._commonMethods;
    }

    /** the timeout of the request, provided for compatibility with previous verification code */
    get timeout() {
        const elapsed = Date.now() - this._startTimestamp;
        return Math.max(0, VERIFICATION_REQUEST_TIMEOUT - elapsed);
    }

    /** the m.key.verification.request event that started this request, provided for compatibility with previous verification code */
    get event() {
        return this._requestEvent;
    }

    /** current phase of the request. Some properties might only be defined in a current phase. */
    get phase() {
        return this._phase;
    }

    /** The verifier to do the actual verification, once the method has been established. Only defined when the `phase` is PHASE_STARTED. */
    get verifier() {
        return this._verifier;
    }

    /** whether this request has sent it's initial event and needs more events to complete */
    get pending() {
        return this._phase !== PHASE_UNSENT
            && this._phase !== PHASE_DONE
            && this._phase !== PHASE_CANCELLED;
    }

    /** Whether this request was initiated by the syncing user.
     * For InRoomChannel, this is who sent the .request event.
     * For ToDeviceChannel, this is who sent the .start event
     */
    get initiatedByMe() {
        return this._initiatedByMe;
    }

    /** the id of the user that initiated the request */
    get requestingUserId() {
        if (this.initiatedByMe) {
            return this._client.getUserId();
        } else {
            return this._otherUserId;
        }
    }

    /** the id of the user that (will) receive(d) the request */
    get receivingUserId() {
        if (this.initiatedByMe) {
            return this._otherUserId;
        } else {
            return this._client.getUserId();
        }
    }

    /* Start the key verification, creating a verifier and sending a .start event.
     * If no previous events have been sent, pass in `targetDevice` to set who to direct this request to.
     * @param {string} method the name of the verification method to use.
     * @param {string?} targetDevice.userId the id of the user to direct this request to
     * @param {string?} targetDevice.deviceId the id of the device to direct this request to
     * @returns {VerifierBase} the verifier of the given method
     */
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

    /**
     * sends the initial .request event.
     * @returns {Promise} resolves when the event has been sent.
     */
    async sendRequest() {
        if (this._phase === PHASE_UNSENT) {
            this._initiatedByMe = true;
            this._setPhase(PHASE_REQUESTED, false);
            const methods = [...this._verificationMethods.keys()];
            await this.channel.send(REQUEST_TYPE, {methods});
            this.emit("change");
        }
    }

    /**
     * Cancels the request, sending a cancellation to the other party
     * @param {string?} error.reason the error reason to send the cancellation with
     * @param {string?} error.code the error code to send the cancellation with
     * @returns {Promise} resolves when the event has been sent.
     */
    async cancel({reason = "User declined", code = "m.user"} = {}) {
        if (this._phase !== PHASE_CANCELLED) {
            if (this._verifier) {
                return this._verifier.cancel(errorFactory(code, reason));
            } else {
                this._setPhase(PHASE_CANCELLED, false);
                await this.channel.send(CANCEL_TYPE, {code, reason});
            }
            this.emit("change");
        }
    }

    /**
     * Accepts the request, sending a .ready event to the other party
     * @returns {Promise} resolves when the event has been sent.
     */
    async accept() {
        if (this.phase === PHASE_REQUESTED && !this.initiatedByMe) {
            const methods = [...this._verificationMethods.keys()];
            this._setPhase(PHASE_READY, false);
            await this.channel.send(READY_TYPE, {methods});
            this.emit("change");
        }
    }

    /**
     * Can be used to listen for state changes until the callback returns true.
     * @param {Function} fn callback to evaluate whether the request is in the desired state.
     *                      Takes the request as an argument.
     * @returns {Promise} that resolves once the callback returns true
     * @throws {Error} when the request is cancelled
     */
    waitFor(fn) {
        return new Promise((resolve, reject) => {
            const check = () => {
                let handled = false;
                if (fn(this)) {
                    resolve(this);
                    handled = true;
                } else if (this.cancelled) {
                    reject(new Error("cancelled"));
                    handled = true;
                }
                if (handled) {
                    this.off("change", check);
                }
                return handled;
            };
            if (!check()) {
                this.on("change", check);
            }
        });
    }

    _setPhase(phase, notify = true) {
        this._phase = phase;
        if (notify) {
            this.emit("change");
        }
    }

    /**
     * Changes the state of the request and verifier in response to a key verification event.
     * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
     * @param {MatrixEvent} event the event to handle. Don't call getType() on it but use the `type` parameter instead.
     * @param {number} timestamp the timestamp in milliseconds when this event was sent.
     * @returns {Promise} a promise that resolves when any requests as an anwser to the passed-in event are sent.
     */
    async handleEvent(type, event, timestamp) {
        const content = event.getContent();
        if (type === REQUEST_TYPE || type === START_TYPE) {
            if (this._startTimestamp === null) {
                this._startTimestamp = timestamp;
            }
        }
        if (type === REQUEST_TYPE) {
            await this._handleRequest(content, event);
        } else if (type === READY_TYPE) {
            await this._handleReady(content);
        } else if (type === START_TYPE) {
            await this._handleStart(content, event);
        }

        if (this._verifier) {
            if (type === CANCEL_TYPE || (this._verifier.events
                && this._verifier.events.includes(type))) {
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
            this._commonMethods = this._filterMethods(otherMethods);
            this._requestEvent = event;
            this._initiatedByMe = this._wasSentByMe(event);
            this._setPhase(PHASE_REQUESTED);
        } else if (this._phase !== PHASE_REQUESTED) {
            logger.warn("Ignoring flagged verification request from " +
                event.getSender());
            await this.cancel(errorFromEvent(newUnexpectedMessageError()));
        }
    }

    async _handleReady(content) {
        if (this._phase === PHASE_REQUESTED) {
            const otherMethods = content.methods;
            this._commonMethods = this._filterMethods(otherMethods);
            this._setPhase(PHASE_READY);
        } else {
            logger.warn("Ignoring flagged verification ready event from " +
                event.getSender());
            await this.cancel(errorFromEvent(newUnexpectedMessageError()));
        }
    }

    _hasValidPreStartPhase() {
        return this._phase === PHASE_REQUESTED || this._phase === PHASE_READY ||
            (
                this.channel.constructor.canCreateRequest(START_TYPE) &&
                this._phase === PHASE_UNSENT
            );
    }

    async _handleStart(content, event) {
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
        }
    }

    /**
     * Called by RequestCallbackChannel when the verifier sends an event
     * @param {string} type the "symbolic" event type
     * @param {object} content the completed or uncompleted content for the event to be sent
     */
    handleVerifierSend(type, content) {
        if (type === CANCEL_TYPE) {
            this._handleCancel();
        } else if (type === START_TYPE) {
            if (this._phase === PHASE_UNSENT || this._phase === PHASE_REQUESTED) {
                // if unsent, we're sending a (first) .start event and hence requesting the verification.
                // in any other situation, the request was initiated by the other party.
                this._initiatedByMe = this.phase === PHASE_UNSENT;
                this._setPhase(PHASE_STARTED);
            }
        }
    }

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
            console.warn("could not find verifier constructor for method", method);
            return;
        }
        // invokes handleVerifierSend when verifier sends something
        const callbackMedium = new RequestCallbackChannel(this, this.channel);
        return new VerifierCtor(
            callbackMedium,
            this._client,
            userId,
            deviceId,
            startSentByMe ? null : startEvent,
        );
    }

    _getVerifierTarget(startEvent, targetDevice) {
        // targetDevice should be set when creating a verifier for to_device before the .start event has been sent,
        // so the userId and deviceId are provided
        if (targetDevice) {
            return targetDevice;
        } else {
            let targetEvent;
            if (startEvent && !this._wasSentByMe(startEvent)) {
                targetEvent = startEvent;
            } else if (this._requestEvent && !this._wasSentByMe(this._requestEvent)) {
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

    _filterMethods(methodNames) {
        return methodNames.filter(m => this._verificationMethods.has(m));
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
