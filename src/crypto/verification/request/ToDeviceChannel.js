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
import VerificationRequest, {
    PHASE_STARTED,
    REQUEST_TYPE,
    START_TYPE,
    CANCEL_TYPE,
} from "./VerificationRequest";

import {
    newUnexpectedMessageError,
    errorFromEvent,
} from "../Error";

export default class ToDeviceChannel {
    // userId and devices of user we're about to verify
    constructor(client, userId, devices, transactionId = null, deviceId = null) {
        this._client = client;
        this._userId = userId;
        this._devices = devices;
        this.transactionId = transactionId;
        this._deviceId = deviceId;
    }

    static getEventType(event) {
        return event.getType();
    }

    static getTransactionId(event) {
        const content = event.getContent();
        return content && content.transaction_id;
    }

    static canCreateRequest(type) {
        return type === REQUEST_TYPE || type === START_TYPE;
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

            if (event.getSender() === client.getUserId() &&
                    content.from_device == client.getDeviceId()
            ) {
                // ignore requests from ourselves, because it doesn't make sense for a
                // device to verify itself
                return false;
            }
        }

        return VerificationRequest.validateEvent(type, event, client);
    }

    async handleEvent(event, request) {
        const type = event.getType();
        const content = event.getContent();
        if (type === REQUEST_TYPE || type === START_TYPE) {
            if (!this.transactionId) {
                this.transactionId = content.transaction_id;
            }
            const deviceId = content.from_device;
            // adopt deviceId if not set before and valid
            if (!this._deviceId && this._devices.includes(deviceId)) {
                this._deviceId = deviceId;
            }
            // if no device id or different from addopted one, cancel with sender
            if (!this._deviceId || this._deviceId !== deviceId) {
                // also check that message came from the device we sent the request to earlier on
                // and do send a cancel message to that device
                // (but don't cancel the request for the device we should be talking to)
                const cancelContent =
                    this.completeContent(errorFromEvent(newUnexpectedMessageError()));
                return this._sendToDevices(CANCEL_TYPE, cancelContent, [deviceId]);
            }
        }

        const wasStarted = request.phase === PHASE_STARTED;
        await request.handleEvent(event.getType(), event);
        const isStarted = request.phase === PHASE_STARTED;

        // the request has picked a start event, tell the other devices about it
        if (type === START_TYPE && !wasStarted && isStarted && this._deviceId) {
            const nonChosenDevices = this._devices.filter(d => d !== this._deviceId);
            if (nonChosenDevices.length) {
                const message = this.completeContent({
                    code: "m.accepted",
                    reason: "Verification request accepted by another device",
                });
                await this._sendToDevices(CANCEL_TYPE, message, nonChosenDevices);
            }
        }
    }

    // SAS verification need the event as received
    // as a data-point to hash on both ends.
    // but we also don't want to modify the content argument in the send method
    // as it's unclear where fields get added from the verification code that way.
    // for this reason there is a completed content (as sent/received)
    // and uncompleted content, with only fields the VerificationRequest
    // and VerifierBase should care about to send.
    // This is put in the channel as some of these fields are different
    // for to_device and in-room verification
    completedContentFromEvent(event) {
        return event.getContent();
    }

    /* creates a content object with the transaction id added to it */
    completeContent(type, content) {
        // make a copy
        content = Object.assign({}, content);
        if (this.transactionId) {
            content.transaction_id = this.transactionId;
        }
        if (type === REQUEST_TYPE || type === START_TYPE) {
            content.from_device = this._client.getDeviceId();
        }
        if (type === REQUEST_TYPE) {
            content.timestamp = Date.now();
        }
        return content;
    }

    send(type, uncompletedContent = {}) {
        // create transaction id when sending request
        if ((type === REQUEST_TYPE || type === START_TYPE) && !this.transactionId) {
            this.transactionId = ToDeviceChannel.makeTransactionId();
        }
        const content = this.completeContent(type, uncompletedContent);
        return this.sendCompleted(type, content);
    }

    sendCompleted(type, content) {
        if (type === REQUEST_TYPE) {
            return this._sendToDevices(type, content, this._devices);
        } else {
            return this._sendToDevices(type, content, [this._deviceId]);
        }
    }

    _sendToDevices(type, content, devices) {
        if (devices.length) {
            const msgMap = {};
            for (const deviceId of devices) {
                msgMap[deviceId] = content;
            }

            return this._client.sendToDevice(type, {[this._userId]: msgMap});
        } else {
            return Promise.resolve();
        }
    }

    static makeTransactionId() {
        return randomString(32);
    }
}
