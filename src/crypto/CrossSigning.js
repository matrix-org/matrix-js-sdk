/*
Copyright 2019 New Vector Ltd
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

/**
 * Cross signing methods
 * @module crypto/CrossSigning
 */

import {decodeBase64, encodeBase64, pkSign, pkVerify} from './olmlib';
import {EventEmitter} from 'events';
import {logger} from '../logger';
import {IndexedDBCryptoStore} from '../crypto/store/indexeddb-crypto-store';
import {decryptAES, encryptAES} from './aes';

const KEY_REQUEST_TIMEOUT_MS = 1000 * 60;

function publicKeyFromKeyInfo(keyInfo) {
    // `keys` is an object with { [`ed25519:${pubKey}`]: pubKey }
    // We assume only a single key, and we want the bare form without type
    // prefix, so we select the values.
    return Object.values(keyInfo.keys)[0];
}

export class CrossSigningInfo extends EventEmitter {
    /**
     * Information about a user's cross-signing keys
     *
     * @class
     *
     * @param {string} userId the user that the information is about
     * @param {object} callbacks Callbacks used to interact with the app
     *     Requires getCrossSigningKey and saveCrossSigningKeys
     * @param {object} cacheCallbacks Callbacks used to interact with the cache
     */
    constructor(userId, callbacks, cacheCallbacks) {
        super();

        // you can't change the userId
        Object.defineProperty(this, 'userId', {
            enumerable: true,
            value: userId,
        });
        this._callbacks = callbacks || {};
        this._cacheCallbacks = cacheCallbacks || {};
        this.keys = {};
        this.firstUse = true;
        // This tracks whether we've ever verified this user with any identity.
        // When you verify a user, any devices online at the time that receive
        // the verifying signature via the homeserver will latch this to true
        // and can use it in the future to detect cases where the user has
        // become unverifed later for any reason.
        this.crossSigningVerifiedBefore = false;
    }

    static fromStorage(obj, userId) {
        const res = new CrossSigningInfo(userId);
        for (const prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                res[prop] = obj[prop];
            }
        }
        return res;
    }

    toStorage() {
        return {
            keys: this.keys,
            firstUse: this.firstUse,
            crossSigningVerifiedBefore: this.crossSigningVerifiedBefore,
        };
    }

    /**
     * Calls the app callback to ask for a private key
     *
     * @param {string} type The key type ("master", "self_signing", or "user_signing")
     * @param {string} expectedPubkey The matching public key or undefined to use
     *     the stored public key for the given key type.
     * @returns {Array} An array with [ public key, Olm.PkSigning ]
     */
    async getCrossSigningKey(type, expectedPubkey) {
        const shouldCache = ["master", "self_signing", "user_signing"].indexOf(type) >= 0;

        if (!this._callbacks.getCrossSigningKey) {
            throw new Error("No getCrossSigningKey callback supplied");
        }

        if (expectedPubkey === undefined) {
            expectedPubkey = this.getId(type);
        }

        function validateKey(key) {
            if (!key) return;
            const signing = new global.Olm.PkSigning();
            const gotPubkey = signing.init_with_seed(key);
            if (gotPubkey === expectedPubkey) {
                return [gotPubkey, signing];
            }
            signing.free();
        }

        let privkey;
        if (this._cacheCallbacks.getCrossSigningKeyCache && shouldCache) {
            privkey = await this._cacheCallbacks
              .getCrossSigningKeyCache(type, expectedPubkey);
        }

        const cacheresult = validateKey(privkey);
        if (cacheresult) {
            return cacheresult;
        }

        privkey = await this._callbacks.getCrossSigningKey(type, expectedPubkey);
        const result = validateKey(privkey);
        if (result) {
            if (this._cacheCallbacks.storeCrossSigningKeyCache && shouldCache) {
                await this._cacheCallbacks.storeCrossSigningKeyCache(type, privkey);
            }
            return result;
        }

        /* No keysource even returned a key */
        if (!privkey) {
            throw new Error(
                "getCrossSigningKey callback for " + type + " returned falsey",
            );
        }

        /* We got some keys from the keysource, but none of them were valid */
        throw new Error(
            "Key type " + type + " from getCrossSigningKey callback did not match",
        );
    }

    /**
     * Check whether the private keys exist in secret storage.
     * XXX: This could be static, be we often seem to have an instance when we
     * want to know this anyway...
     *
     * @param {SecretStorage} secretStorage The secret store using account data
     * @returns {object} map of key name to key info the secret is encrypted
     *     with, or null if it is not present or not encrypted with a trusted
     *     key
     */
    async isStoredInSecretStorage(secretStorage) {
        // check what SSSS keys have encrypted the master key (if any)
        const stored =
              await secretStorage.isStored("m.cross_signing.master", false) || {};
        // then check which of those SSSS keys have also encrypted the SSK and USK
        function intersect(s) {
            for (const k of Object.keys(stored)) {
                if (!s[k]) {
                    delete stored[k];
                }
            }
        }
        for (const type of ["self_signing", "user_signing"]) {
            intersect(
                await secretStorage.isStored(`m.cross_signing.${type}`, false) || {},
            );
        }
        return Object.keys(stored).length ? stored : null;
    }

    /**
     * Store private keys in secret storage for use by other devices. This is
     * typically called in conjunction with the creation of new cross-signing
     * keys.
     *
     * @param {Map} keys The keys to store
     * @param {SecretStorage} secretStorage The secret store using account data
     */
    static async storeInSecretStorage(keys, secretStorage) {
        for (const [type, privateKey] of keys) {
            const encodedKey = encodeBase64(privateKey);
            await secretStorage.store(`m.cross_signing.${type}`, encodedKey);
        }
    }

    /**
     * Get private keys from secret storage created by some other device. This
     * also passes the private keys to the app-specific callback.
     *
     * @param {string} type The type of key to get.  One of "master",
     * "self_signing", or "user_signing".
     * @param {SecretStorage} secretStorage The secret store using account data
     * @return {Uint8Array} The private key
     */
    static async getFromSecretStorage(type, secretStorage) {
        const encodedKey = await secretStorage.get(`m.cross_signing.${type}`);
        if (!encodedKey) {
            return null;
        }
        return decodeBase64(encodedKey);
    }

    /**
     * Check whether the private keys exist in the local key cache.
     *
     * @returns {boolean} True if all keys are stored in the local cache.
     */
    async isStoredInKeyCache() {
        const cacheCallbacks = this._cacheCallbacks;
        if (!cacheCallbacks) return false;
        for (const type of ["master", "self_signing", "user_signing"]) {
            if (!await cacheCallbacks.getCrossSigningKeyCache(type)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get cross-signing private keys from the local cache.
     *
     * @returns {Map} A map from key type (string) to private key (Uint8Array)
     */
    async getCrossSigningKeysFromCache() {
        const keys = new Map();
        const cacheCallbacks = this._cacheCallbacks;
        if (!cacheCallbacks) return keys;
        for (const type of ["master", "self_signing", "user_signing"]) {
            const privKey = await cacheCallbacks.getCrossSigningKeyCache(type);
            keys.set(type, privKey);
        }
        return keys;
    }

    /**
     * Get the ID used to identify the user. This can also be used to test for
     * the existence of a given key type.
     *
     * @param {string} type The type of key to get the ID of.  One of "master",
     * "self_signing", or "user_signing".  Defaults to "master".
     *
     * @return {string} the ID
     */
    getId(type) {
        type = type || "master";
        if (!this.keys[type]) return null;
        const keyInfo = this.keys[type];
        return publicKeyFromKeyInfo(keyInfo);
    }

    /**
     * Create new cross-signing keys for the given key types. The public keys
     * will be held in this class, while the private keys are passed off to the
     * `saveCrossSigningKeys` application callback.
     *
     * @param {CrossSigningLevel} level The key types to reset
     */
    async resetKeys(level) {
        if (!this._callbacks.saveCrossSigningKeys) {
            throw new Error("No saveCrossSigningKeys callback supplied");
        }

        // If we're resetting the master key, we reset all keys
        if (
            level === undefined ||
            level & CrossSigningLevel.MASTER ||
            !this.keys.master
        ) {
            level = (
                CrossSigningLevel.MASTER |
                CrossSigningLevel.USER_SIGNING |
                CrossSigningLevel.SELF_SIGNING
            );
        } else if (level === 0) {
            return;
        }

        const privateKeys = {};
        const keys = {};
        let masterSigning;
        let masterPub;

        try {
            if (level & CrossSigningLevel.MASTER) {
                masterSigning = new global.Olm.PkSigning();
                privateKeys.master = masterSigning.generate_seed();
                masterPub = masterSigning.init_with_seed(privateKeys.master);
                keys.master = {
                    user_id: this.userId,
                    usage: ['master'],
                    keys: {
                        ['ed25519:' + masterPub]: masterPub,
                    },
                };
            } else {
                [masterPub, masterSigning] = await this.getCrossSigningKey("master");
            }

            if (level & CrossSigningLevel.SELF_SIGNING) {
                const sskSigning = new global.Olm.PkSigning();
                try {
                    privateKeys.self_signing = sskSigning.generate_seed();
                    const sskPub = sskSigning.init_with_seed(privateKeys.self_signing);
                    keys.self_signing = {
                        user_id: this.userId,
                        usage: ['self_signing'],
                        keys: {
                            ['ed25519:' + sskPub]: sskPub,
                        },
                    };
                    pkSign(keys.self_signing, masterSigning, this.userId, masterPub);
                } finally {
                    sskSigning.free();
                }
            }

            if (level & CrossSigningLevel.USER_SIGNING) {
                const uskSigning = new global.Olm.PkSigning();
                try {
                    privateKeys.user_signing = uskSigning.generate_seed();
                    const uskPub = uskSigning.init_with_seed(privateKeys.user_signing);
                    keys.user_signing = {
                        user_id: this.userId,
                        usage: ['user_signing'],
                        keys: {
                            ['ed25519:' + uskPub]: uskPub,
                        },
                    };
                    pkSign(keys.user_signing, masterSigning, this.userId, masterPub);
                } finally {
                    uskSigning.free();
                }
            }

            Object.assign(this.keys, keys);
            this._callbacks.saveCrossSigningKeys(privateKeys);
        } finally {
            if (masterSigning) {
                masterSigning.free();
            }
        }
    }

    /**
     * unsets the keys, used when another session has reset the keys, to disable cross-signing
     */
    clearKeys() {
        this.keys = {};
    }

    setKeys(keys) {
        const signingKeys = {};
        if (keys.master) {
            if (keys.master.user_id !== this.userId) {
                const error = "Mismatched user ID " + keys.master.user_id +
                      " in master key from " + this.userId;
                logger.error(error);
                throw new Error(error);
            }
            if (!this.keys.master) {
                // this is the first key we've seen, so first-use is true
                this.firstUse = true;
            } else if (publicKeyFromKeyInfo(keys.master) !== this.getId()) {
                // this is a different key, so first-use is false
                this.firstUse = false;
            } // otherwise, same key, so no change
            signingKeys.master = keys.master;
        } else if (this.keys.master) {
            signingKeys.master = this.keys.master;
        } else {
            throw new Error("Tried to set cross-signing keys without a master key");
        }
        const masterKey = publicKeyFromKeyInfo(signingKeys.master);

        // verify signatures
        if (keys.user_signing) {
            if (keys.user_signing.user_id !== this.userId) {
                const error = "Mismatched user ID " + keys.master.user_id +
                      " in user_signing key from " + this.userId;
                logger.error(error);
                throw new Error(error);
            }
            try {
                pkVerify(keys.user_signing, masterKey, this.userId);
            } catch (e) {
                logger.error("invalid signature on user-signing key");
                // FIXME: what do we want to do here?
                throw e;
            }
        }
        if (keys.self_signing) {
            if (keys.self_signing.user_id !== this.userId) {
                const error = "Mismatched user ID " + keys.master.user_id +
                      " in self_signing key from " + this.userId;
                logger.error(error);
                throw new Error(error);
            }
            try {
                pkVerify(keys.self_signing, masterKey, this.userId);
            } catch (e) {
                logger.error("invalid signature on self-signing key");
                // FIXME: what do we want to do here?
                throw e;
            }
        }

        // if everything checks out, then save the keys
        if (keys.master) {
            this.keys.master = keys.master;
            // if the master key is set, then the old self-signing and
            // user-signing keys are obsolete
            this.keys.self_signing = null;
            this.keys.user_signing = null;
        }
        if (keys.self_signing) {
            this.keys.self_signing = keys.self_signing;
        }
        if (keys.user_signing) {
            this.keys.user_signing = keys.user_signing;
        }
    }

    updateCrossSigningVerifiedBefore(isCrossSigningVerified) {
        // It is critical that this value latches forward from false to true but
        // never back to false to avoid a downgrade attack.
        if (!this.crossSigningVerifiedBefore && isCrossSigningVerified) {
            this.crossSigningVerifiedBefore = true;
        }
    }

    async signObject(data, type) {
        if (!this.keys[type]) {
            throw new Error(
                "Attempted to sign with " + type + " key but no such key present",
            );
        }
        const [pubkey, signing] = await this.getCrossSigningKey(type);
        try {
            pkSign(data, signing, this.userId, pubkey);
            return data;
        } finally {
            signing.free();
        }
    }

    async signUser(key) {
        if (!this.keys.user_signing) {
            logger.info("No user signing key: not signing user");
            return;
        }
        return this.signObject(key.keys.master, "user_signing");
    }

    async signDevice(userId, device) {
        if (userId !== this.userId) {
            throw new Error(
                `Trying to sign ${userId}'s device; can only sign our own device`,
            );
        }
        if (!this.keys.self_signing) {
            logger.info("No self signing key: not signing device");
            return;
        }
        return this.signObject(
            {
                algorithms: device.algorithms,
                keys: device.keys,
                device_id: device.deviceId,
                user_id: userId,
            }, "self_signing",
        );
    }

    /**
     * Check whether a given user is trusted.
     *
     * @param {CrossSigningInfo} userCrossSigning Cross signing info for user
     *
     * @returns {UserTrustLevel}
     */
    checkUserTrust(userCrossSigning) {
        // if we're checking our own key, then it's trusted if the master key
        // and self-signing key match
        if (this.userId === userCrossSigning.userId
            && this.getId() && this.getId() === userCrossSigning.getId()
            && this.getId("self_signing")
            && this.getId("self_signing") === userCrossSigning.getId("self_signing")
        ) {
            return new UserTrustLevel(true, true, this.firstUse);
        }

        if (!this.keys.user_signing) {
            // If there's no user signing key, they can't possibly be verified.
            // They may be TOFU trusted though.
            return new UserTrustLevel(false, false, userCrossSigning.firstUse);
        }

        let userTrusted;
        const userMaster = userCrossSigning.keys.master;
        const uskId = this.getId('user_signing');
        try {
            pkVerify(userMaster, uskId, this.userId);
            userTrusted = true;
        } catch (e) {
            userTrusted = false;
        }
        return new UserTrustLevel(
            userTrusted,
            userCrossSigning.crossSigningVerifiedBefore,
            userCrossSigning.firstUse,
        );
    }

    /**
     * Check whether a given device is trusted.
     *
     * @param {CrossSigningInfo} userCrossSigning Cross signing info for user
     * @param {module:crypto/deviceinfo} device The device to check
     * @param {bool} localTrust Whether the device is trusted locally
     * @param {bool} trustCrossSignedDevices Whether we trust cross signed devices
     *
     * @returns {DeviceTrustLevel}
     */
    checkDeviceTrust(userCrossSigning, device, localTrust, trustCrossSignedDevices) {
        const userTrust = this.checkUserTrust(userCrossSigning);

        const userSSK = userCrossSigning.keys.self_signing;
        if (!userSSK) {
            // if the user has no self-signing key then we cannot make any
            // trust assertions about this device from cross-signing
            return new DeviceTrustLevel(
                false, false, localTrust, trustCrossSignedDevices,
            );
        }

        const deviceObj = deviceToObject(device, userCrossSigning.userId);
        try {
            // if we can verify the user's SSK from their master key...
            pkVerify(userSSK, userCrossSigning.getId(), userCrossSigning.userId);
            // ...and this device's key from their SSK...
            pkVerify(
                deviceObj, publicKeyFromKeyInfo(userSSK), userCrossSigning.userId,
            );
            // ...then we trust this device as much as far as we trust the user
            return DeviceTrustLevel.fromUserTrustLevel(
                userTrust, localTrust, trustCrossSignedDevices,
            );
        } catch (e) {
            return new DeviceTrustLevel(
                false, false, localTrust, trustCrossSignedDevices,
            );
        }
    }

    /**
     * @returns {object} Cache callbacks
     */
    getCacheCallbacks() {
        return this._cacheCallbacks;
    }
}

function deviceToObject(device, userId) {
    return {
        algorithms: device.algorithms,
        keys: device.keys,
        device_id: device.deviceId,
        user_id: userId,
        signatures: device.signatures,
    };
}

export const CrossSigningLevel = {
    MASTER: 4,
    USER_SIGNING: 2,
    SELF_SIGNING: 1,
};

/**
 * Represents the ways in which we trust a user
 */
export class UserTrustLevel {
    constructor(crossSigningVerified, crossSigningVerifiedBefore, tofu) {
        this._crossSigningVerified = crossSigningVerified;
        this._crossSigningVerifiedBefore = crossSigningVerifiedBefore;
        this._tofu = tofu;
    }

    /**
     * @returns {bool} true if this user is verified via any means
     */
    isVerified() {
        return this.isCrossSigningVerified();
    }

    /**
     * @returns {bool} true if this user is verified via cross signing
     */
    isCrossSigningVerified() {
        return this._crossSigningVerified;
    }

    /**
     * @returns {bool} true if we ever verified this user before (at least for
     * the history of verifications observed by this device).
     */
    wasCrossSigningVerified() {
        return this._crossSigningVerifiedBefore;
    }

    /**
     * @returns {bool} true if this user's key is trusted on first use
     */
    isTofu() {
        return this._tofu;
    }
}

/**
 * Represents the ways in which we trust a device
 */
export class DeviceTrustLevel {
    constructor(crossSigningVerified, tofu, localVerified, trustCrossSignedDevices) {
        this._crossSigningVerified = crossSigningVerified;
        this._tofu = tofu;
        this._localVerified = localVerified;
        this._trustCrossSignedDevices = trustCrossSignedDevices;
    }

    static fromUserTrustLevel(userTrustLevel, localVerified, trustCrossSignedDevices) {
        return new DeviceTrustLevel(
            userTrustLevel._crossSigningVerified,
            userTrustLevel._tofu,
            localVerified,
            trustCrossSignedDevices,
        );
    }

    /**
     * @returns {bool} true if this device is verified via any means
     */
    isVerified() {
        return Boolean(this.isLocallyVerified() || (
            this._trustCrossSignedDevices && this.isCrossSigningVerified()
        ));
    }

    /**
     * @returns {bool} true if this device is verified via cross signing
     */
    isCrossSigningVerified() {
        return this._crossSigningVerified;
    }

    /**
     * @returns {bool} true if this device is verified locally
     */
    isLocallyVerified() {
        return this._localVerified;
    }

    /**
     * @returns {bool} true if this device is trusted from a user's key
     * that is trusted on first use
     */
    isTofu() {
        return this._tofu;
    }
}

export function createCryptoStoreCacheCallbacks(store, olmdevice) {
    return {
        getCrossSigningKeyCache: async function(type, _expectedPublicKey) {
            const key = await new Promise((resolve) => {
                return store.doTxn(
                    'readonly',
                    [IndexedDBCryptoStore.STORE_ACCOUNT],
                    (txn) => {
                        store.getSecretStorePrivateKey(txn, resolve, type);
                    },
                );
            });

            if (key && key.ciphertext) {
                const pickleKey = Buffer.from(olmdevice._pickleKey);
                const decrypted = await decryptAES(key, pickleKey, type);
                return decodeBase64(decrypted);
            } else {
                return key;
            }
        },
        storeCrossSigningKeyCache: async function(type, key) {
            if (!(key instanceof Uint8Array)) {
                throw new Error(
                    `storeCrossSigningKeyCache expects Uint8Array, got ${key}`,
                );
            }
            const pickleKey = Buffer.from(olmdevice._pickleKey);
            key = await encryptAES(encodeBase64(key), pickleKey, type);
            return store.doTxn(
                'readwrite',
                [IndexedDBCryptoStore.STORE_ACCOUNT],
                (txn) => {
                    store.storeSecretStorePrivateKey(txn, type, key);
                },
            );
        },
    };
}

/**
 * Request cross-signing keys from another device during verification.
 *
 * @param {module:base-apis~MatrixBaseApis} baseApis base Matrix API interface
 * @param {string} userId The user ID being verified
 * @param {string} deviceId The device ID being verified
 */
export async function requestKeysDuringVerification(baseApis, userId, deviceId) {
    // If this is a self-verification, ask the other party for keys
    if (baseApis.getUserId() !== userId) {
        return;
    }
    console.log("Cross-signing: Self-verification done; requesting keys");
    // This happens asynchronously, and we're not concerned about waiting for
    // it.  We return here in order to test.
    return new Promise((resolve, reject) => {
        const client = baseApis;
        const original = client._crypto._crossSigningInfo;

        // We already have all of the infrastructure we need to validate and
        // cache cross-signing keys, so instead of replicating that, here we set
        // up callbacks that request them from the other device and call
        // CrossSigningInfo.getCrossSigningKey() to validate/cache
        const crossSigning = new CrossSigningInfo(
            original.userId,
            { getCrossSigningKey: async (type) => {
                console.debug("Cross-signing: requesting secret",
                                type, deviceId);
                const { promise } = client.requestSecret(
                    `m.cross_signing.${type}`, [deviceId],
                );
                const result = await promise;
                const decoded = decodeBase64(result);
                return Uint8Array.from(decoded);
            } },
            original._cacheCallbacks,
        );
        crossSigning.keys = original.keys;

        // XXX: get all keys out if we get one key out
        // https://github.com/vector-im/element-web/issues/12604
        // then change here to reject on the timeout
        // Requests can be ignored, so don't wait around forever
        const timeout = new Promise((resolve, reject) => {
            setTimeout(
                resolve,
                KEY_REQUEST_TIMEOUT_MS,
                new Error("Timeout"),
            );
        });

        // also request and cache the key backup key
        const backupKeyPromise = new Promise(async resolve => {
            const cachedKey = await client._crypto.getSessionBackupPrivateKey();
            if (!cachedKey) {
                logger.info("No cached backup key found. Requesting...");
                const secretReq = client.requestSecret(
                    'm.megolm_backup.v1', [deviceId],
                );
                const base64Key = await secretReq.promise;
                logger.info("Got key backup key, decoding...");
                const decodedKey = decodeBase64(base64Key);
                logger.info("Decoded backup key, storing...");
                client._crypto.storeSessionBackupPrivateKey(
                    Uint8Array.from(decodedKey),
                );
                logger.info("Backup key stored. Starting backup restore...");
                const backupInfo = await client.getKeyBackupVersion();
                // no need to await for this - just let it go in the bg
                client.restoreKeyBackupWithCache(
                    undefined, undefined, backupInfo,
                ).then(() => {
                    logger.info("Backup restored.");
                });
            }
            resolve();
        });

        // We call getCrossSigningKey() for its side-effects
        return Promise.race([
            Promise.all([
                crossSigning.getCrossSigningKey("master"),
                crossSigning.getCrossSigningKey("self_signing"),
                crossSigning.getCrossSigningKey("user_signing"),
                backupKeyPromise,
            ]),
            timeout,
        ]).then(resolve, reject);
    }).catch((e) => {
        console.warn("Cross-signing: failure while requesting keys:", e);
    });
}
