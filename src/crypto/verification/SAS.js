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
import anotherjson from 'another-json';
import {
    errorFactory,
    newUserCancelledError,
    newUnknownMethodError,
    newKeyMismatchError,
    newInvalidMessageError,
} from './Error';

const EVENTS = [
    "m.key.verification.accept",
    "m.key.verification.key",
    "m.key.verification.mac",
];

let olmutil;

const newMismatchedSASError = errorFactory(
    "m.mismatched_sas", "Mismatched short authentication string",
);

const newMismatchedCommitmentError = errorFactory(
    "m.mismatched_commitment", "Mismatched commitment",
);

/**
 * @class crypto/SAS/SASSend
 *
 * Used by the initiator of an SAS verification.
 */
export default class SAS extends Base {
    static factory(...args) {
        return new SASSend(...args);
    }

    get events() {
        return EVENTS;
    }

    async _doVerification() {
        await global.Olm.init();
        olmutil = olmutil || new global.Olm.Utility();

        if (this.startEvent) {
            return await this._doRespondVerification();
        } else {
            return await this._doSendVerification();
        }
    }

    async _doSendVerification() {
        // FIXME: make sure key is downloaded
        const device = await this._baseApis.getStoredDevice(this.userId, this.deviceId);

        const initialMessage = {
            method: SAS.NAME,
            from_device: this._baseApis.deviceId,
            key_agreement_protocols: ["curve25519"],
            hashes: ["sha256"],
            message_authentication_codes: ["hmac-sha256"],
            short_authentication_string: ["hex"],
            transaction_id: this.transactionId,
        };
        this._sendToDevice("m.key.verification.start", initialMessage);


        let e = await this._waitForEvent("m.key.verification.accept");
        let content = e.getContent();
        if (!(content.key_agreement_protocol === "curve25519"
              && content.hash === "sha256"
              && content.message_authentication_code === "hmac-sha256"
              && content.short_authentication_string instanceof Array
              && content.short_authentication_string.length === 1
              && content.short_authentication_string[0] === "hex")) {
            throw newUnknownMethodError();
        }
        const parameters = {
            hash: content.hash,
            mac: content.message_authentication_code,
            sas: content.short_authentication_string,
        };
        if (typeof content.commitment !== "string") {
            throw newInvalidMessageError();
        }
        const hashCommitment = content.commitment;
        const olmSAS = new global.Olm.SAS();
        try {
            this._sendToDevice("m.key.verification.key", {
                key: olmSAS.get_pubkey(),
            });


            e = await this._waitForEvent("m.key.verification.key");
            // FIXME: make sure event is properly formed
            content = e.getContent();
            const commitmentStr = content.key + anotherjson.stringify(initialMessage);
            if (olmutil.sha256(commitmentStr) !== hashCommitment) {
                throw newMismatchedCommitmentError();
            }
            olmSAS.set_their_key(content.key);

            const sasInfo = "MATRIX_KEY_VERIFICATION_SAS"
                  + this._baseApis.getUserId() + this._baseApis.deviceId
                  + this.userId + this.deviceId
                  + this.transactionId;
            const sas = olmSAS.generate_bytes(sasInfo, 5).reduce((acc, elem) => {
                return acc + ('0' + elem.toString(16)).slice(-2);
            }, "");
            const macInfo = "MATRIX_KEY_VERIFICATION_MAC"
                  + this._baseApis.getUserId() + this._baseApis.deviceId
                  + this.userId + this.deviceId
                  + this.transactionId;
            const verifySAS = new Promise((resolve, reject) => {
                const keyId = `ed25519:${this._baseApis.deviceId}`;
                const keyMac = olmSAS.calculate_mac(macInfo, this._baseApis.getDeviceEd25519Key());
                this.emit("show_sas", {
                    sas,
                    confirm: () => {
                        const mac = {[keyId]: keyMac};
                        this._sendToDevice("m.key.verification.mac", { mac });
                        resolve();
                    },
                    cancel: () => reject(newUserCancelledError()),
                    mismatch: () => reject(newMismatchedSASError()),
                });
            });


            [e] = await Promise.all([
                this._waitForEvent("m.key.verification.mac"),
                verifySAS,
            ]);
            content = e.getContent();
            await this._verifyKeys(this.userId, content.mac, (keyId, device, keyInfo) => {
                if (keyInfo !== olmSAS.calculate_mac(macInfo, device.keys[keyId])) {
                    throw newKeyMismatchError();
                }
            });
        } finally {
            olmSAS.free();
        }
    }

    async _doRespondVerification() {
        let content = this.startEvent.getContent();
        if (!(content.key_agreement_protocols instanceof Array
              && content.key_agreement_protocols.includes("curve25519")
              && content.hashes instanceof Array
              && content.hashes.includes("sha256")
              && content.message_authentication_codes instanceof Array
              && content.message_authentication_codes.includes("hmac-sha256")
              && content.short_authentication_string instanceof Array
              && content.short_authentication_string.includes("hex"))) {
            throw newUnknownMethodError();
        }

        // FIXME: make sure key is downloaded
        const device = await this._baseApis.getStoredDevice(this.userId, this.deviceId);

        const olmSAS = new global.Olm.SAS();
        try {
            const commitmentStr = olmSAS.get_pubkey() + anotherjson.stringify(content);
            this._sendToDevice("m.key.verification.accept", {
                key_agreement_protocol: "curve25519",
                hash: "sha256",
                message_authentication_code: "hmac-sha256",
                short_authentication_string: ["hex"],
                commitment: olmutil.sha256(commitmentStr),
            });


            let e = await this._waitForEvent("m.key.verification.key");
            // FIXME: make sure event is properly formed
            content = e.getContent();
            olmSAS.set_their_key(content.key);
            this._sendToDevice("m.key.verification.key", {
                key: olmSAS.get_pubkey(),
            });

            const sasInfo = "MATRIX_KEY_VERIFICATION_SAS"
                  + this.userId + this.deviceId
                  + this._baseApis.getUserId() + this._baseApis.deviceId
                  + this.transactionId;
            const sas = olmSAS.generate_bytes(sasInfo, 5).reduce((acc, elem) => {
                return acc + ('0' + elem.toString(16)).slice(-2);
            }, "");
            const macInfo = "MATRIX_KEY_VERIFICATION_MAC"
                  + this.userId + this.deviceId
                  + this._baseApis.getUserId() + this._baseApis.deviceId
                  + this.transactionId;
            const verifySAS = new Promise((resolve, reject) => {
                const keyId = `ed25519:${this._baseApis.deviceId}`;
                const keyMac = olmSAS.calculate_mac(macInfo, this._baseApis.getDeviceEd25519Key());
                this.emit("show_sas", {
                    sas,
                    confirm: () => {
                        const mac = {[keyId]: keyMac};
                        this._sendToDevice("m.key.verification.mac", { mac });
                        resolve();
                    },
                    cancel: () => reject(newUserCancelledError()),
                    mismatch: () => reject(newMismatchedSASError()),
                });
            });


            [e] = await Promise.all([
                this._waitForEvent("m.key.verification.mac"),
                verifySAS,
            ]);
            content = e.getContent();

            await this._verifyKeys(this.userId, content.mac, (keyId, device, keyInfo) => {
                if (keyInfo !== olmSAS.calculate_mac(macInfo, device.keys[keyId])) {
                    throw newKeyMismatchError();
                }
            });
        } finally {
            olmSAS.free();
        }
    }
}

SAS.NAME = "m.sas.v1";
