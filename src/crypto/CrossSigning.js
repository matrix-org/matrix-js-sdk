/*
Copyright 2019 New Vector Ltd

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

import {pkSign, pkVerify} from './olmlib';
import {EventEmitter} from 'events';

function getPublicKey(keyInfo) {
    return Object.entries(keyInfo.keys)[0];
}

function getPrivateKey(self, type, check) {
    return new Promise((resolve, reject) => {
        const askForKey = (error) => {
            self.emit("cross-signing:getKey", {
                type: type,
                error,
                done: (key) => {
                    // FIXME: the key needs to be interpreted?
                    const signing = new global.Olm.PkSigning();
                    const pubkey = signing.init_with_seed(key);
                    const error = check(pubkey, signing);
                    if (error) {
                        return askForKey(error);
                    }
                    resolve([pubkey, signing]);
                },
                cancel: (error) => {
                    reject(error || new Error("Cancelled"));
                },
            });
        };
        askForKey();
    });
}

export class CrossSigningInfo extends EventEmitter {
    /**
     * Information about a user's cross-signing keys
     *
     * @class
     *
     * @param {string} userId the user that the information is about
     */
    constructor(userId) {
        super();

        // you can't change the userId
        Object.defineProperty(this, 'userId', {
            enumerabel: true,
            value: userId,
        });
        this.keys = {};
        this.fu = true;
        // FIXME: add chain of ssks?
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
            verified: this.verified,
        };
    }

    /** Get the ID used to identify the user
     *
     * @return {string} the ID
     */
    getId() {
        return getPublicKey(this.keys.master)[1];
    }

    async resetKeys(level) {
        if (level === undefined || level & 4) {
            level = CrossSigningLevel.MASTER;
        } else if (level === 0) {
            return;
        }

        const privateKeys = {};
        const keys = {};
        let masterSigning;
        let masterPub;

        if (level & 4) {
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
            [masterPub, masterSigning] = await getPrivateKey(this, "master", (pubkey) => {
                // make sure it agrees with the pubkey that we have
                if (pubkey !== getPublicKey(this.keys.master)[1]) {
                    return "Key does not match";
                }
                return;
            });
        }

        if (level & CrossSigningLevel.SELF_SIGNING) {
            const sskSigning = new global.Olm.PkSigning();
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
        }

        if (level & CrossSigningLevel.USER_SIGNING) {
            const uskSigning = new global.Olm.PkSigning();
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
        }

        Object.assign(this.keys, keys);
        this.emit("cross-signing:savePrivateKeys", privateKeys);
    }

    setKeys(keys) {
        const signingKeys = {};
        if (keys.master) {
            // First-Use is true if and only if we had no previous key for the user
            this.fu = !(this.keys.self_signing);
            signingKeys.master = keys.master;
            if (!keys.user_signing || !keys.self_signing) {
                throw new Error("Must have new self-signing and user-signing"
                                + "keys when new master key is set");
            }
        } else {
            signingKeys.master = this.keys.master;
        }
        const masterKey = getPublicKey(signingKeys.master)[1];

        // verify signatures
        if (keys.user_signing) {
            try {
                pkVerify(keys.user_signing, masterKey, this.userId);
            } catch (e) {
                // FIXME: what do we want to do here?
                throw e;
            }
        }
        if (keys.self_signing) {
            try {
                pkVerify(keys.self_signing, masterKey, this.userId);
            } catch (e) {
                // FIXME: what do we want to do here?
                throw e;
            }
        }

        // if everything checks out, then save the keys
        if (keys.master) {
            this.keys.master = keys.master;
        }
        if (keys.self_signing) {
            this.keys.self_signing = keys.self_signing;
        }
        if (keys.user_signing) {
            this.keys.user_signing = keys.user_signing;
        }
    }

    async signUser(key) {
        const [pubkey, usk] = await getPrivateKey(this, "user_signing", (key) => {
            return;
        });
        const otherMaster = key.keys.master;
        pkSign(otherMaster, usk, this.userId, pubkey);
        return otherMaster;
    }

    async signDevice(userId, device) {
        if (userId !== this.userId) {
            throw new Error("Urgh!");
        }
        const [pubkey, ssk] = await getPrivateKey(this, "self_signing", (key) => {
            return;
        });
        const keyObj = {
            algorithms: device.algorithms,
            keys: device.keys,
            device_id: device.deviceId,
            user_id: userId,
        };
        pkSign(keyObj, ssk, this.userId, pubkey);
        return keyObj;
    }

    checkUserTrust(userCrossSigning) {
        let userTrusted;
        const userMaster = userCrossSigning.keys.master;
        const uskId = getPublicKey(this.keys.user_signing)[1];
        try {
            pkVerify(userMaster, uskId, this.userId);
            userTrusted = true;
        } catch (e) {
            userTrusted = false;
        }
        return (userTrusted ? CrossSigningVerification.VERIFIED
                : CrossSigningVerification.UNVERIFIED)
             | (userCrossSigning.fu ? CrossSigningVerification.TOFU
                : CrossSigningVerification.UNVERIFIED);
    }

    checkDeviceTrust(userCrossSigning, device) {
        const userTrust = this.checkUserTrust(userCrossSigning);

        const userSSK = userCrossSigning.keys.self_signing;
        const deviceObj = deviceToObject(device, userCrossSigning.userId);
        try {
            pkVerify(userSSK, userCrossSigning.getId(), userCrossSigning.userId);
            pkVerify(deviceObj, getPublicKey(userSSK)[1], userCrossSigning.userId);
            return userTrust;
        } catch (e) {
            return 0;
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
    MASTER: 7,
    SELF_SIGNING: 1,
    USER_SIGNING: 2,
};

export const CrossSigningVerification = {
    UNVERIFIED: 0,
    TOFU: 1,
    VERIFIED: 2,
};
