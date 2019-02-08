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
 * Short Authentication String (SAS) verification.
 * @module crypto/verification/SAS
 */

import Base from "./Base";
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

function generateDecimalSas(sasBytes) {
    /**
     *      +--------+--------+--------+--------+--------+
     *      | Byte 0 | Byte 1 | Byte 2 | Byte 3 | Byte 4 |
     *      +--------+--------+--------+--------+--------+
     * bits: 87654321 87654321 87654321 87654321 87654321
     *       \____________/\_____________/\____________/
     *         1st number    2nd number     3rd number
     */
    return [
        (sasBytes[0] << 5 | sasBytes[1] >> 3) + 1000,
        ((sasBytes[1] & 0x7) << 10 | sasBytes[2] << 2 | sasBytes[3] >> 6) + 1000,
        ((sasBytes[3] & 0x3f) << 7 | sasBytes[4] >> 1) + 1000,
    ];
}

const emojiMapping = [
    ["🐶", "dog"],        //  0
    ["🐱", "cat"],        //  1
    ["🦁", "lion"],       //  2
    ["🐎", "horse"],      //  3
    ["🦄", "unicorn"],    //  4
    ["🐷", "pig"],        //  5
    ["🐘", "elephant"],   //  6
    ["🐰", "rabbit"],     //  7
    ["🐼", "panda"],      //  8
    ["🐓", "rooster"],    //  9
    ["🐧", "penguin"],    // 10
    ["🐢", "turtle"],     // 11
    ["🐟", "fish"],       // 12
    ["🐙", "octopus"],    // 13
    ["🦋", "butterfly"],  // 14
    ["🌷", "flower"],     // 15
    ["🌳", "tree"],       // 16
    ["🌵", "cactus"],     // 17
    ["🍄", "mushroom"],   // 18
    ["🌏", "globe"],      // 19
    ["🌙", "moon"],       // 20
    ["☁", "cloud"],       // 21
    ["🔥", "fire"],       // 22
    ["🍌", "banana"],     // 23
    ["🍎", "apple"],      // 24
    ["🍓", "strawberry"], // 25
    ["🌽", "corn"],       // 26
    ["🍕", "pizza"],      // 27
    ["🎂", "cake"],       // 28
    ["❤", "heart"],      // 29
    ["☺", "smiley"],      // 30
    ["🤖", "robot"],      // 31
    ["🎩", "hat"],        // 32
    ["👓", "glasses"],    // 33
    ["🔧", "wrench"],     // 34
    ["🎅", "santa"],      // 35
    ["👍", "thumbs up"],  // 36
    ["☂", "umbrella"],    // 37
    ["⌛", "hourglass"],   // 38
    ["⏰", "clock"],      // 39
    ["🎁", "gift"],       // 40
    ["💡", "light bulb"], // 41
    ["📕", "book"],       // 42
    ["✏", "pencil"],     // 43
    ["📎", "paperclip"],  // 44
    ["✂", "scisors"],    // 45
    ["🔒", "lock"],       // 46
    ["🔑", "key"],        // 47
    ["🔨", "hammer"],     // 48
    ["☎", "telephone"],  // 49
    ["🏁", "flag"],       // 50
    ["🚂", "train"],      // 51
    ["🚲", "bicycle"],    // 52
    ["✈", "airplane"],   // 53
    ["🚀", "rocket"],     // 54
    ["🏆", "trophy"],     // 55
    ["⚽", "ball"],       // 56
    ["🎸", "guitar"],     // 57
    ["🎺", "trumpet"],    // 58
    ["🔔", "bell"],       // 59
    ["⚓", "anchor"],     // 60
    ["🎧", "headphone"],  // 61
    ["📁", "folder"],     // 62
    ["📌", "pin"],        // 63
];

function generateEmojiSas(sasBytes) {
    const emojis = [
        // just like base64 encoding
        sasBytes[0] >> 2,
        (sasBytes[0] & 0x3) << 4 | sasBytes[1] >> 4,
        (sasBytes[1] & 0xf) << 2 | sasBytes[2] >> 6,
        sasBytes[2] & 0x3f,
        sasBytes[3] >> 2,
        (sasBytes[3] & 0x3) << 4 | sasBytes[4] >> 4,
        (sasBytes[4] & 0xf) << 2 | sasBytes[5] >> 6,
    ];

    return emojis.map((num) => emojiMapping[num]);
}

function generateSas(sasBytes, methods) {
    const sas = {};
    if (methods.includes("decimal")) {
        sas["decimal"] = generateDecimalSas(sasBytes);
    }
    if (methods.includes("emoji")) {
        sas["emoji"] = generateEmojiSas(sasBytes);
    }
    return sas;
}

/**
 * @alias module:crypto/verification/SAS
 * @extends {module:crypto/verification/Base}
 */
export default class SAS extends Base {
    get events() {
        return EVENTS;
    }

    async _doVerification() {
        await global.Olm.init();
        olmutil = olmutil || new global.Olm.Utility();

        // make sure user's keys are downloaded
        await this._baseApis.downloadKeys([this.userId]);

        if (this.startEvent) {
            return await this._doRespondVerification();
        } else {
            return await this._doSendVerification();
        }
    }

    async _doSendVerification() {
        const initialMessage = {
            method: SAS.NAME,
            from_device: this._baseApis.deviceId,
            key_agreement_protocols: ["curve25519"],
            hashes: ["sha256"],
            message_authentication_codes: ["hmac-sha256"],
            // FIXME: allow app to specify what SAS methods can be used
            short_authentication_string: ["decimal", "emoji"],
            transaction_id: this.transactionId,
        };
        this._sendToDevice("m.key.verification.start", initialMessage);


        let e = await this._waitForEvent("m.key.verification.accept");
        let content = e.getContent();
        if (!(content.key_agreement_protocol === "curve25519"
              && content.hash === "sha256"
              && content.message_authentication_code === "hmac-sha256"
              && content.short_authentication_string instanceof Array
              && (content.short_authentication_string.includes("decimal")
                  || content.short_authentication_string.includes("emoji")))) {
            throw newUnknownMethodError();
        }
        if (typeof content.commitment !== "string") {
            throw newInvalidMessageError();
        }
        const hashCommitment = content.commitment;
        const sasMethods = content.short_authentication_string;
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
            const sasBytes = olmSAS.generate_bytes(sasInfo, 6);
            const verifySAS = new Promise((resolve, reject) => {
                this.emit("show_sas", {
                    sas: generateSas(sasBytes, sasMethods),
                    confirm: () => {
                        this._sendMAC(olmSAS);
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
            await this._checkMAC(olmSAS, content);
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
              && (content.short_authentication_string.includes("decimal")
                  || content.short_authentication_string.includes("emoji")))) {
            throw newUnknownMethodError();
        }

        const olmSAS = new global.Olm.SAS();
        const sasMethods = [];
        // FIXME: allow app to specify what SAS methods can be used
        if (content.short_authentication_string.includes("decimal")) {
            sasMethods.push("decimal");
        }
        if (content.short_authentication_string.includes("emoji")) {
            sasMethods.push("emoji");
        }
        try {
            const commitmentStr = olmSAS.get_pubkey() + anotherjson.stringify(content);
            this._sendToDevice("m.key.verification.accept", {
                key_agreement_protocol: "curve25519",
                hash: "sha256",
                message_authentication_code: "hmac-sha256",
                short_authentication_string: sasMethods,
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
            const sasBytes = olmSAS.generate_bytes(sasInfo, 6);
            const verifySAS = new Promise((resolve, reject) => {
                this.emit("show_sas", {
                    sas: generateSas(sasBytes, sasMethods),
                    confirm: () => {
                        this._sendMAC(olmSAS);
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
            await this._checkMAC(olmSAS, content);
        } finally {
            olmSAS.free();
        }
    }

    _sendMAC(olmSAS) {
        const keyId = `ed25519:${this._baseApis.deviceId}`;
        const mac = {};
        const baseInfo = "MATRIX_KEY_VERIFICATION_MAC"
              + this._baseApis.getUserId() + this._baseApis.deviceId
              + this.userId + this.deviceId
              + this.transactionId;

        mac[keyId] = olmSAS.calculate_mac(
            this._baseApis.getDeviceEd25519Key(),
            baseInfo + keyId,
        );
        const keys = olmSAS.calculate_mac(
            keyId,
            baseInfo + "KEY_IDS",
        );
        this._sendToDevice("m.key.verification.mac", { mac, keys });
    }

    async _checkMAC(olmSAS, content) {
        const baseInfo = "MATRIX_KEY_VERIFICATION_MAC"
              + this.userId + this.deviceId
              + this._baseApis.getUserId() + this._baseApis.deviceId
              + this.transactionId;

        if (content.keys !== olmSAS.calculate_mac(
            Object.keys(content.mac).sort().join(","),
            baseInfo + "KEY_IDS",
        )) {
            throw newKeyMismatchError();
        }

        await this._verifyKeys(this.userId, content.mac, (keyId, device, keyInfo) => {
            if (keyInfo !== olmSAS.calculate_mac(
                device.keys[keyId],
                baseInfo + keyId,
            )) {
                throw newKeyMismatchError();
            }
        });
    }
}

SAS.NAME = "m.sas.v1";
