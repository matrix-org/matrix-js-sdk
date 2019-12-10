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

import VerificationRequest, {
    REQUEST_TYPE,
    READY_TYPE,
    START_TYPE,
} from "./VerificationRequest";
const MESSAGE_TYPE = "m.room.message";
const M_REFERENCE = "m.reference";
const M_RELATES_TO = "m.relates_to";

/**
 * A key verification channel that sends verification events in the timeline of a room.
 * Uses the event id of the initial m.key.verification.request event as a transaction id.
 */
export default class InRoomChannel {
    /**
     * @param {MatrixClient} client the matrix client, to send messages with and get current user & device from.
     * @param {string} roomId id of the room where verification events should be posted in, should be a DM with the given user.
     * @param {string} userId id of user that the verification request is directed at, should be present in the room.
     */
    constructor(client, roomId, userId) {
        this._client = client;
        this._roomId = roomId;
        this._userId = userId;
        this._requestEventId = null;
    }

    /** Whether this channel needs m.key.verification.done messages to be sent after a successful verification */
    get needsDoneMessage() {
        return true;
    }

    /** The transaction id generated/used by this verification channel */
    get transactionId() {
        return this._requestEventId;
    }

    /**
     * @param {MatrixEvent} event the event to get the timestamp of
     * @return {number} the timestamp when the event was sent
     */
    static getTimestamp(event) {
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
        if (type === REQUEST_TYPE) {
            if (typeof content.to !== "string" || !content.to.length) {
                return false;
            }
            const ownUserId = client.getUserId();
            // ignore requests that are not direct to or sent by the syncing user
            if (event.getSender() !== ownUserId && content.to !== ownUserId) {
                return false;
            }
        }

        return VerificationRequest.validateEvent(
            type, event, InRoomChannel.getTimestamp(event), client);
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
        return type;
    }

    /**
     * Changes the state of the channel, request, and verifier in response to a key verification event.
     * @param {MatrixEvent} event to handle
     * @param {VerificationRequest} request the request to forward handling to
     * @returns {Promise} a promise that resolves when any requests as an anwser to the passed-in event are sent.
     */
    async handleEvent(event, request) {
        const type = InRoomChannel.getEventType(event);
        // do validations that need state (roomId, userId),
        // ignore if invalid
        if (event.getRoomId() !== this._roomId || event.getSender() !== this._userId) {
            return;
        }
        // set transactionId when receiving a .request
        if (!this._requestEventId && type === REQUEST_TYPE) {
            this._requestEventId = event.getId();
        }

        return await request.handleEvent(type, event, InRoomChannel.getTimestamp(event));
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
                to: this._userId,
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
