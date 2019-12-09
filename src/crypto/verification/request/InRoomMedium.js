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

import VerificationRequest, {REQUEST_TYPE, START_TYPE} from "./VerificationRequest";
const MESSAGE_TYPE = "m.room.message";

export default class InRoomMedium {
    constructor(client, roomId, userId) {
        this._client = client;
        this._roomId = roomId;
        this._userId = userId;
        this._requestEventId = null;
    }

    get needsDoneMessage() {
        return true;
    }

    // why did we need this again?
    // to get the transaction id for the verifier ...
    // but we shouldn't need it anymore since it is only used
    // for sending there which will now happen through the medium
    get transactionId() {
        return this._requestEventId;
    }

    static canCreateRequest(type) {
        return type === REQUEST_TYPE;
    }

    static getTransactionId(event) {
        if (InRoomMedium.getEventType(event) === REQUEST_TYPE) {
            return event.getId();
        } else {
            const relation = event.getRelation();
            if (relation && relation.rel_type === "m.reference") {
                return relation.event_id;
            }
        }
    }

    static validateEvent(event, client) {
        const txnId = InRoomMedium.getTransactionId(event);
        if (typeof txnId !== "string" || txnId.length === 0) {
            return false;
        }
        const type = InRoomMedium.getEventType(event);
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

        return VerificationRequest.validateEvent(type, event, client);
    }

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

    async handleEvent(event, request) {
        // TODO: verify that event is not sent by anyone but me or other user
        const type = InRoomMedium.getEventType(event);
        // do validations that need state (roomId, userId),
        // ignore if invalid
        if (event.getRoomId() !== this._roomId || event.getSender() !== this._userId) {
            return;
        }
        // set transactionId when receiving a .request
        if (!this._requestEventId && type === REQUEST_TYPE) {
            this._requestEventId = event.getId();
        }

        return await request.handleEvent(type, event);
    }

    completedContentFromEvent(event) {
        // ensure m.related_to is included in e2ee rooms
        // as the field is excluded from encryption
        const content = Object.assign({}, event.getContent());
        content["m.relates_to"] = event.getRelation();
        return content;
    }

    /* creates a content object with the transaction id added to it */
    completeContent(type, content) {
        content = Object.assign({}, content);
        if (type === REQUEST_TYPE || type === START_TYPE) {
            content.from_device = this._client.getDeviceId();
        }
        if (type === REQUEST_TYPE) {
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
            content["m.relates_to"] = {
                rel_type: "m.reference",
                event_id: this.transactionId,
            };
        }
        return content;
    }

    send(type, uncompletedContent) {
        const content = this.completeContent(type, uncompletedContent);
        return this.sendCompleted(type, content);
    }

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
