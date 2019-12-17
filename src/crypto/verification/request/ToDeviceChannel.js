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

import {randomString} from '../../../randomstring';
import {logger} from '../../../logger';
import {CANCEL_TYPE, PHASE_STARTED, REQUEST_TYPE, START_TYPE, VerificationRequest} from "./VerificationRequest";
import {errorFromEvent, newUnexpectedMessageError} from "../Error";

/**
 * A key verification channel that sends verification events over to_device messages.
 * Generates its own transaction ids.
 */
export class ToDeviceChannel {
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

    /**
     * Extract the transaction id used by a given key verification event, if any
     * @param {MatrixEvent} event the event
     * @returns {string} the transaction id
     */
    static getTransactionId(event) {
        const content = event.getContent();
        return content && content.transaction_id;
    }

    /**
     * Checks whether the given event type should be allowed to initiate a new VerificationRequest over this channel
     * @param {string} type the event type to check
     * @returns {bool} boolean flag
     */
    static canCreateRequest(type) {
        return type === REQUEST_TYPE || type === START_TYPE;
    }

    /**
     * Checks whether this event is a well-formed key verification event.
     * This only does checks that don't rely on the current state of a potentially already channel
     * so we can prevent channels being created by invalid events.
     * `handleEvent` can do more checks and choose to ignore invalid events.
     * @param {MatrixEvent} event the event to validate
     * @param {MatrixClient} client the client to get the current user and device id from
     * @returns {bool} whether the event is valid and should be passed to handleEvent
     */
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
            if (event.getSender() === client.getUserId() &&
                    content.from_device == client.getDeviceId()
            ) {
                // ignore requests from ourselves, because it doesn't make sense for a
                // device to verify itself
                return false;
            }
        }

        return VerificationRequest.validateEvent(
            type, event, ToDeviceChannel.getTimestamp(event), client);
    }

    /**
     * @param {MatrixEvent} event the event to get the timestamp of
     * @return {number} the timestamp when the event was sent
     */
    static getTimestamp(event) {
        const content = event.getContent();
        return content && content.timestamp;
    }

    /**
     * Changes the state of the channel, request, and verifier in response to a key verification event.
     * @param {MatrixEvent} event to handle
     * @param {VerificationRequest} request the request to forward handling to
     * @returns {Promise} a promise that resolves when any requests as an anwser to the passed-in event are sent.
     */
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
        await request.handleEvent(
            event.getType(), event, ToDeviceChannel.getTimestamp(event));
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

    /**
     * See {InRoomChannel.completedContentFromEvent} why this is needed.
     * @param {MatrixEvent} event the received event
     * @returns {Object} the content object
     */
    completedContentFromEvent(event) {
        return event.getContent();
    }

    /**
     * Add all the fields to content needed for sending it over this channel.
     * This is public so verification methods (SAS uses this) can get the exact
     * content that will be sent independent of the used channel,
     * as they need to calculate the hash of it.
     * @param {string} type the event type
     * @param {object} content the (incomplete) content
     * @returns {object} the complete content, as it will be sent.
     */
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

    /**
     * Send an event over the channel with the content not having gone through `completeContent`.
     * @param {string} type the event type
     * @param {object} uncompletedContent the (incomplete) content
     * @returns {Promise} the promise of the request
     */
    send(type, uncompletedContent = {}) {
        // create transaction id when sending request
        if ((type === REQUEST_TYPE || type === START_TYPE) && !this.transactionId) {
            this.transactionId = ToDeviceChannel.makeTransactionId();
        }
        const content = this.completeContent(type, uncompletedContent);
        return this.sendCompleted(type, content);
    }

    /**
     * Send an event over the channel with the content having gone through `completeContent` already.
     * @param {string} type the event type
     * @param {object} content
     * @returns {Promise} the promise of the request
     */
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

    /**
     * Allow Crypto module to create and know the transaction id before the .start event gets sent.
     * @returns {string} the transaction id
     */
    static makeTransactionId() {
        return randomString(32);
    }
}
