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
    ["☁️", "cloud"],       // 21
    ["🔥", "fire"],       // 22
    ["🍌", "banana"],     // 23
    ["🍎", "apple"],      // 24
    ["🍓", "strawberry"], // 25
    ["🌽", "corn"],       // 26
    ["🍕", "pizza"],      // 27
    ["🎂", "cake"],       // 28
    ["❤️", "heart"],      // 29
    ["🙂", "smiley"],      // 30
    ["🤖", "robot"],      // 31
    ["🎩", "hat"],        // 32
    ["👓", "glasses"],    // 33
    ["🔧", "spanner"],     // 34
    ["🎅", "santa"],      // 35
    ["👍", "thumbs up"],  // 36
    ["☂️", "umbrella"],    // 37
    ["⌛", "hourglass"],   // 38
    ["⏰", "clock"],      // 39
    ["🎁", "gift"],       // 40
    ["💡", "light bulb"], // 41
    ["📕", "book"],       // 42
    ["✏️", "pencil"],     // 43
    ["📎", "paperclip"],  // 44
    ["✂️", "scissors"],    // 45
    ["🔒", "padlock"],    // 46
    ["🔑", "key"],        // 47
    ["🔨", "hammer"],     // 48
    ["☎️", "telephone"],  // 49
    ["🏁", "flag"],       // 50
    ["🚂", "train"],      // 51
    ["🚲", "bicycle"],    // 52
    ["✈️", "aeroplane"],   // 53
    ["🚀", "rocket"],     // 54
    ["🏆", "trophy"],     // 55
    ["⚽", "ball"],       // 56
    ["🎸", "guitar"],     // 57
    ["🎺", "trumpet"],    // 58
    ["🔔", "bell"],       // 59
    ["⚓️", "anchor"],     // 60
    ["🎧", "headphones"], // 61
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

const sasGenerators = {
    decimal: generateDecimalSas,
    emoji: generateEmojiSas,
};

function generateSas(sasBytes, methods) {
    const sas = {};
    for (const method of methods) {
        if (method in sasGenerators) {
            sas[method] = sasGenerators[method](sasBytes);
        }
    }
    return sas;
}

const macMethods = {
    "hkdf-hmac-sha256": "calculate_mac",
    "hmac-sha256": "calculate_mac_long_kdf",
};

/* lists of algorithms/methods that are supported.  The key agreement, hashes,
 * and MAC lists should be sorted in order of preference (most preferred
 * first).
 */
const KEY_AGREEMENT_LIST = ["curve25519"];
const HASHES_LIST = ["sha256"];
const MAC_LIST = ["hkdf-hmac-sha256", "hmac-sha256"];
const SAS_LIST = Object.keys(sasGenerators);

const KEY_AGREEMENT_SET = new Set(KEY_AGREEMENT_LIST);
const HASHES_SET = new Set(HASHES_LIST);
const MAC_SET = new Set(MAC_LIST);
const SAS_SET = new Set(SAS_LIST);

function intersection(anArray, aSet) {
    return anArray instanceof Array ? anArray.filter(x => aSet.has(x)) : [];
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
            key_agreement_protocols: KEY_AGREEMENT_LIST,
            hashes: HASHES_LIST,
            message_authentication_codes: MAC_LIST,
            // FIXME: allow app to specify what SAS methods can be used
            short_authentication_string: SAS_LIST,
            transaction_id: this.transactionId,
        };
        this._sendToDevice("m.key.verification.start", initialMessage);


        let e = await this._waitForEvent("m.key.verification.accept");
        let content = e.getContent();
        const sasMethods
              = intersection(content.short_authentication_string, SAS_SET);
        if (!(KEY_AGREEMENT_SET.has(content.key_agreement_protocol)
              && HASHES_SET.has(content.hash)
              && MAC_SET.has(content.message_authentication_code)
              && sasMethods.length)) {
            throw newUnknownMethodError();
        }
        if (typeof content.commitment !== "string") {
            throw newInvalidMessageError();
        }
        const macMethod = content.message_authentication_code;
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
            // TODO: use selected hash function (when we support multiple)
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
                        this._sendMAC(olmSAS, macMethod);
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
            await this._checkMAC(olmSAS, content, macMethod);
        } finally {
            olmSAS.free();
        }
    }

    async _doRespondVerification() {
        let content = this.startEvent.getContent();
        // Note: we intersect using our pre-made lists, rather than the sets,
        // so that the result will be in our order of preference.  Then
        // fetching the first element from the array will give our preferred
        // method out of the ones offered by the other party.
        const keyAgreement
              = intersection(
                  KEY_AGREEMENT_LIST, new Set(content.key_agreement_protocols),
              )[0];
        const hashMethod
              = intersection(HASHES_LIST, new Set(content.hashes))[0];
        const macMethod
              = intersection(MAC_LIST, new Set(content.message_authentication_codes))[0];
        // FIXME: allow app to specify what SAS methods can be used
        const sasMethods
              = intersection(content.short_authentication_string, SAS_SET);
        if (!(keyAgreement !== undefined
              && hashMethod !== undefined
              && macMethod !== undefined
              && sasMethods.length)) {
            throw newUnknownMethodError();
        }

        const olmSAS = new global.Olm.SAS();
        try {
            const commitmentStr = olmSAS.get_pubkey() + anotherjson.stringify(content);
            this._sendToDevice("m.key.verification.accept", {
                key_agreement_protocol: keyAgreement,
                hash: hashMethod,
                message_authentication_code: macMethod,
                short_authentication_string: sasMethods,
                // TODO: use selected hash function (when we support multiple)
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
                        this._sendMAC(olmSAS, macMethod);
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
            await this._checkMAC(olmSAS, content, macMethod);
        } finally {
            olmSAS.free();
        }
    }

    _sendMAC(olmSAS, method) {
        const keyId = `ed25519:${this._baseApis.deviceId}`;
        const mac = {};
        const baseInfo = "MATRIX_KEY_VERIFICATION_MAC"
              + this._baseApis.getUserId() + this._baseApis.deviceId
              + this.userId + this.deviceId
              + this.transactionId;

        mac[keyId] = olmSAS[macMethods[method]](
            this._baseApis.getDeviceEd25519Key(),
            baseInfo + keyId,
        );
        const keys = olmSAS[macMethods[method]](
            keyId,
            baseInfo + "KEY_IDS",
        );
        this._sendToDevice("m.key.verification.mac", { mac, keys });
    }

    async _checkMAC(olmSAS, content, method) {
        const baseInfo = "MATRIX_KEY_VERIFICATION_MAC"
              + this.userId + this.deviceId
              + this._baseApis.getUserId() + this._baseApis.deviceId
              + this.transactionId;

        if (content.keys !== olmSAS[macMethods[method]](
            Object.keys(content.mac).sort().join(","),
            baseInfo + "KEY_IDS",
        )) {
            throw newKeyMismatchError();
        }

        await this._verifyKeys(this.userId, content.mac, (keyId, device, keyInfo) => {
            if (keyInfo !== olmSAS[macMethods[method]](
                device.keys[keyId],
                baseInfo + keyId,
            )) {
                throw newKeyMismatchError();
            }
        });
    }
}

SAS.NAME = "m.sas.v1";
