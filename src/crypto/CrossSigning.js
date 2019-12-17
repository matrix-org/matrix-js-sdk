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
     */
    constructor(userId, callbacks) {
        super();

        // you can't change the userId
        Object.defineProperty(this, 'userId', {
            enumerable: true,
            value: userId,
        });
        this._callbacks = callbacks || {};
        this.keys = {};
        this.firstUse = true;
    }

    /**
     * Calls the app callback to ask for a private key
     * @param {string} type The key type ("master", "self_signing", or "user_signing")
     * @param {string} expectedPubkey The matching public key or undefined to use
     *     the stored public key for the given key type.
     * @returns {Array} An array with [ public key, Olm.PkSigning ]
     */
    async getCrossSigningKey(type, expectedPubkey) {
        if (!this._callbacks.getCrossSigningKey) {
            throw new Error("No getCrossSigningKey callback supplied");
        }

        if (expectedPubkey === undefined) {
            expectedPubkey = this.getId(type);
        }

        const privkey = await this._callbacks.getCrossSigningKey(type, expectedPubkey);
        if (!privkey) {
            throw new Error(
                "getCrossSigningKey callback for " + type + " returned falsey",
            );
        }
        const signing = new global.Olm.PkSigning();
        const gotPubkey = signing.init_with_seed(privkey);
        if (gotPubkey !== expectedPubkey) {
            signing.free();
            throw new Error(
                "Key type " + type + " from getCrossSigningKey callback did not match",
            );
        } else {
            return [gotPubkey, signing];
        }
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
        };
    }

    /**
     * Check whether the private keys exist in secret storage.
     * XXX: This could be static, be we often seem to have an instance when we
     * want to know this anyway...
     *
     * @param {SecretStorage} secretStorage The secret store using account data
     * @returns {boolean} Whether all private keys were found in storage
     */
    isStoredInSecretStorage(secretStorage) {
        let stored = true;
        for (const type of ["master", "self_signing", "user_signing"]) {
            stored &= secretStorage.isStored(`m.cross_signing.${type}`, false);
        }
        return stored;
    }

    /**
     * Store private keys in secret storage for use by other devices. This is
     * typically called in conjunction with the creation of new cross-signing
     * keys.
     *
     * @param {object} keys The keys to store
     * @param {SecretStorage} secretStorage The secret store using account data
     */
    static async storeInSecretStorage(keys, secretStorage) {
        for (const type of Object.keys(keys)) {
            const encodedKey = encodeBase64(keys[type]);
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
        return decodeBase64(encodedKey);
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
            return new UserTrustLevel(true, this.firstUse);
        }

        if (!this.keys.user_signing) {
            // If there's no user signing key, they can't possibly be verified.
            // They may be TOFU trusted though.
            return new UserTrustLevel(false, userCrossSigning.firstUse);
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
        return new UserTrustLevel(userTrusted, userCrossSigning.firstUse);
    }

    /**
     * Check whether a given device is trusted.
     *
     * @param {CrossSigningInfo} userCrossSigning Cross signing info for user
     * @param {module:crypto/deviceinfo} device The device to check
     * @param {bool} localTrust Whether the device is trusted locally
     *
     * @returns {DeviceTrustLevel}
     */
    checkDeviceTrust(userCrossSigning, device, localTrust) {
        const userTrust = this.checkUserTrust(userCrossSigning);

        const userSSK = userCrossSigning.keys.self_signing;
        if (!userSSK) {
            // if the user has no self-signing key then we cannot make any
            // trust assertions about this device from cross-signing
            return new DeviceTrustLevel(false, false, localTrust);
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
            return DeviceTrustLevel.fromUserTrustLevel(userTrust, localTrust);
        } catch (e) {
            return new DeviceTrustLevel(false, false, localTrust);
        }
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
    constructor(crossSigningVerified, tofu) {
        this._crossSigningVerified = crossSigningVerified;
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
    constructor(crossSigningVerified, tofu, localVerified) {
        this._crossSigningVerified = crossSigningVerified;
        this._tofu = tofu;
        this._localVerified = localVerified;
    }

    static fromUserTrustLevel(userTrustLevel, localVerified) {
        return new DeviceTrustLevel(
            userTrustLevel._crossSigningVerified,
            userTrustLevel._tofu,
            localVerified,
        );
    }

    /**
     * @returns {bool} true if this device is verified via any means
     */
    isVerified() {
        return this.isCrossSigningVerified() || this.isLocallyVerified();
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
