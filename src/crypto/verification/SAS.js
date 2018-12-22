/*
Copyright 2018 New Vector Ltd

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

/**
 * @module crypto/SAS
 *
 * Key verification request.
 */

import Base from "./Base";
import logger from '../../logger';

const EVENTS = [
    "m.key.verification.accept",
    "m.key.verification.key",
    "m.key.verification.mac",
];

let olmutil;

/**
 * @class crypto/SAS/SASSend
 *
 * Used by the initiator of an SAS verification.
 */
export class SASSend extends Base {
    static factory(...args) {
        return new SASSend(...args);
    }

    get events() {
        return EVENTS;
    }

    async verify() {
        if (this._started) {
            return this._promise;
        }
        this._started = true;

        await global.Olm.init();
        olmutil = new global.Olm.Utility();

        // FIXME: make sure key is downloaded
        this.device = await this._baseApis.getStoredDevice(this.userId, this.deviceId);

        this._expectEvent("m.key.verification.accept", this._handleAccept);
        this._sendToDevice("m.key.verification.start", {
            method: 'm.key.verification.sas',
            from_device: this._baseApis.deviceId,
            key_agreement_protocols: ["curve25519"],
            hashes: ["sha256"],
            message_authentication_codes: ["hmac-sha256"],
            short_authentication_string: ["hex"],
        });
        await this._promise;
    }

    _handleAccept(e) {
        const content = e.getContent();
        if (!(content.key_agreement_protocol === "curve25519"
              && content.hash === "sha256"
              && content.message_authentication_code === "hmac-sha256"
              && content.short_authentication_string instanceof Array
              && content.short_authentication_string.length === 1
              && content.short_authentication_string[0] === "hex")) {
            return this.cancel(new Error("Unknown method"));
        }
        this._parameters = {
            hash: content.hash,
            mac: content.message_authentication_code,
            sas: content.short_authentication_string,
        };
        if (typeof content.commitment !== "string") {
            return this.cancel(new Error("Malformed event"));
        }
        this._hash_commitment = content.commitment;
        this._key = "abcdefg";
        this._expectEvent("m.key.verification.key", this._handleKey);
        this._sendToDevice("m.key.verification.key", {
            key: this._key,
        });
    }

    // FIXME: make sure event is properly formed
    async _handleKey(e) {
        const content = e.getContent();
        if (olmutil.sha256(content.key) !== this._hash_commitment) {
            console.log("commitment mismatch");
            return this.cancel(new Error("Commitment mismatch"));
        }
        this._other_key = content.key;
        this._expectEvent("m.key.verification.mac", this._handleMac);
        const sas = "hijklmn";
        this.emit("show_sas", {
            sas,
            confirm: this._sasMatch.bind(this),
        });
    }

    _sasMatch() {
        if (this._done) {
            return;
        }
        const mac = {["ed25519:" + this._baseApis.deviceId]: "opqrstu"};
        this._sendToDevice("m.key.verification.mac", { mac });
        if (this._other_mac) {
            return this._verifyMACs(this._other_mac);
        } else {
            // haven't received the MAC from the other side yet.  Remember that
            // the SAS matches, and wait.
            this._match = true;
        }
    }

    _handleMac(e) {
        const content = e.getContent();
        this._expectEvent(); // don't expect anything else
        if (this._match) {
            return this._verifyMACs(content.mac);
        } else {
            // user has not said whether the SAS matches yet.  Remember the MAC
            // and wait.
            this._other_mac = content.mac;
        }
    }

    async _verifyMACs(mac) {
        const device = this.device;
        for (const [keyId, keyMAC] of Object.entries(mac)) {
            if (keyMAC !== "opqrstu") {
                return this.cancel(new Error("Keys did not match"));
            }
        }
        await this._baseApis.setDeviceVerified(this.userId, this.deviceId);
        this.done();
    }
}

SASSend.NAME = "org.matrix._internal.sas";

/**
 * @class crypto/SAS/SASReceive
 *
 * Used by the responder of an SAS verification.
 */
export class SASReceive extends Base {
    static factory(...args) {
        return new SASSend(...args);
    }

    get events() {
        return EVENTS;
    }

    async verify() {
        if (this._started) {
            return this._promise;
        }
        this._started = true;

        if (!this.startEvent) {
            this.cancel(new Error(
                "SASReceive must only be created in response to an event",
            ));
            return await this._promise;
        }

        await global.Olm.init();
        olmutil = new global.Olm.Utility();

        const content = this.startEvent.getContent();
        if (!(content.key_agreement_protocols instanceof Array
              && content.key_agreement_protocols.includes("curve25519")
              && content.hashes instanceof Array
              && content.hashes.includes("sha256")
              && content.message_authentication_codes instanceof Array
              && content.message_authentication_codes.includes("hmac-sha256")
              && content.short_authentication_string instanceof Array
              && content.short_authentication_string.includes("hex"))) {
            this.cancel(new Error("Unknown method"));
            return await this._promise;
        }

        // FIXME: make sure key is downloaded
        this.device = await this._baseApis.getStoredDevice(this.userId, this.deviceId);

        this._expectEvent("m.key.verification.key", this._handleKey);
        this._key = "abcdefg";
        this._sendToDevice("m.key.verification.accept", {
            key_agreement_protocol: "curve25519",
            hash: "sha256",
            message_authentication_code: "hmac-sha256",
            short_authentication_string: ["hex"],
            commitment: olmutil.sha256(this._key),
        });
        await this._promise;
    }

    // FIXME: make sure event is properly formed
    _handleKey(e) {
        const content = e.getContent();
        this._other_key = content.key;
        this._expectEvent("m.key.verification.mac", this._handleMac);
        this._sendToDevice("m.key.verification.key", {
            key: this._key,
        });
        const sas = "hijklmn";
        this.emit("show_sas", {
            sas,
            confirm: this._sasMatch.bind(this),
        });
    }
}

SASReceive.prototype._handleMac = SASSend.prototype._handleMac;
SASReceive.prototype._sasMatch = SASSend.prototype._sasMatch;
SASReceive.prototype._verifyMACs = SASSend.prototype._verifyMACs;

SASReceive.NAME = "m.sas.v1";
