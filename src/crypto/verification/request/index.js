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

function verifType(subtype) {
    return `m.key.verification.${subtype}`;
}

export class ToDeviceMedium {
    constructor(client, userId, devices) {
        this._client = client;
        this._userId = userId;
        this._devices = devices;
        this.transactionId = null;
    }

    handleEvent(event, request) {

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
        if (type === verifType("request")) {
            this.transactionId = randomString(32);
        }
        const content = this.contentWithTxnId(contentWithoutTxnId);
        return this.sendWithTxnId(type, content);
    }

    sendWithTxnId(type, content) {
        if (type === verifType("request")) {
            content.from_device = this._client.getDeviceId();
        }
        content.timestamp = Date.now();

        const msgMap = {};
        for (const deviceId of this._devices) {
            msgMap[deviceId] = content;
        }

        this._client.sendToDevice(type, {[this.userId]: msgMap});
    }
}

export class InRoomMedium {
    constructor(client, roomId, userId, requestEventId = null) {
        this._client = client;
        this._roomId = roomId;
        this._userId = userId;
        this._requestEventId = requestEventId;
    }

    handleEvent(event, request) {

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
        if (type === verifType("request")) {
            content = {
                body: this._baseApis.getUserId() + " is requesting to verify " +
                    "your key, but your client does not support in-chat key " +
                    "verification.  You will need to use legacy key " +
                    "verification to verify keys.",
                msgtype: verifType("request"),
                to: this._userId,
                from_device: this._client.getDeviceId(),
                methods: content.methods,
            };
            type = "m.room.message";
        }
        const res = await this._client.sendEvent(this._roomId, type, content);
        if (type === verifType("request")) {
            this._requestEventId = res.event_id;
        }
    }
}

const PHASE_UNSENT = 1;
const PHASE_REQUESTED = 2;
const PHASE_ACCEPTED = 3;
const PHASE_STARTED = 4;
const PHASE_DONE = 5;
const PHASE_CANCELLED = 6;

export class VerificationRequest extends EventEmitter {
    constructor(medium, methods) {
        super();
        this.phase = PHASE_UNSENT;
    }

    _setPhase(phase) {
        this.phase = phase;
        this.emit("change");
    }

    handleEvent(type, content) {
        if (type === verifType("request")) {
            this._setPhase(PHASE_REQUESTED);
        } else if (type === verifType("accept")) {
            // determine common methods
        } else if (type === verifType("start")) {
            // pick method, confirm we support it
            // create verifier
        }

        if (type.startsWith(verifType("")) && this._verifier) {
            this._verifier.handleEvent();
        }
    }

    async sendRequest() {
        if (this.phase === PHASE_UNSENT) {
            await this._medium.send(verifType("request"), {methods: this._methods});
            this._setPhase(PHASE_REQUESTED);
        }
    }

    async cancel(code = "m.unknown", reason = "User declined") {
        if (this.phase !== PHASE_CANCELLED) {
            await this._medium.send(verifType("cancel"), {code, reason});
            this._setPhase(PHASE_CANCELLED);
        }
    }

    beginKeyVerification(method) {

    }
}
