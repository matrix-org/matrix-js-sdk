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

import {logger} from '../../../logger';
import {EventEmitter} from 'events';
import {
    errorFactory,
    errorFromEvent,
    newUnexpectedMessageError,
    newUnknownMethodError,
} from "../Error";
import {QRCodeData, SCAN_QR_CODE_METHOD} from "../QRCode";

// How long after the event's timestamp that the request times out
const TIMEOUT_FROM_EVENT_TS = 10 * 60 * 1000; // 10 minutes

// How long after we receive the event that the request times out
const TIMEOUT_FROM_EVENT_RECEIPT = 2 * 60 * 1000; // 2 minutes

// to avoid almost expired verification notifications
// from showing a notification and almost immediately
// disappearing, also ignore verification requests that
// are this amount of time away from expiring.
const VERIFICATION_REQUEST_MARGIN = 3 * 1000; // 3 seconds


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
export class VerificationRequest extends EventEmitter {
    constructor(channel, verificationMethods, client) {
        super();
        this.channel = channel;
        this.channel._request = this;
        this._verificationMethods = verificationMethods;
        this._client = client;
        this._commonMethods = [];
        this._setPhase(PHASE_UNSENT, false);
        this._eventsByUs = new Map();
        this._eventsByThem = new Map();
        this._observeOnly = false;
        this._timeoutTimer = null;
        this._accepting = false;
        this._declining = false;
        this._verifierHasFinished = false;
        this._cancelled = false;
        this._chosenMethod = null;
        // we keep a copy of the QR Code data (including other user master key) around
        // for QR reciprocate verification, to protect against
        // cross-signing identity reset between the .ready and .start event
        // and signing the wrong key after .start
        this._qrCodeData = null;

        // The timestamp when we received the request event from the other side
        this._requestReceivedAt = null;
    }

    /**
     * Stateless validation logic not specific to the channel.
     * Invoked by the same static method in either channel.
     * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
     * @param {MatrixEvent} event the event to validate. Don't call getType() on it but use the `type` parameter instead.
     * @param {MatrixClient} client the client to get the current user and device id from
     * @returns {bool} whether the event is valid and should be passed to handleEvent
     */
    static validateEvent(type, event, client) {
        const content = event.getContent();


        if (!type || !type.startsWith(EVENT_PREFIX)) {
            return false;
        }

        // from here on we're fairly sure that this is supposed to be
        // part of a verification request, so be noisy when rejecting something
        if (!content) {
            logger.log("VerificationRequest: validateEvent: no content");
            return false;
        }

        if (type === REQUEST_TYPE || type === READY_TYPE) {
            if (!Array.isArray(content.methods)) {
                logger.log("VerificationRequest: validateEvent: " +
                    "fail because methods");
                return false;
            }
        }

        if (type === REQUEST_TYPE || type === READY_TYPE || type === START_TYPE) {
            if (typeof content.from_device !== "string" ||
                content.from_device.length === 0
            ) {
                logger.log("VerificationRequest: validateEvent: "+
                    "fail because from_device");
                return false;
            }
        }

        return true;
    }

    get invalid() {
        return this.phase === PHASE_UNSENT;
    }

    /** returns whether the phase is PHASE_REQUESTED */
    get requested() {
        return this.phase === PHASE_REQUESTED;
    }

    /** returns whether the phase is PHASE_CANCELLED */
    get cancelled() {
        return this.phase === PHASE_CANCELLED;
    }

    /** returns whether the phase is PHASE_READY */
    get ready() {
        return this.phase === PHASE_READY;
    }

    /** returns whether the phase is PHASE_STARTED */
    get started() {
        return this.phase === PHASE_STARTED;
    }

    /** returns whether the phase is PHASE_DONE */
    get done() {
        return this.phase === PHASE_DONE;
    }

    /** once the phase is PHASE_STARTED (and !initiatedByMe) or PHASE_READY: common methods supported by both sides */
    get methods() {
        return this._commonMethods;
    }

    /** the method picked in the .start event */
    get chosenMethod() {
        return this._chosenMethod;
    }

    calculateEventTimeout(event) {
        let effectiveExpiresAt = this.channel.getTimestamp(event)
            + TIMEOUT_FROM_EVENT_TS;

        if (this._requestReceivedAt && !this.initiatedByMe &&
            this.phase <= PHASE_REQUESTED
        ) {
            const expiresAtByReceipt = this._requestReceivedAt
                + TIMEOUT_FROM_EVENT_RECEIPT;
            effectiveExpiresAt = Math.min(effectiveExpiresAt, expiresAtByReceipt);
        }

        return Math.max(0, effectiveExpiresAt - Date.now());
    }

    /** The current remaining amount of ms before the request should be automatically cancelled */
    get timeout() {
        const requestEvent = this._getEventByEither(REQUEST_TYPE);
        if (requestEvent) {
            return this.calculateEventTimeout(requestEvent);
        }
        return 0;
    }

    /**
     * The key verification request event.
     * @returns {MatrixEvent} The request event, or falsey if not found.
     */
    get requestEvent() {
        return this._getEventByEither(REQUEST_TYPE);
    }

    /** current phase of the request. Some properties might only be defined in a current phase. */
    get phase() {
        return this._phase;
    }

    /** The verifier to do the actual verification, once the method has been established. Only defined when the `phase` is PHASE_STARTED. */
    get verifier() {
        return this._verifier;
    }

    get canAccept() {
        return this.phase < PHASE_READY && !this._accepting && !this._declining;
    }

    get accepting() {
        return this._accepting;
    }

    get declining() {
        return this._declining;
    }

    /** whether this request has sent it's initial event and needs more events to complete */
    get pending() {
        return !this.observeOnly &&
            this._phase !== PHASE_DONE &&
            this._phase !== PHASE_CANCELLED;
    }

    /** Only set after a .ready if the other party can scan a QR code */
    get qrCodeData() {
        return this._qrCodeData;
    }

    /** Checks whether the other party supports a given verification method.
     *  This is useful when setting up the QR code UI, as it is somewhat asymmetrical:
     *  if the other party supports SCAN_QR, we should show a QR code in the UI, and vice versa.
     *  For methods that need to be supported by both ends, use the `methods` property.
     *  @param {string} method the method to check
     *  @param {boolean} force to check even if the phase is not ready or started yet, internal usage
     *  @return {bool} whether or not the other party said the supported the method */
    otherPartySupportsMethod(method, force = false) {
        if (!force && !this.ready && !this.started) {
            return false;
        }
        const theirMethodEvent = this._eventsByThem.get(REQUEST_TYPE) ||
            this._eventsByThem.get(READY_TYPE);
        if (!theirMethodEvent) {
            // if we started straight away with .start event,
            // we are assuming that the other side will support the
            // chosen method, so return true for that.
            if (this.started && this.initiatedByMe) {
                const myStartEvent = this._eventsByUs.get(START_TYPE);
                const content = myStartEvent && myStartEvent.getContent();
                const myStartMethod = content && content.method;
                return method == myStartMethod;
            }
            return false;
        }
        const content = theirMethodEvent.getContent();
        if (!content) {
            return false;
        }
        const {methods} = content;
        if (!Array.isArray(methods)) {
            return false;
        }

        return methods.includes(method);
    }

    /** Whether this request was initiated by the syncing user.
     * For InRoomChannel, this is who sent the .request event.
     * For ToDeviceChannel, this is who sent the .start event
     */
    get initiatedByMe() {
        // event created by us but no remote echo has been received yet
        const noEventsYet = (this._eventsByUs.size + this._eventsByThem.size) === 0;
        if (this._phase === PHASE_UNSENT && noEventsYet) {
            return true;
        }
        const hasMyRequest = this._eventsByUs.has(REQUEST_TYPE);
        const hasTheirRequest = this._eventsByThem.has(REQUEST_TYPE);
        if (hasMyRequest && !hasTheirRequest) {
            return true;
        }
        if (!hasMyRequest && hasTheirRequest) {
            return false;
        }
        const hasMyStart = this._eventsByUs.has(START_TYPE);
        const hasTheirStart = this._eventsByThem.has(START_TYPE);
        if (hasMyStart && !hasTheirStart) {
            return true;
        }
        return false;
    }

    /** The id of the user that initiated the request */
    get requestingUserId() {
        if (this.initiatedByMe) {
            return this._client.getUserId();
        } else {
            return this.otherUserId;
        }
    }

    /** The id of the user that (will) receive(d) the request */
    get receivingUserId() {
        if (this.initiatedByMe) {
            return this.otherUserId;
        } else {
            return this._client.getUserId();
        }
    }

    /** The user id of the other party in this request */
    get otherUserId() {
        return this.channel.userId;
    }

    get isSelfVerification() {
        return this._client.getUserId() === this.otherUserId;
    }

    /**
     * The id of the user that cancelled the request,
     * only defined when phase is PHASE_CANCELLED
     */
    get cancellingUserId() {
        const myCancel = this._eventsByUs.get(CANCEL_TYPE);
        const theirCancel = this._eventsByThem.get(CANCEL_TYPE);

        if (myCancel && (!theirCancel || myCancel.getId() < theirCancel.getId())) {
            return myCancel.getSender();
        }
        if (theirCancel) {
            return theirCancel.getSender();
        }
        return undefined;
    }

    /**
     * The cancellation code e.g m.user which is responsible for cancelling this verification
     */
    get cancellationCode() {
        const ev = this._getEventByEither(CANCEL_TYPE);
        return ev ? ev.getContent().code : null;
    }

    get observeOnly() {
        return this._observeOnly;
    }


    /**
     * Gets which device the verification should be started with
     * given the events sent so far in the verification. This is the
     * same algorithm used to determine which device to send the
     * verification to when no specific device is specified.
     * @returns {{userId: *, deviceId: *}} The device information
     */
    get targetDevice() {
        const theirFirstEvent =
            this._eventsByThem.get(REQUEST_TYPE) ||
            this._eventsByThem.get(READY_TYPE) ||
            this._eventsByThem.get(START_TYPE);
        const theirFirstContent = theirFirstEvent.getContent();
        const fromDevice = theirFirstContent.from_device;
        return {
            userId: this.otherUserId,
            deviceId: fromDevice,
        };
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
        if (!this.observeOnly && !this._verifier) {
            const validStartPhase =
                this.phase === PHASE_REQUESTED ||
                this.phase === PHASE_READY ||
                (this.phase === PHASE_UNSENT &&
                    this.channel.constructor.canCreateRequest(START_TYPE));
            if (validStartPhase) {
                // when called on a request that was initiated with .request event
                // check the method is supported by both sides
                if (this._commonMethods.length && !this._commonMethods.includes(method)) {
                    throw newUnknownMethodError();
                }
                this._verifier = this._createVerifier(method, null, targetDevice);
                if (!this._verifier) {
                    throw newUnknownMethodError();
                }
                this._chosenMethod = method;
            }
        }
        return this._verifier;
    }

    /**
     * sends the initial .request event.
     * @returns {Promise} resolves when the event has been sent.
     */
    async sendRequest() {
        if (!this.observeOnly && this._phase === PHASE_UNSENT) {
            const methods = [...this._verificationMethods.keys()];
            await this.channel.send(REQUEST_TYPE, {methods});
        }
    }

    /**
     * Cancels the request, sending a cancellation to the other party
     * @param {string?} error.reason the error reason to send the cancellation with
     * @param {string?} error.code the error code to send the cancellation with
     * @returns {Promise} resolves when the event has been sent.
     */
    async cancel({reason = "User declined", code = "m.user"} = {}) {
        if (!this.observeOnly && this._phase !== PHASE_CANCELLED) {
            this._declining = true;
            this.emit("change");
            if (this._verifier) {
                return this._verifier.cancel(errorFactory(code, reason)());
            } else {
                this._cancellingUserId = this._client.getUserId();
                await this.channel.send(CANCEL_TYPE, {code, reason});
            }
        }
    }

    /**
     * Accepts the request, sending a .ready event to the other party
     * @returns {Promise} resolves when the event has been sent.
     */
    async accept() {
        if (!this.observeOnly && this.phase === PHASE_REQUESTED && !this.initiatedByMe) {
            const methods = [...this._verificationMethods.keys()];
            this._accepting = true;
            this.emit("change");
            await this.channel.send(READY_TYPE, {methods});
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

    _getEventByEither(type) {
        return this._eventsByThem.get(type) || this._eventsByUs.get(type);
    }

    _getEventBy(type, byThem) {
        if (byThem) {
            return this._eventsByThem.get(type);
        } else {
            return this._eventsByUs.get(type);
        }
    }

    _calculatePhaseTransitions() {
        const transitions = [{phase: PHASE_UNSENT}];
        const phase = () => transitions[transitions.length - 1].phase;

        // always pass by .request first to be sure channel.userId has been set
        const hasRequestByThem = this._eventsByThem.has(REQUEST_TYPE);
        const requestEvent = this._getEventBy(REQUEST_TYPE, hasRequestByThem);
        if (requestEvent) {
            transitions.push({phase: PHASE_REQUESTED, event: requestEvent});
        }

        const readyEvent =
            requestEvent && this._getEventBy(READY_TYPE, !hasRequestByThem);
        if (readyEvent && phase() === PHASE_REQUESTED) {
            transitions.push({phase: PHASE_READY, event: readyEvent});
        }

        let startEvent;
        if (readyEvent || !requestEvent) {
            const theirStartEvent = this._eventsByThem.get(START_TYPE);
            const ourStartEvent = this._eventsByUs.get(START_TYPE);
            // any party can send .start after a .ready or unsent
            if (theirStartEvent && ourStartEvent) {
                startEvent = theirStartEvent.getSender() < ourStartEvent.getSender() ?
                    theirStartEvent : ourStartEvent;
            } else {
                startEvent = theirStartEvent ? theirStartEvent : ourStartEvent;
            }
        } else {
            startEvent = this._getEventBy(START_TYPE, !hasRequestByThem);
        }
        if (startEvent) {
            const fromRequestPhase = phase() === PHASE_REQUESTED &&
                requestEvent.getSender() !== startEvent.getSender();
            const fromUnsentPhase = phase() === PHASE_UNSENT &&
                this.channel.constructor.canCreateRequest(START_TYPE);
            if (fromRequestPhase || phase() === PHASE_READY || fromUnsentPhase) {
                transitions.push({phase: PHASE_STARTED, event: startEvent});
            }
        }

        const ourDoneEvent = this._eventsByUs.get(DONE_TYPE);
        if (this._verifierHasFinished || (ourDoneEvent && phase() === PHASE_STARTED)) {
            transitions.push({phase: PHASE_DONE});
        }

        const cancelEvent = this._getEventByEither(CANCEL_TYPE);
        if ((this._cancelled || cancelEvent) && phase() !== PHASE_DONE) {
            transitions.push({phase: PHASE_CANCELLED, event: cancelEvent});
            return transitions;
        }

        return transitions;
    }

    _transitionToPhase(transition) {
        const {phase, event} = transition;
        // get common methods
        if (phase === PHASE_REQUESTED || phase === PHASE_READY) {
            if (!this._wasSentByOwnDevice(event)) {
                const content = event.getContent();
                this._commonMethods =
                    content.methods.filter(m => this._verificationMethods.has(m));
            }
        }
        // detect if we're not a party in the request, and we should just observe
        if (!this.observeOnly) {
            // if requested or accepted by one of my other devices
            if (phase === PHASE_REQUESTED ||
                phase === PHASE_STARTED ||
                phase === PHASE_READY
            ) {
                if (
                    this.channel.receiveStartFromOtherDevices &&
                    this._wasSentByOwnUser(event) &&
                    !this._wasSentByOwnDevice(event)
                ) {
                    this._observeOnly = true;
                }
            }
        }
        // create verifier
        if (phase === PHASE_STARTED) {
            const {method} = event.getContent();
            if (!this._verifier && !this.observeOnly) {
                this._verifier = this._createVerifier(method, event);
                if (!this._verifier) {
                    this.cancel({
                        code: "m.unknown_method",
                        reason: `Unknown method: ${method}`,
                    });
                } else {
                    this._chosenMethod = method;
                }
            }
        }
    }

    _applyPhaseTransitions() {
        const transitions = this._calculatePhaseTransitions();
        const existingIdx = transitions.findIndex(t => t.phase === this.phase);
        // trim off phases we already went through, if any
        const newTransitions = transitions.slice(existingIdx + 1);
        // transition to all new phases
        for (const transition of newTransitions) {
            this._transitionToPhase(transition);
        }
        return newTransitions;
    }

    _isWinningStartRace(newEvent) {
        if (newEvent.getType() !== START_TYPE) {
            return false;
        }
        const oldEvent = this._verifier.startEvent;

        let oldRaceIdentifier;
        if (this.isSelfVerification) {
            // if the verifier does not have a startEvent,
            // it is because it's still sending and we are on the initator side
            // we know we are sending a .start event because we already
            // have a verifier (checked in calling method)
            if (oldEvent) {
                const oldContent = oldEvent.getContent();
                oldRaceIdentifier = oldContent && oldContent.from_device;
            } else {
                oldRaceIdentifier = this._client.getDeviceId();
            }
        } else {
            if (oldEvent) {
                oldRaceIdentifier = oldEvent.getSender();
            } else {
                oldRaceIdentifier = this._client.getUserId();
            }
        }

        let newRaceIdentifier;
        if (this.isSelfVerification) {
            const newContent = newEvent.getContent();
            newRaceIdentifier = newContent && newContent.from_device;
        } else {
            newRaceIdentifier = newEvent.getSender();
        }
        return newRaceIdentifier < oldRaceIdentifier;
    }

    hasEventId(eventId) {
        for (const event of this._eventsByUs.values()) {
            if (event.getId() === eventId) {
                return true;
            }
        }
        for (const event of this._eventsByThem.values()) {
            if (event.getId() === eventId) {
                return true;
            }
        }
        return false;
    }

    /**
     * Changes the state of the request and verifier in response to a key verification event.
     * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
     * @param {MatrixEvent} event the event to handle. Don't call getType() on it but use the `type` parameter instead.
     * @param {bool} isLiveEvent whether this is an even received through sync or not
     * @param {bool} isRemoteEcho whether this is the remote echo of an event sent by the same device
     * @param {bool} isSentByUs whether this event is sent by a party that can accept and/or observe the request like one of our peers.
     *   For InRoomChannel this means any device for the syncing user. For ToDeviceChannel, just the syncing device.
     * @returns {Promise} a promise that resolves when any requests as an anwser to the passed-in event are sent.
     */
    async handleEvent(type, event, isLiveEvent, isRemoteEcho, isSentByUs) {
        // if reached phase cancelled or done, ignore anything else that comes
        if (this.done || this.cancelled) {
            return;
        }
        const wasObserveOnly = this._observeOnly;

        this._adjustObserveOnly(event, isLiveEvent);

        if (!this.observeOnly && !isRemoteEcho) {
            if (await this._cancelOnError(type, event)) {
                return;
            }
        }

        // This assumes verification won't need to send an event with
        // the same type for the same party twice.
        // This is true for QR and SAS verification, and was
        // added here to prevent verification getting cancelled
        // when the server duplicates an event (https://github.com/matrix-org/synapse/issues/3365)
        const isDuplicateEvent = isSentByUs ?
            this._eventsByUs.has(type) :
            this._eventsByThem.has(type);
        if (isDuplicateEvent) {
            return;
        }

        const oldPhase = this.phase;
        this._addEvent(type, event, isSentByUs);

        // this will create if needed the verifier so needs to happen before calling it
        const newTransitions = this._applyPhaseTransitions();
        try {
            // only pass events from the other side to the verifier,
            // no remote echos of our own events
            if (this._verifier && !this.observeOnly) {
                const newEventWinsRace = this._isWinningStartRace(event);
                if (this._verifier.canSwitchStartEvent(event) && newEventWinsRace) {
                    this._verifier.switchStartEvent(event);
                } else if (!isRemoteEcho) {
                    if (type === CANCEL_TYPE || (this._verifier.events
                        && this._verifier.events.includes(type))) {
                        this._verifier.handleEvent(event);
                    }
                }
            }

            if (newTransitions.length) {
                // create QRCodeData if the other side can scan
                // important this happens before emitting a phase change,
                // so listeners can rely on it being there already
                // We only do this for live events because it is important that
                // we sign the keys that were in the QR code, and not the keys
                // we happen to have at some later point in time.
                if (isLiveEvent && newTransitions.some(t => t.phase === PHASE_READY)) {
                    const shouldGenerateQrCode =
                        this.otherPartySupportsMethod(SCAN_QR_CODE_METHOD, true);
                    if (shouldGenerateQrCode) {
                        this._qrCodeData = await QRCodeData.create(this, this._client);
                    }
                }

                const lastTransition = newTransitions[newTransitions.length - 1];
                const {phase} = lastTransition;

                this._setupTimeout(phase);
                // set phase as last thing as this emits the "change" event
                this._setPhase(phase);
            } else if (this._observeOnly !== wasObserveOnly) {
                this.emit("change");
            }
        } finally {
            // log events we processed so we can see from rageshakes what events were added to a request
            logger.log(`Verification request ${this.channel.transactionId}: ` +
                `${type} event with id:${event.getId()}, ` +
                `content:${JSON.stringify(event.getContent())} ` +
                `deviceId:${this.channel.deviceId}, ` +
                `sender:${event.getSender()}, isSentByUs:${isSentByUs}, ` +
                `isLiveEvent:${isLiveEvent}, isRemoteEcho:${isRemoteEcho}, ` +
                `phase:${oldPhase}=>${this.phase}, ` +
                `observeOnly:${wasObserveOnly}=>${this._observeOnly}`);
        }
    }

    _setupTimeout(phase) {
        const shouldTimeout = !this._timeoutTimer && !this.observeOnly &&
            phase === PHASE_REQUESTED;

        if (shouldTimeout) {
            this._timeoutTimer = setTimeout(this._cancelOnTimeout, this.timeout);
        }
        if (this._timeoutTimer) {
            const shouldClear = phase === PHASE_STARTED ||
                phase === PHASE_READY ||
                phase === PHASE_DONE ||
                phase === PHASE_CANCELLED;
            if (shouldClear) {
                clearTimeout(this._timeoutTimer);
                this._timeoutTimer = null;
            }
        }
    }

    _cancelOnTimeout = () => {
        try {
            if (this.initiatedByMe) {
                this.cancel({
                    reason: "Other party didn't accept in time",
                    code: "m.timeout",
                });
            } else {
                this.cancel({
                    reason: "User didn't accept in time",
                    code: "m.timeout",
                });
            }
        } catch (err) {
            logger.error("Error while cancelling verification request", err);
        }
    };

    async _cancelOnError(type, event) {
        if (type === START_TYPE) {
            const method = event.getContent().method;
            if (!this._verificationMethods.has(method)) {
                await this.cancel(errorFromEvent(newUnknownMethodError()));
                return true;
            }
        }

        const isUnexpectedRequest = type === REQUEST_TYPE && this.phase !== PHASE_UNSENT;
        const isUnexpectedReady = type === READY_TYPE && this.phase !== PHASE_REQUESTED;
        // only if phase has passed from PHASE_UNSENT should we cancel, because events
        // are allowed to come in in any order (at least with InRoomChannel). So we only know
        // we're dealing with a valid request we should participate in once we've moved to PHASE_REQUESTED
        // before that, we could be looking at somebody elses verification request and we just
        // happen to be in the room
        if (this.phase !== PHASE_UNSENT && (isUnexpectedRequest || isUnexpectedReady)) {
            logger.warn(`Cancelling, unexpected ${type} verification ` +
                `event from ${event.getSender()}`);
            const reason = `Unexpected ${type} event in phase ${this.phase}`;
            await this.cancel(errorFromEvent(newUnexpectedMessageError({reason})));
            return true;
        }
        return false;
    }

    _adjustObserveOnly(event, isLiveEvent) {
        // don't send out events for historical requests
        if (!isLiveEvent) {
            this._observeOnly = true;
        }
        if (this.calculateEventTimeout(event) < VERIFICATION_REQUEST_MARGIN) {
            this._observeOnly = true;
        }
    }

    _addEvent(type, event, isSentByUs) {
        if (isSentByUs) {
            this._eventsByUs.set(type, event);
        } else {
            this._eventsByThem.set(type, event);
        }

        // once we know the userId of the other party (from the .request event)
        // see if any event by anyone else crept into this._eventsByThem
        if (type === REQUEST_TYPE) {
            for (const [type, event] of this._eventsByThem.entries()) {
                if (event.getSender() !== this.otherUserId) {
                    this._eventsByThem.delete(type);
                }
            }
            // also remember when we received the request event
            this._requestReceivedAt = Date.now();
        }
    }

    _createVerifier(method, startEvent = null, targetDevice = null) {
        if (!targetDevice) {
            targetDevice = this.targetDevice;
        }
        const {userId, deviceId} = targetDevice;

        const VerifierCtor = this._verificationMethods.get(method);
        if (!VerifierCtor) {
            logger.warn("could not find verifier constructor for method", method);
            return;
        }
        return new VerifierCtor(
            this.channel,
            this._client,
            userId,
            deviceId,
            startEvent,
            this,
        );
    }

    _wasSentByOwnUser(event) {
        return event.getSender() === this._client.getUserId();
    }

    // only for .request, .ready or .start
    _wasSentByOwnDevice(event) {
        if (!this._wasSentByOwnUser(event)) {
            return false;
        }
        const content = event.getContent();
        if (!content || content.from_device !== this._client.getDeviceId()) {
            return false;
        }
        return true;
    }

    onVerifierCancelled() {
        this._cancelled = true;
        // move to cancelled phase
        const newTransitions = this._applyPhaseTransitions();
        if (newTransitions.length) {
            this._setPhase(newTransitions[newTransitions.length - 1].phase);
        }
    }

    onVerifierFinished() {
        this.channel.send("m.key.verification.done", {});
        this._verifierHasFinished = true;
        // move to .done phase
        const newTransitions = this._applyPhaseTransitions();
        if (newTransitions.length) {
            this._setPhase(newTransitions[newTransitions.length - 1].phase);
        }
    }

    getEventFromOtherParty(type) {
        return this._eventsByThem.get(type);
    }
}
