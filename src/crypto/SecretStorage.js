/*
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

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

import {EventEmitter} from 'events';
import {logger} from '../logger';
import * as olmlib from './olmlib';
import {pkVerify} from './olmlib';
import {randomString} from '../randomstring';
import {decodeBase64, encodeBase64} from './olmlib';
import {getCrypto} from '../utils';

export const SECRET_STORAGE_ALGORITHM_V1_AES
    = "m.secret_storage.v1.aes-hmac-sha2";
// don't use curve25519 for writing data.
export const SECRET_STORAGE_ALGORITHM_V1_CURVE25519
    = "m.secret_storage.v1.curve25519-aes-sha2";

const subtleCrypto = typeof window === "undefined" ? null :
    (window.crypto.subtle || window.crypto.webkitSubtle);

// salt for HKDF, with 8 bytes of zeros
const zerosalt = new Uint8Array(8);

/** encrypt a string in Node.js
 *
 * @param {string} data the plaintext to encrypt
 * @param {Uint8Array} key the encryption key to use
 * @param {string} name the name of the secret
 */
async function encryptNode(data, key, name) {
    const crypto = getCrypto();
    if (!crypto) {
        throw new Error("No usable crypto implementation");
    }

    const iv = crypto.randomBytes(16);

    // clear bit 63 of the IV to stop us hitting the 64-bit counter boundary
    // (which would mean we wouldn't be able to decrypt on Android). The loss
    // of a single bit of iv is a price we have to pay.
    iv[8] &= 0x7f;

    const [aesKey, hmacKey] = deriveKeysNode(key, name);

    const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
    const ciphertext = cipher.update(data, "utf-8", "base64")
          + cipher.final("base64");

    const hmac = crypto.createHmac("sha256", hmacKey)
        .update(ciphertext, "base64").digest("base64");

    return {
        iv: encodeBase64(iv),
        ciphertext: ciphertext,
        mac: hmac,
    };
}

/** decrypt a string in Node.js
 *
 * @param {object} data the encrypted data
 * @param {string} data.ciphertext the ciphertext in base64
 * @param {string} data.iv the initialization vector in base64
 * @param {string} data.mac the HMAC in base64
 * @param {Uint8Array} key the encryption key to use
 * @param {string} name the name of the secret
 */
async function decryptNode(data, key, name) {
    const crypto = getCrypto();
    if (!crypto) {
        throw new Error("No usable crypto implementation");
    }

    const [aesKey, hmacKey] = deriveKeysNode(key, name);

    const hmac = crypto.createHmac("sha256", hmacKey)
        .update(data.ciphertext, "base64").digest("base64");

    if (hmac !== data.mac) {
        throw new Error(`Error decrypting secret ${name}: bad MAC`);
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-ctr", aesKey, decodeBase64(data.iv),
    );
    return decipher.update(data.ciphertext, "base64", "utf-8")
          + decipher.final("utf-8");
}

function deriveKeysNode(key, name) {
    const crypto = getCrypto();
    const prk = crypto.createHmac("sha256", zerosalt)
        .update(key).digest();

    const b = Buffer.alloc(1, 1);
    const aesKey = crypto.createHmac("sha256", prk)
        .update(name, "utf-8").update(b).digest();
    b[0] = 2;
    const hmacKey = crypto.createHmac("sha256", prk)
        .update(aesKey).update(name, "utf-8").update(b).digest();

    return [aesKey, hmacKey];
}

/** encrypt a string in Node.js
 *
 * @param {string} data the plaintext to encrypt
 * @param {Uint8Array} key the encryption key to use
 * @param {string} name the name of the secret
 */
async function encryptBrowser(data, key, name) {
    const iv = new Uint8Array(16);
    window.crypto.getRandomValues(iv);

    // clear bit 63 of the IV to stop us hitting the 64-bit counter boundary
    // (which would mean we wouldn't be able to decrypt on Android). The loss
    // of a single bit of iv is a price we have to pay.
    iv[8] &= 0x7f;

    const [aesKey, hmacKey] = await deriveKeysBrowser(key, name);
    const encodedData = new TextEncoder().encode(data);

    const ciphertext = await subtleCrypto.encrypt(
        {
            name: "AES-CTR",
            counter: iv,
            length: 64,
        },
        aesKey,
        encodedData,
    );

    const hmac = await subtleCrypto.sign(
        {name: 'HMAC'},
        hmacKey,
        ciphertext,
    );

    return {
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(ciphertext),
        mac: encodeBase64(hmac),
    };
}

/** decrypt a string in the browser
 *
 * @param {object} data the encrypted data
 * @param {string} data.ciphertext the ciphertext in base64
 * @param {string} data.iv the initialization vector in base64
 * @param {string} data.mac the HMAC in base64
 * @param {Uint8Array} key the encryption key to use
 * @param {string} name the name of the secret
 */
async function decryptBrowser(data, key, name) {
    const [aesKey, hmacKey] = await deriveKeysBrowser(key, name);

    const ciphertext = decodeBase64(data.ciphertext);

    if (!await subtleCrypto.verify(
        {name: "HMAC"},
        hmacKey,
        decodeBase64(data.mac),
        ciphertext,
    )) {
        throw new Error(`Error decrypting secret ${name}: bad MAC`);
    }

    const plaintext = await subtleCrypto.decrypt(
        {
            name: "AES-CTR",
            counter: decodeBase64(data.iv),
            length: 64,
        },
        aesKey,
        ciphertext,
    );

    return new TextDecoder().decode(new Uint8Array(plaintext));
}

async function deriveKeysBrowser(key, name) {
    const hkdfkey = await subtleCrypto.importKey(
        'raw',
        key,
        {name: "HKDF"},
        false,
        ["deriveBits"],
    );
    const keybits = await subtleCrypto.deriveBits(
        {
            name: "HKDF",
            salt: zerosalt,
            info: (new TextEncoder().encode(name)),
            hash: "SHA-256",
        },
        hkdfkey,
        512,
    );

    const aesKey = keybits.slice(0, 32);
    const hmacKey = keybits.slice(32);

    const aesProm = subtleCrypto.importKey(
        'raw',
        aesKey,
        {name: 'AES-CTR'},
        false,
        ['encrypt', 'decrypt'],
    );

    const hmacProm = subtleCrypto.importKey(
        'raw',
        hmacKey,
        {
            name: 'HMAC',
            hash: {name: 'SHA-256'},
        },
        false,
        ['sign', 'verify'],
    );

    return await Promise.all([aesProm, hmacProm]);
}

const [encryptAES, decryptAES] = (typeof window === "undefined") ?
    [encryptNode, decryptNode] : [encryptBrowser, decryptBrowser];

/**
 * Implements Secure Secret Storage and Sharing (MSC1946)
 * @module crypto/SecretStorage
 */
export class SecretStorage extends EventEmitter {
    constructor(baseApis, cryptoCallbacks, crossSigningInfo) {
        super();
        this._baseApis = baseApis;
        this._cryptoCallbacks = cryptoCallbacks;
        this._crossSigningInfo = crossSigningInfo;
        this._requests = {};
        this._incomingRequests = {};
    }

    async getDefaultKeyId() {
        const defaultKey = await this._baseApis.getAccountDataFromServer(
            'm.secret_storage.default_key',
        );
        if (!defaultKey) return null;
        return defaultKey.key;
    }

    setDefaultKeyId(keyId) {
        return new Promise((resolve) => {
            const listener = (ev) => {
                if (
                    ev.getType() === 'm.secret_storage.default_key' &&
                    ev.getContent().key === keyId
                ) {
                    this._baseApis.removeListener('accountData', listener);
                    resolve();
                }
            };
            this._baseApis.on('accountData', listener);

            this._baseApis.setAccountData(
                'm.secret_storage.default_key',
                { key: keyId },
            );
        });
    }

    /**
     * Add a key for encrypting secrets.
     *
     * @param {string} algorithm the algorithm used by the key.
     * @param {object} opts the options for the algorithm.  The properties used
     *     depend on the algorithm given.
     * @param {string} [keyId] the ID of the key.  If not given, a random
     *     ID will be generated.
     *
     * @return {string} the ID of the key
     */
    async addKey(algorithm, opts, keyId) {
        const keyData = {algorithm};

        if (!opts) opts = {};

        if (opts.name) {
            keyData.name = opts.name;
        }

        switch (algorithm) {
        case SECRET_STORAGE_ALGORITHM_V1_AES:
        {
            const decryption = new global.Olm.PkDecryption();
            try {
                if (opts.passphrase) {
                    keyData.passphrase = opts.passphrase;
                }
            } finally {
                decryption.free();
            }
            break;
        }
        default:
            throw new Error(`Unknown key algorithm ${opts.algorithm}`);
        }

        if (!keyId) {
            do {
                keyId = randomString(32);
            } while (
                await this._baseApis.getAccountDataFromServer(
                    `m.secret_storage.key.${keyId}`,
                )
            );
        }

        await this._crossSigningInfo.signObject(keyData, 'master');

        await this._baseApis.setAccountData(
            `m.secret_storage.key.${keyId}`, keyData,
        );

        return keyId;
    }

    /**
     * Signs a given secret storage key with the cross-signing master key.
     *
     * @param {string} [keyId = default key's ID] The ID of the key to sign.
     *     Defaults to the default key ID if not provided.
     */
    async signKey(keyId) {
        if (!keyId) {
            keyId = await this.getDefaultKeyId();
        }
        if (!keyId) {
            throw new Error("signKey requires a key ID");
        }

        const keyInfo = await this._baseApis.getAccountDataFromServer(
            `m.secret_storage.key.${keyId}`,
        );
        if (!keyInfo) {
            throw new Error(`Key ${keyId} does not exist in account data`);
        }

        await this._crossSigningInfo.signObject(keyInfo, 'master');
        await this._baseApis.setAccountData(
            `m.secret_storage.key.${keyId}`, keyInfo,
        );
    }

    /**
     * Get the key information for a given ID.
     *
     * @param {string} [keyId = default key's ID] The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @returns {Array?} If the key was found, the return value is an array of
     *     the form [keyId, keyInfo].  Otherwise, null is returned.
     */
    async getKey(keyId) {
        if (!keyId) {
            keyId = await this.getDefaultKeyId();
        }
        if (!keyId) {
            return null;
        }

        const keyInfo = await this._baseApis.getAccountDataFromServer(
            "m.secret_storage.key." + keyId,
        );
        return keyInfo ? [keyId, keyInfo] : null;
    }

    /**
     * Check whether we have a key with a given ID.
     *
     * @param {string} [keyId = default key's ID] The ID of the key to check
     *     for. Defaults to the default key ID if not provided.
     * @return {boolean} Whether we have the key.
     */
    async hasKey(keyId) {
        return !!(await this.getKey(keyId));
    }

    /**
     * Store an encrypted secret on the server
     *
     * @param {string} name The name of the secret
     * @param {string} secret The secret contents.
     * @param {Array} keys The IDs of the keys to use to encrypt the secret
     *     or null/undefined to use the default key.
     */
    async store(name, secret, keys) {
        const encrypted = {};

        if (!keys) {
            const defaultKeyId = await this.getDefaultKeyId();
            if (!defaultKeyId) {
                throw new Error("No keys specified and no default key present");
            }
            keys = [defaultKeyId];
        }

        if (keys.length === 0) {
            throw new Error("Zero keys given to encrypt with!");
        }

        for (const keyId of keys) {
            // get key information from key storage
            const keyInfo = await this._baseApis.getAccountDataFromServer(
                "m.secret_storage.key." + keyId,
            );
            if (!keyInfo) {
                throw new Error("Unknown key: " + keyId);
            }

            // encrypt secret, based on the algorithm
            switch (keyInfo.algorithm) {
            case SECRET_STORAGE_ALGORITHM_V1_AES:
            {
                const keys = {[keyId]: keyInfo};
                const [, encryption] = await this._getSecretStorageKey(keys, name);
                encrypted[keyId] = await encryption.encrypt(secret);
                break;
            }
            default:
                logger.warn("unknown algorithm for secret storage key " + keyId
                            + ": " + keyInfo.algorithm);
                // do nothing if we don't understand the encryption algorithm
            }
        }

        // save encrypted secret
        await this._baseApis.setAccountData(name, {encrypted});
    }

    /**
     * Temporary method to fix up existing accounts where secrets
     * are incorrectly stored without the 'encrypted' level
     *
     * @param {string} name The name of the secret
     * @param {object} secretInfo The account data object
     * @returns {object} The fixed object or null if no fix was performed
     */
    async _fixupStoredSecret(name, secretInfo) {
        // We assume the secret was only stored passthrough for 1
        // key - this was all the broken code supported.
        const keys = Object.keys(secretInfo);
        if (
            keys.length === 1 && keys[0] !== 'encrypted' &&
            secretInfo[keys[0]].passthrough
        ) {
            const hasKey = await this.hasKey(keys[0]);
            if (hasKey) {
                console.log("Fixing up passthrough secret: " + name);
                await this.storePassthrough(name, keys[0]);
                const newData = await this._baseApis.getAccountDataFromServer(name);
                return newData;
            }
        }
        return null;
    }

    /**
     * Get a secret from storage.
     *
     * @param {string} name the name of the secret
     *
     * @return {string} the contents of the secret
     */
    async get(name) {
        let secretInfo = await this._baseApis.getAccountDataFromServer(name);
        if (!secretInfo) {
            return;
        }
        if (!secretInfo.encrypted) {
            // try to fix it up
            secretInfo = await this._fixupStoredSecret(name, secretInfo);
            if (!secretInfo || !secretInfo.encrypted) {
                throw new Error("Content is not encrypted!");
            }
        }

        // get possible keys to decrypt
        const keys = {};
        for (const keyId of Object.keys(secretInfo.encrypted)) {
            // get key information from key storage
            const keyInfo = await this._baseApis.getAccountDataFromServer(
                "m.secret_storage.key." + keyId,
            );
            const encInfo = secretInfo.encrypted[keyId];
            switch (keyInfo.algorithm) {
            case SECRET_STORAGE_ALGORITHM_V1_AES:
                if (encInfo.iv && encInfo.ciphertext && encInfo.mac) {
                    keys[keyId] = keyInfo;
                }
                break;
            case SECRET_STORAGE_ALGORITHM_V1_CURVE25519:
                if (
                    keyInfo.pubkey && (
                        (encInfo.ciphertext && encInfo.mac && encInfo.ephemeral) ||
                        encInfo.passthrough
                    )
                ) {
                    keys[keyId] = keyInfo;
                }
                break;
            default:
                // do nothing if we don't understand the encryption algorithm
            }
        }

        let keyId;
        let decryption;
        try {
            // fetch private key from app
            [keyId, decryption] = await this._getSecretStorageKey(keys, name);

            const encInfo = secretInfo.encrypted[keyId];

            // We don't actually need the decryption object if it's a passthrough
            // since we just want to return the key itself.
            if (encInfo.passthrough) return decryption.get_private_key();

            return await decryption.decrypt(encInfo);
        } finally {
            if (decryption && decryption.free) decryption.free();
        }
    }

    /**
     * Check if a secret is stored on the server.
     *
     * @param {string} name the name of the secret
     * @param {boolean} checkKey check if the secret is encrypted by a trusted key
     *
     * @return {object?} map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    async isStored(name, checkKey) {
        // check if secret exists
        let secretInfo = await this._baseApis.getAccountDataFromServer(name);
        if (!secretInfo) return null;
        if (!secretInfo.encrypted) {
            // try to fix it up
            secretInfo = await this._fixupStoredSecret(name, secretInfo);
            if (!secretInfo || !secretInfo.encrypted) {
                return null;
            }
        }

        if (checkKey === undefined) checkKey = true;

        const ret = {};

        // check if secret is encrypted by a known/trusted secret and
        // encryption looks sane
        for (const keyId of Object.keys(secretInfo.encrypted)) {
            // get key information from key storage
            const keyInfo = await this._baseApis.getAccountDataFromServer(
                "m.secret_storage.key." + keyId,
            );
            if (!keyInfo) continue;
            const encInfo = secretInfo.encrypted[keyId];

            // We don't actually need the decryption object if it's a passthrough
            // since we just want to return the key itself.
            if (encInfo.passthrough) {
                try {
                    pkVerify(
                        keyInfo,
                        this._crossSigningInfo.getId('master'),
                        this._crossSigningInfo.userId,
                    );
                } catch (e) {
                    // not trusted, so move on to the next key
                    continue;
                }
                ret[keyId] = keyInfo;
                continue;
            }

            switch (keyInfo.algorithm) {
            case SECRET_STORAGE_ALGORITHM_V1_AES:
                if (encInfo.iv && encInfo.ciphertext && encInfo.mac) {
                    ret[keyId] = keyInfo;
                }
                break;
            case SECRET_STORAGE_ALGORITHM_V1_CURVE25519:
                if (keyInfo.pubkey && encInfo.ciphertext && encInfo.mac
                    && encInfo.ephemeral) {
                    if (checkKey) {
                        try {
                            pkVerify(
                                keyInfo,
                                this._crossSigningInfo.getId('master'),
                                this._crossSigningInfo.userId,
                            );
                        } catch (e) {
                            // not trusted, so move on to the next key
                            continue;
                        }
                    }
                    ret[keyId] = keyInfo;
                }
                break;
            default:
                // do nothing if we don't understand the encryption algorithm
            }
        }
        return Object.keys(ret).length ? ret : null;
    }

    /**
     * Request a secret from another device
     *
     * @param {string} name the name of the secret to request
     * @param {string[]} devices the devices to request the secret from
     *
     * @return {string} the contents of the secret
     */
    request(name, devices) {
        const requestId = this._baseApis.makeTxnId();

        const requestControl = this._requests[requestId] = {
            devices,
        };
        const promise = new Promise((resolve, reject) => {
            requestControl.resolve = resolve;
            requestControl.reject = reject;
        });
        const cancel = (reason) => {
            // send cancellation event
            const cancelData = {
                action: "request_cancellation",
                requesting_device_id: this._baseApis.deviceId,
                request_id: requestId,
            };
            const toDevice = {};
            for (const device of devices) {
                toDevice[device] = cancelData;
            }
            this._baseApis.sendToDevice("m.secret.request", {
                [this._baseApis.getUserId()]: toDevice,
            });

            // and reject the promise so that anyone waiting on it will be
            // notified
            requestControl.reject(new Error(reason || "Cancelled"));
        };

        // send request to devices
        const requestData = {
            name,
            action: "request",
            requesting_device_id: this._baseApis.deviceId,
            request_id: requestId,
        };
        const toDevice = {};
        for (const device of devices) {
            toDevice[device] = requestData;
        }
        this._baseApis.sendToDevice("m.secret.request", {
            [this._baseApis.getUserId()]: toDevice,
        });

        return {
            request_id: requestId,
            promise,
            cancel,
        };
    }

    async _onRequestReceived(event) {
        const sender = event.getSender();
        const content = event.getContent();
        if (sender !== this._baseApis.getUserId()
            || !(content.name && content.action
                 && content.requesting_device_id && content.request_id)) {
            // ignore requests from anyone else, for now
            return;
        }
        const deviceId = content.requesting_device_id;
        // check if it's a cancel
        if (content.action === "request_cancellation") {
            if (this._incomingRequests[deviceId]
                && this._incomingRequests[deviceId][content.request_id]) {
                logger.info("received request cancellation for secret (" + sender
                            + ", " + deviceId + ", " + content.request_id + ")");
                this.baseApis.emit("crypto.secrets.requestCancelled", {
                    user_id: sender,
                    device_id: deviceId,
                    request_id: content.request_id,
                });
            }
        } else if (content.action === "request") {
            if (deviceId === this._baseApis.deviceId) {
                // no point in trying to send ourself the secret
                return;
            }

            // check if we have the secret
            logger.info("received request for secret (" + sender
                        + ", " + deviceId + ", " + content.request_id + ")");
            if (!this._cryptoCallbacks.onSecretRequested) {
                return;
            }
            const secret = await this._cryptoCallbacks.onSecretRequested({
                user_id: sender,
                device_id: deviceId,
                request_id: content.request_id,
                name: content.name,
                device_trust: this._baseApis.checkDeviceTrust(sender, deviceId),
            });
            if (secret) {
                const payload = {
                    type: "m.secret.send",
                    content: {
                        request_id: content.request_id,
                        secret: secret,
                    },
                };
                const encryptedContent = {
                    algorithm: olmlib.OLM_ALGORITHM,
                    sender_key: this._baseApis._crypto._olmDevice.deviceCurve25519Key,
                    ciphertext: {},
                };
                await olmlib.ensureOlmSessionsForDevices(
                    this._baseApis._crypto._olmDevice,
                    this._baseApis,
                    {
                        [sender]: [
                            await this._baseApis.getStoredDevice(sender, deviceId),
                        ],
                    },
                );
                await olmlib.encryptMessageForDevice(
                    encryptedContent.ciphertext,
                    this._baseApis.getUserId(),
                    this._baseApis.deviceId,
                    this._baseApis._crypto._olmDevice,
                    sender,
                    this._baseApis._crypto.getStoredDevice(sender, deviceId),
                    payload,
                );
                const contentMap = {
                    [sender]: {
                        [deviceId]: encryptedContent,
                    },
                };

                this._baseApis.sendToDevice("m.room.encrypted", contentMap);
            }
        }
    }

    _onSecretReceived(event) {
        if (event.getSender() !== this._baseApis.getUserId()) {
            // we shouldn't be receiving secrets from anyone else, so ignore
            // because someone could be trying to send us bogus data
            return;
        }
        const content = event.getContent();
        logger.log("got secret share for request ", content.request_id);
        const requestControl = this._requests[content.request_id];
        if (requestControl) {
            // make sure that the device that sent it is one of the devices that
            // we requested from
            const deviceInfo = this._baseApis._crypto._deviceList.getDeviceByIdentityKey(
                olmlib.OLM_ALGORITHM,
                event.getSenderKey(),
            );
            if (!deviceInfo) {
                logger.log(
                    "secret share from unknown device with key", event.getSenderKey(),
                );
                return;
            }
            if (!requestControl.devices.includes(deviceInfo.deviceId)) {
                logger.log("unsolicited secret share from device", deviceInfo.deviceId);
                return;
            }

            requestControl.resolve(content.secret);
        }
    }

    async _getSecretStorageKey(keys, name) {
        if (!this._cryptoCallbacks.getSecretStorageKey) {
            throw new Error("No getSecretStorageKey callback supplied");
        }

        const returned = await this._cryptoCallbacks.getSecretStorageKey({ keys }, name);

        if (!returned) {
            throw new Error("getSecretStorageKey callback returned falsey");
        }
        if (returned.length < 2) {
            throw new Error("getSecretStorageKey callback returned invalid data");
        }

        const [keyId, privateKey] = returned;
        if (!keys[keyId]) {
            throw new Error("App returned unknown key from getSecretStorageKey!");
        }

        switch (keys[keyId].algorithm) {
        case SECRET_STORAGE_ALGORITHM_V1_AES:
        {
            const decryption = {
                encrypt: async function(secret) {
                    return await encryptAES(secret, privateKey, name);
                },
                decrypt: async function(encInfo) {
                    return await decryptAES(encInfo, privateKey, name);
                },
            };
            return [keyId, decryption];
        }
        case SECRET_STORAGE_ALGORITHM_V1_CURVE25519:
        {
            const pkDecryption = new global.Olm.PkDecryption();
            let pubkey;
            try {
                pubkey = pkDecryption.init_with_private_key(privateKey);
            } catch (e) {
                pkDecryption.free();
                throw new Error("getSecretStorageKey callback returned invalid key");
            }
            if (pubkey !== keys[keyId].pubkey) {
                pkDecryption.free();
                throw new Error(
                    "getSecretStorageKey callback returned incorrect key",
                );
            }
            const decryption = {
                free: pkDecryption.free.bind(pkDecryption),
                decrypt: async function(encInfo) {
                    return pkDecryption.decrypt(
                        encInfo.ephemeral, encInfo.mac, encInfo.ciphertext,
                    );
                },
                // needed for passthrough
                get_private_key: pkDecryption.get_private_key.bind(pkDecryption),
            };
            return [keyId, decryption];
        }
        default:
            throw new Error("Unknown key type: " + keys[keyId].algorithm);
        }
    }
}
