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

import {
    VerificationRequest,
    REQUEST_TYPE,
    READY_TYPE,
    START_TYPE,
} from "./VerificationRequest";
import {logger} from '../../../logger';

const MESSAGE_TYPE = "m.room.message";
const M_REFERENCE = "m.reference";
const M_RELATES_TO = "m.relates_to";

/**
 * A key verification channel that sends verification events in the timeline of a room.
 * Uses the event id of the initial m.key.verification.request event as a transaction id.
 */
export class InRoomChannel {
    /**
     * @param {MatrixClient} client the matrix client, to send messages with and get current user & device from.
     * @param {string} roomId id of the room where verification events should be posted in, should be a DM with the given user.
     * @param {string} userId id of user that the verification request is directed at, should be present in the room.
     */
    constructor(client, roomId, userId = null) {
        this._client = client;
        this._roomId = roomId;
        this.userId = userId;
        this._requestEventId = null;
    }

    get receiveStartFromOtherDevices() {
        return true;
    }

    get roomId() {
        return this._roomId;
    }

    /** The transaction id generated/used by this verification channel */
    get transactionId() {
        return this._requestEventId;
    }

    static getOtherPartyUserId(event, client) {
        const type = InRoomChannel.getEventType(event);
        if (type !== REQUEST_TYPE) {
           return;
        }
        const ownUserId = client.getUserId();
        const sender = event.getSender();
        const content = event.getContent();
        const receiver = content.to;

        if (sender === ownUserId) {
            return receiver;
        } else if (receiver === ownUserId) {
            return sender;
        }
    }

    /**
     * @param {MatrixEvent} event the event to get the timestamp of
     * @return {number} the timestamp when the event was sent
     */
    getTimestamp(event) {
        return event.getTs();
    }

    /**
     * Checks whether the given event type should be allowed to initiate a new VerificationRequest over this channel
     * @param {string} type the event type to check
     * @returns {bool} boolean flag
     */
    static canCreateRequest(type) {
        return type === REQUEST_TYPE;
    }

    /**
     * Extract the transaction id used by a given key verification event, if any
     * @param {MatrixEvent} event the event
     * @returns {string} the transaction id
     */
    static getTransactionId(event) {
        if (InRoomChannel.getEventType(event) === REQUEST_TYPE) {
            return event.getId();
        } else {
            const relation = event.getRelation();
            if (relation && relation.rel_type === M_REFERENCE) {
                return relation.event_id;
            }
        }
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
        const txnId = InRoomChannel.getTransactionId(event);
        if (typeof txnId !== "string" || txnId.length === 0) {
            return false;
        }
        const type = InRoomChannel.getEventType(event);
        const content = event.getContent();

        // from here on we're fairly sure that this is supposed to be
        // part of a verification request, so be noisy when rejecting something
        if (type === REQUEST_TYPE) {
            if (!content || typeof content.to !== "string" || !content.to.length) {
                logger.log("InRoomChannel: validateEvent: " +
                    "no valid to " + (content && content.to));
                return false;
            }

            // ignore requests that are not direct to or sent by the syncing user
            if (!InRoomChannel.getOtherPartyUserId(event, client)) {
                logger.log("InRoomChannel: validateEvent: " +
                    `not directed to or sent by me: ${event.getSender()}` +
                    `, ${content && content.to}`);
                return false;
            }
        }

        return VerificationRequest.validateEvent(type, event, client);
    }

    /**
     * As m.key.verification.request events are as m.room.message events with the InRoomChannel
     * to have a fallback message in non-supporting clients, we map the real event type
     * to the symbolic one to keep things in unison with ToDeviceChannel
     * @param {MatrixEvent} event the event to get the type of
     * @returns {string} the "symbolic" event type
     */
    static getEventType(event) {
        const type = event.getType();
        if (type === MESSAGE_TYPE) {
            const content = event.getContent();
            if (content) {
                const {msgtype} = content;
                if (msgtype === REQUEST_TYPE) {
                    return REQUEST_TYPE;
                }
            }
        }
        if (type && type !== REQUEST_TYPE) {
            return type;
        } else {
            return "";
        }
    }

    /**
     * Changes the state of the channel, request, and verifier in response to a key verification event.
     * @param {MatrixEvent} event to handle
     * @param {VerificationRequest} request the request to forward handling to
     * @param {bool} isLiveEvent whether this is an even received through sync or not
     * @returns {Promise} a promise that resolves when any requests as an anwser to the passed-in event are sent.
     */
    async handleEvent(event, request, isLiveEvent) {
        // prevent processing the same event multiple times, as under
        // some circumstances Room.timeline can get emitted twice for the same event
        if (request.hasEventId(event.getId())) {
            return;
        }
        const type = InRoomChannel.getEventType(event);
        // do validations that need state (roomId, userId),
        // ignore if invalid

        if (event.getRoomId() !== this._roomId) {
            return;
        }
        // set userId if not set already
        if (this.userId === null) {
            const userId = InRoomChannel.getOtherPartyUserId(event, this._client);
            if (userId) {
                this.userId = userId;
            }
        }
        // ignore events not sent by us or the other party
        const ownUserId = this._client.getUserId();
        const sender = event.getSender();
        if (this.userId !== null) {
            if (sender !== ownUserId && sender !== this.userId) {
                logger.log(`InRoomChannel: ignoring verification event from ` +
                    `non-participating sender ${sender}`);
                return;
            }
        }
        if (this._requestEventId === null) {
            this._requestEventId = InRoomChannel.getTransactionId(event);
        }

        const isRemoteEcho = !!event.getUnsigned().transaction_id;
        const isSentByUs = event.getSender() === this._client.getUserId();

        return await request.handleEvent(
            type, event, isLiveEvent, isRemoteEcho, isSentByUs);
    }

    /**
     * Adds the transaction id (relation) back to a received event
     * so it has the same format as returned by `completeContent` before sending.
     * The relation can not appear on the event content because of encryption,
     * relations are excluded from encryption.
     * @param {MatrixEvent} event the received event
     * @returns {Object} the content object with the relation added again
     */
    completedContentFromEvent(event) {
        // ensure m.related_to is included in e2ee rooms
        // as the field is excluded from encryption
        const content = Object.assign({}, event.getContent());
        content[M_RELATES_TO] = event.getRelation();
        return content;
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
        content = Object.assign({}, content);
        if (type === REQUEST_TYPE || type === READY_TYPE || type === START_TYPE) {
            content.from_device = this._client.getDeviceId();
        }
        if (type === REQUEST_TYPE) {
            // type is mapped to m.room.message in the send method
            content = {
                body: this._client.getUserId() + " is requesting to verify " +
                    "your key, but your client does not support in-chat key " +
                    "verification.  You will need to use legacy key " +
                    "verification to verify keys.",
                msgtype: REQUEST_TYPE,
                to: this.userId,
                from_device: content.from_device,
                methods: content.methods,
            };
        } else {
            content[M_RELATES_TO] = {
                rel_type: M_REFERENCE,
                event_id: this.transactionId,
            };
        }
        return content;
    }

    /**
     * Send an event over the channel with the content not having gone through `completeContent`.
     * @param {string} type the event type
     * @param {object} uncompletedContent the (incomplete) content
     * @returns {Promise} the promise of the request
     */
    send(type, uncompletedContent) {
        const content = this.completeContent(type, uncompletedContent);
        return this.sendCompleted(type, content);
    }

    /**
     * Send an event over the channel with the content having gone through `completeContent` already.
     * @param {string} type the event type
     * @param {object} content
     * @returns {Promise} the promise of the request
     */
    async sendCompleted(type, content) {
        let sendType = type;
        if (type === REQUEST_TYPE) {
            sendType = MESSAGE_TYPE;
        }
        const response = await this._client.sendEvent(this._roomId, sendType, content);
        if (type === REQUEST_TYPE) {
            this._requestEventId = response.event_id;
        }
    }
}

export class InRoomRequests {
    constructor() {
        this._requestsByRoomId = new Map();
    }

    getRequest(event) {
        const roomId = event.getRoomId();
        const txnId = InRoomChannel.getTransactionId(event);
        return this._getRequestByTxnId(roomId, txnId);
    }

    getRequestByChannel(channel) {
        return this._getRequestByTxnId(channel.roomId, channel.transactionId);
    }

    _getRequestByTxnId(roomId, txnId) {
        const requestsByTxnId = this._requestsByRoomId.get(roomId);
        if (requestsByTxnId) {
            return requestsByTxnId.get(txnId);
        }
    }

    setRequest(event, request) {
        this._setRequest(
            event.getRoomId(),
            InRoomChannel.getTransactionId(event),
            request,
        );
    }

    setRequestByChannel(channel, request) {
        this._setRequest(channel.roomId, channel.transactionId, request);
    }

    _setRequest(roomId, txnId, request) {
        let requestsByTxnId = this._requestsByRoomId.get(roomId);
        if (!requestsByTxnId) {
            requestsByTxnId = new Map();
            this._requestsByRoomId.set(roomId, requestsByTxnId);
        }
        requestsByTxnId.set(txnId, request);
    }

    removeRequest(event) {
        const roomId = event.getRoomId();
        const requestsByTxnId = this._requestsByRoomId.get(roomId);
        if (requestsByTxnId) {
            requestsByTxnId.delete(InRoomChannel.getTransactionId(event));
            if (requestsByTxnId.size === 0) {
                this._requestsByRoomId.delete(roomId);
            }
        }
    }

    findRequestInProgress(roomId) {
        const requestsByTxnId = this._requestsByRoomId.get(roomId);
        if (requestsByTxnId) {
            for (const request of requestsByTxnId.values()) {
                if (request.pending) {
                    return request;
                }
            }
        }
    }
}
