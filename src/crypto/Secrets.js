/*
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

import {EventEmitter} from 'events';
import logger from '../logger';
import olmlib from './olmlib';
import { randomString } from '../randomstring';
import { keyFromPassphrase } from './key_passphrase';
import { encodeRecoveryKey } from './recoverykey';
import { pkVerify } from './olmlib';

/**
 * Implements Secure Secret Storage and Sharing (MSC1946)
 * @module crypto/Secrets
 */
export default class SecretStorage extends EventEmitter {
    constructor(baseApis, cryptoCallbacks, crossSigningInfo) {
        super();
        this._baseApis = baseApis;
        this._cryptoCallbacks = cryptoCallbacks;
        this._crossSigningInfo = crossSigningInfo;
        this._requests = {};
        this._incomingRequests = {};
    }

    getDefaultKeyId() {
        const defaultKeyEvent = this._baseApis.getAccountData(
            'm.secret_storage.default_key',
        );
        if (!defaultKeyEvent) return null;
        return defaultKeyEvent.getContent().key;
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
     *     depend on the algorithm given.  This object may be modified to pass
     *     information back about the key.
     * @param {string} [keyID] the ID of the key.  If not given, a random
     *     ID will be generated.
     *
     * @return {string} the ID of the key
     */
    async addKey(algorithm, opts, keyID) {
        const keyData = {algorithm};

        if (!opts) opts = {};

        if (opts.name) {
            keyData.name = opts.name;
        }

        switch (algorithm) {
        case "m.secret_storage.v1.curve25519-aes-sha2":
        {
            const decryption = new global.Olm.PkDecryption();
            try {
                if (opts.passphrase) {
                    const key = await keyFromPassphrase(opts.passphrase);
                    keyData.passphrase = {
                        algorithm: "m.pbkdf2",
                        iterations: key.iterations,
                        salt: key.salt,
                    };
                    opts.encodedkey = encodeRecoveryKey(key.key);
                    keyData.pubkey = decryption.init_with_private_key(key.key);
                } else if (opts.privkey) {
                    keyData.pubkey = decryption.init_with_private_key(opts.privkey);
                    opts.encodedkey = encodeRecoveryKey(opts.privkey);
                } else {
                    keyData.pubkey = decryption.generate_key();
                    opts.encodedkey = encodeRecoveryKey(decryption.get_private_key());
                }
            } finally {
                decryption.free();
            }
            break;
        }
        default:
            throw new Error(`Unknown key algorithm ${opts.algorithm}`);
        }

        if (!keyID) {
            do {
                keyID = randomString(32);
            } while (this._baseApis.getAccountData(`m.secret_storage.key.${keyID}`));
        }

        await this._crossSigningInfo.signObject(keyData, 'master');

        await this._baseApis.setAccountData(
            `m.secret_storage.key.${keyID}`, keyData,
        );

        return keyID;
    }

    // TODO: need a function to get all the secret keys

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
            const defaultKeyId = this.getDefaultKeyId();
            if (!defaultKeyId) {
                throw new Error("No keys specified and no default key present");
            }
            keys = [defaultKeyId];
        }

        if (keys.length === 0) {
            throw new Error("Zero keys given to encrypt with!");
        }

        for (const keyName of keys) {
            // get key information from key storage
            const keyInfo = this._baseApis.getAccountData(
                "m.secret_storage.key." + keyName,
            );
            if (!keyInfo) {
                throw new Error("Unknown key: " +keyName);
            }
            const keyInfoContent = keyInfo.getContent();

            // check signature of key info
            pkVerify(
                keyInfoContent,
                this._crossSigningInfo.getId('master'),
                this._crossSigningInfo.userId,
            );

            // encrypt secret, based on the algorithm
            switch (keyInfoContent.algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
            {
                const encryption = new global.Olm.PkEncryption();
                try {
                    encryption.set_recipient_key(keyInfoContent.pubkey);
                    encrypted[keyName] = encryption.encrypt(secret);
                } finally {
                    encryption.free();
                }
                break;
            }
            default:
                logger.warn("unknown algorithm for secret storage key " + keyName
                            + ": " + keyInfoContent.algorithm);
                // do nothing if we don't understand the encryption algorithm
            }
        }

        // save encrypted secret
        await this._baseApis.setAccountData(name, {encrypted});
    }

    /**
     * Get a secret from storage.
     *
     * @param {string} name the name of the secret
     *
     * @return {string} the contents of the secret
     */
    async get(name) {
        const secretInfo = this._baseApis.getAccountData(name);
        if (!secretInfo) {
            return;
        }

        const secretContent = secretInfo.getContent();

        if (!secretContent.encrypted) {
            throw new Error("Content is not encrypted!");
        }

        // get possible keys to decrypt
        const keys = {};
        for (const keyName of Object.keys(secretContent.encrypted)) {
            // get key information from key storage
            const keyInfo = this._baseApis.getAccountData(
                "m.secret_storage.key." + keyName,
            ).getContent();
            const encInfo = secretContent.encrypted[keyName];
            switch (keyInfo.algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
                if (keyInfo.pubkey && encInfo.ciphertext && encInfo.mac
                    && encInfo.ephemeral) {
                    keys[keyName] = keyInfo;
                }
                break;
            default:
                // do nothing if we don't understand the encryption algorithm
            }
        }

        let keyName;
        let decryption;
        try {
            // fetch private key from app
            [keyName, decryption] = await this._getSecretStorageKey(keys);

            // decrypt secret
            const encInfo = secretContent.encrypted[keyName];
            switch (keys[keyName].algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
                return decryption.decrypt(
                    encInfo.ephemeral, encInfo.mac, encInfo.ciphertext,
                );
            }
        } finally {
            if (decryption) decryption.free();
        }
    }

    /**
     * Check if a secret is stored on the server.
     *
     * @param {string} name the name of the secret
     * @param {boolean} checkKey check if the secret is encrypted by a trusted key
     *
     * @return {boolean} whether or not the secret is stored
     */
    isStored(name, checkKey) {
        // check if secret exists
        const secretInfo = this._baseApis.getAccountData(name);
        if (!secretInfo) {
            return false;
        }

        if (checkKey === undefined) checkKey = true;

        const secretContent = secretInfo.getContent();

        if (!secretContent.encrypted) {
            return false;
        }

        // check if secret is encrypted by a known/trusted secret and
        // encryption looks sane
        for (const keyName of Object.keys(secretContent.encrypted)) {
            // get key information from key storage
            const keyInfo = this._baseApis.getAccountData(
                "m.secret_storage.key." + keyName,
            ).getContent();
            const encInfo = secretContent.encrypted[keyName];
            if (checkKey) {
                pkVerify(
                    keyInfo,
                    this._crossSigningInfo.getId('master'),
                    this._crossSigningInfo.userId,
                );
            }
            switch (keyInfo.algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
                if (keyInfo.pubkey && encInfo.ciphertext && encInfo.mac
                    && encInfo.ephemeral) {
                    return true;
                }
                break;
            default:
                // do nothing if we don't understand the encryption algorithm
            }
        }
        return false;
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

    async _getSecretStorageKey(keys) {
        if (!this._cryptoCallbacks.getSecretStorageKey) {
            throw new Error("No getSecretStorageKey callback supplied");
        }

        const returned = await Promise.resolve(
            this._cryptoCallbacks.getSecretStorageKey({keys}),
        );

        if (!returned) {
            throw new Error("getSecretStorageKey callback returned falsey");
        }
        if (returned.length < 2) {
            throw new Error("getSecretStorageKey callback returned invalid data");
        }

        const [keyName, privateKey] = returned;
        if (!keys[keyName]) {
            throw new Error("App returned unknown key from getSecretStorageKey!");
        }

        switch (keys[keyName].algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
            {
                const decryption = new global.Olm.PkDecryption();
                let pubkey;
                try {
                    pubkey = decryption.init_with_private_key(privateKey);
                } catch (e) {
                    decryption.free();
                    throw new Error("getSecretStorageKey callback returned invalid key");
                }
                if (pubkey !== keys[keyName].pubkey) {
                    decryption.free();
                    throw new Error(
                        "getSecretStorageKey callback returned incorrect key",
                    );
                }
                return [keyName, decryption];
            }
            default:
                throw new Error("Unknown key type: " + keys[keyName].algorithm);
        }
    }
}
