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
