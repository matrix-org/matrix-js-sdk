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

import { randomString } from '../../../randomstring';
import logger from '../../../logger';
import {EventEmitter} from 'events';
import {
    newUserCancelledError,
    newTimeoutError,
    newUnknownTransactionError,
    newUnknownMethodError,
    newUnexpectedMessageError,
    newKeyMismatchError,
    newUserMismatchError,
    newInvalidMessageError,
    errorFromEvent,
} from "../Error";

const EVENT_PREFIX = "m.key.verification.";
const REQUEST_TYPE = EVENT_PREFIX + "request";
const START_TYPE = EVENT_PREFIX + "start";
const CANCEL_TYPE = EVENT_PREFIX + "cancel";

// the recommended amount of time before a verification request
// should be (automatically) cancelled without user interaction
// and ignored.
const VERIFICATION_REQUEST_TIMEOUT = 5 * 60 * 1000; //5m
// to avoid almost expired verification notifications
// from showing a notification and almost immediately
// disappearing, also ignore verification requests that
// are this amount of time away from expiring.
const VERIFICATION_REQUEST_MARGIN = 3 * 1000; //3s


export class ToDeviceMedium {
    // userId and devices of user we're about to verify
    constructor(client, userId, devices) {
        this._client = client;
        this._userId = userId;
        this._devices = devices;
        this._deviceId = null;
        this.transactionId = null;
    }

    static getTxnId(event) {
        const content = event.getContent();
        return content && content.transaction_id;
    }

    static validateEvent(event, client) {
        if (event.isCancelled()) {
            logger.warn("Ignoring flagged verification request from "
                 + event.getSender());
            return false;
        }
        const content = event.getContent();
        if (!content) {
            return false;
        }

        if (!content.transaction_id) {
            return false;
        }

        const type = event.getType();

        if (type === REQUEST_TYPE) {
            if (!Number.isFinite(content.timestamp)) {
                return false;
            }
            const now = Date.now();
            if (now < content.timestamp - (5 * 60 * 1000)
                || now > content.timestamp + (10 * 60 * 1000)) {
                // ignore if event is too far in the past or too far in the future
                logger.log("received verification that is too old or from the future");
                return false;
            }
        }

        return VerificationRequest.validateEvent(event, client);
    }

    get requestIsOptional() {
        return true;
    }

    async handleEvent(event, request) {
        const type = event.getType();
        const content = event.getContent();
        if (type === REQUEST_TYPE || type === START_TYPE) {
            const deviceId = content.from_device;
            if (!this._deviceId && this._devices.includes(deviceId)) {
                this._deviceId = deviceId;
            }
            if (!this._deviceId || this._deviceId !== deviceId) {
                // also check that message came from the device we sent the request to earlier on
                // and do send a cancel message to that device
                // (but don't cancel the request for the device we should be talking to)
                const cancelContent =
                    this.contentWithTxnId(errorFromEvent(newUnexpectedMessageError()));
                return this._sendToDevices(CANCEL_TYPE, cancelContent, [deviceId]);
            }
        }

        const wasStarted = request.phase === PHASE_STARTED;
        await request.handleEvent(event.getType(), event);
        const isStarted = request.phase === PHASE_STARTED;

        // the request has picked a start event, tell the other devices about it
        if (type === START_TYPE && !wasStarted && isStarted && this._deviceId) {
            const nonChosenDevices = this._devices.filter(d => d !== this._deviceId);
            const message = this.contentWithTxnId({
                code: "m.accepted",
                reason: "Verification request accepted by another device",
            });
            await this._sendToDevices(CANCEL_TYPE, message, nonChosenDevices);
        }
    }

    contentFromEventWithTxnId(event) {
        return event.getContent();
    }

    /* creates a content object with the transaction id added to it */
    contentWithTxnId(content) {
        if (this.transactionId) {
            const copy = Object.assign({}, content);
            copy.transaction_id = this.transactionId;
            return copy;
        } else {
            return content;
        }
    }

    send(type, contentWithoutTxnId = {}) {
        // create transaction id when sending request
        if (type === REQUEST_TYPE && !this.transactionId) {
            this.transactionId = randomString(32);
        }
        const content = this.contentWithTxnId(contentWithoutTxnId);
        return this.sendWithTxnId(type, content);
    }

    sendWithTxnId(type, content) {
        // TODO: we should be consistent about modifying the arguments,
        // perhaps we should add these fields in contentWithTxnId or something...
        if (type === REQUEST_TYPE || type === START_TYPE) {
            content.from_device = this._client.getDeviceId();
        }
        if (type === REQUEST_TYPE) {
            content.timestamp = Date.now();
        }

        if (type === REQUEST_TYPE) {
            return this._sendToDevices(type, content, this._devices);
        } else {
            return this._sendToDevices(type, content, [this._deviceId]);
        }
    }

    _sendToDevices(type, content, devices) {
        const msgMap = {};
        for (const deviceId of devices) {
            msgMap[deviceId] = content;
        }

        return this._client.sendToDevice(type, {[this._userId]: msgMap});
    }
}

export class InRoomMedium {
    constructor(client, roomId, userId, requestEventId = null) {
        this._client = client;
        this._roomId = roomId;
        this._userId = userId;
        this._requestEventId = requestEventId;
    }

    // why did we need this again?
    // to get the transaction id for the verifier ...
    // but we shouldn't need it anymore since it is only used
    // for sending there which will now happen through the medium
    get transactionId() {
        return this._requestEventId;
    }

    static getTxnId(event) {
        const relation = event.getRelation();
        if (relation && relation.rel_type === "m.reference") {
            return relation.event_id;
        }
    }

    static validateEvent(event, client) {
        const type = event.getType();
        // any event but the .request event needs to have a relation set
        if (type !== REQUEST_TYPE && !event.isRelation("m.reference")) {
            return false;
        }
        return VerificationRequest.validateEvent(event, client);
    }

    static getEventType(event) {
        const type = event.getType();
        if (type === "m.room.message") {
            const content = event.getContent();
            return content && content.msgtype;
        } else {
            return type;
        }
    }

    async handleEvent(event, request) {
        const type = InRoomMedium.getEventType(event);
        // do validations that need state (roomId, userId, transactionId),
        // ignore if invalid
        if (this._requestEventId) {
            const relation = event.getRelation();
            if (!relation || relation.event_id !== this._requestEventId) {
                return;
            }
        }
        if (event.getRoomId() !== this._roomId || event.getSender() !== this._userId) {
            return;
        }
        // set transactionId when receiving a .request
        if (!this._requestEventId && event.getType() === REQUEST_TYPE) {
            this._requestEventId = event.getId();
        }

        return await request.handleEvent(type, event);
    }

    contentFromEventWithTxnId(event) {
        // ensure m.related_to is included in e2ee rooms
        // as the field is excluded from encryption
        const content = Object.assign({}, event.getContent());
        content["m.relates_to"] = event.getRelation();
        return content;
    }

    /* creates a content object with the transaction id added to it */
    contentWithTxnId(content) {
        if (this._requestEventId) {
            const copy = Object.assign({}, content);
            copy["m.relates_to"] = {
                rel_type: "m.reference",
                event_id: this._requestEventId,
            };
            return copy;
        } else {
            return content;
        }
    }

    send(type, contentWithoutTxnId) {
        const content = this.contentWithTxnId(contentWithoutTxnId);
        return this.sendWithTxnId(type, content);
    }

    async sendWithTxnId(type, content) {
        if (type === REQUEST_TYPE || type === START_TYPE) {
            content.from_device = this._client.getDeviceId();
        }
        if (type === REQUEST_TYPE) {
            content = {
                body: this._baseApis.getUserId() + " is requesting to verify " +
                    "your key, but your client does not support in-chat key " +
                    "verification.  You will need to use legacy key " +
                    "verification to verify keys.",
                msgtype: REQUEST_TYPE,
                to: this._userId,
                from_device: content.from_device,
                methods: content.methods,
            };
            type = "m.room.message";
        }
        const res = await this._client.sendEvent(this._roomId, type, content);
        if (type === REQUEST_TYPE) {
            this._requestEventId = res.event_id;
        }
    }
}
// ideally the verifier would be part of the VerificationRequest,
// or at least the scope of the verifier would be smaller
// but we need to know from the request when the verifier cancels,
// so we can clean up and update the UI.
// TBD if this will be needed
export class ProxyMedium {
    constructor(request, medium) {
        this._request = request;
        this._medium = medium;
    }

    // why did we need this again?
    get transactionId() {
        return this._medium.transactionId;
    }

    handleEvent(event, request) {
        return this._medium.handleEvent(event, request);
    }

    contentFromEventWithTxnId(event) {
        return this._medium.contentFromEventWithTxnId(event);
    }

    /* creates a content object with the transaction id added to it */
    contentWithTxnId(content) {
        return this._medium.contentWithTxnId(content);
    }

    async send(type, contentWithoutTxnId) {
        const result = await this._medium.send(type, contentWithoutTxnId);
        this._onSend(type, contentWithoutTxnId);
        return result;
    }

    async sendWithTxnId(type, content) {
        const result = await this._medium.sendWithTxnId(type, content);
        this._onSend(type, content);
        return result;
    }

    _onSend(type, content) {
        if (type === CANCEL_TYPE) {
            this._request._handleCancel(type);
        }
    }
}

const PHASE_UNSENT = 1;
const PHASE_REQUESTED = 2;
// const PHASE_ACCEPTED = 3;
const PHASE_STARTED = 4;
const PHASE_CANCELLED = 6;

// TODO: after doing request.medium.handleEvent(event, request)
// from crypto/index, we need to check whether it should be deleted from _verificationTransactions

// also !validateEvent, if it happens on a .request, ignore, otherwise, cancel

export class VerificationRequest extends EventEmitter {
    constructor(medium, verificationMethods) {
        super();
        this.medium = medium;
        this._verificationMethods = verificationMethods;
        this._commonMethods = [];
        this.phase = PHASE_UNSENT;
        // .request event from other side, only set if this is the receiving end.
        this._requestEvent = null;
    }

    static validateEvent(event, client) {
        const type = event.getType();
        const content = event.getContent();

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

    async beginKeyVerification(method) {
        if (
            this.phase === PHASE_REQUESTED &&
            this._commonMethods &&
            this._commonMethods.includes(method)
        ) {
            this._verifier = this._createVerifier(method);
            // to keep old api that returns verifier sync,
            // run send in fire and forget fashion for now
            (async () => {
                try {
                    await this.medium.send(START_TYPE, {method: method});
                } catch (err) {
                    logger.error("error sending " + START_TYPE, err);
                }
            })();
            this._setPhase(PHASE_STARTED);
            return this._verifier;
        }
    }

    async sendRequest() {
        if (this.phase === PHASE_UNSENT) {
            await this.medium.send(REQUEST_TYPE, {methods: this._methods});
            this._setPhase(PHASE_REQUESTED);
        }
    }

    async cancel({reason = "User declined", code = "m.user"}) {
        if (this.phase !== PHASE_CANCELLED) {
            await this.medium.send(CANCEL_TYPE, {code, reason});
            this._applyCancel();
        }
    }

    _applyCancel() {
        // TODO: also cancel verifier if one is present?
        if (this._verifier) {
            this._verifier.cancel();
        }
        this._setPhase(PHASE_CANCELLED);
    }

    _setPhase(phase) {
        this.phase = phase;
        this.emit("change");
    }

    handleEvent(type, event) {
        const content = event.getContent();
        if (type === REQUEST_TYPE) {
            this._handleRequest(content, event);
        } else if (type === START_TYPE) {
            this._handleStart(content, event);
        } else if (type === CANCEL_TYPE) {
            this._handleCancel();
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
    }

    async _handleRequest(content, event) {
        if (this.phase === PHASE_UNSENT) {
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
        if (this.phase === PHASE_REQUESTED ||
            (this._medium.requestIsOptional &&
                this.phase === PHASE_UNSENT)
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

    _handleCancel() {
        if (this.phase !== PHASE_CANCELLED) {
            this._applyCancel();
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
        const proxyMedium = new ProxyMedium(this, this._medium);
        return new VerifierCtor(
            proxyMedium,
            sender,
            device,
            startEvent,
        );
    }
}
