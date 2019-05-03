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
        return getPublicKey(this.keys.selfSigning)[1];
    }

    async resetKeys(level) {
        if (level === undefined) {
            level = CrossSigningLevel.SELF_SIGNING;
        }

        const privateKeys = {};
        const keys = {};
        let sskSigning;
        let sskPub;
        switch (level) {
        case CrossSigningLevel.SELF_SIGNING: {
            sskSigning = new global.Olm.PkSigning();
            privateKeys.selfSigning = sskSigning.generate_seed();
            sskPub = sskSigning.init_with_seed(privateKeys.selfSigning);
            keys.selfSigning = {
                user_id: this.userId,
                usage: ['self_signing'],
                keys: {
                    ['ed25519:' + sskPub]: sskPub,
                },
            };
            if (this.keys.selfSigning) {
                keys.selfSigning.replaces = getPublicKey(this.keys.selfSigning)[1];

                // try to get ssk private key
                const [oldPubkey, oldSskSigning]
                      = await getPrivateKey(this, "self_signing", (pubkey) => {
                          // make sure it agrees with the pubkey that we have
                          if (pubkey !== keys.selfSigning.replaces) {
                              return "Key does not match";
                          }
                          return;
                      });
                if (oldSskSigning) {
                    pkSign(keys.selfSigning, oldSskSigning, this.userId, oldPubkey);
                }
            }
        }
        // fall through
        case CrossSigningLevel.USER_SIGNING: {
            if (!sskSigning) {
                // if we didn't generate a new SSK above, then we need to ask
                // the client to provide the private key so that we can sign
                // the new USK
                [sskPub, sskSigning] = await getPrivateKey(this, "self_signing", (pubkey) => {
                    // make sure it agrees with the pubkey that we have
                    if (pubkey !== getPublicKey(this.keys.selfSigning)[1]) {
                        return "Key does not match";
                    }
                    return;
                });
            }
            const uskSigning = new global.Olm.PkSigning();
            privateKeys.userSigning = uskSigning.generate_seed();
            const uskPub = uskSigning.init_with_seed(privateKeys.userSigning);
            keys.userSigning = {
                user_id: this.userId,
                usage: ['user_signing'],
                keys: {
                    ['ed25519:' + uskPub]: uskPub,
                },
            };
            pkSign(keys.userSigning, sskSigning, this.userId, sskPub);
            break;
        }
        default:
            // FIXME:
        }
        Object.assign(this.keys, keys);
        this.emit("cross-signing:savePrivateKeys", privateKeys);
    }

    setKeys(keys) {
        const signingKeys = {};
        if (keys.selfSigning) {
            if (this.keys.selfSigning) {
                const [oldKeyId, oldKey] = getPublicKey(this.keys.selfSigning);
                // check if ssk is signed by previous key
                // if the signature checks out, then keep the same First-Use status
                // otherwise First-Use is false
                if (keys.selfSigning.signatures
                    && keys.selfSigning.signatures[this.userId]
                    && keys.selfSigning.signatures[this.userId][oldKeyId]) {
                    try {
                        pkVerify(keys.selfSigning, oldKey, this.userId);
                    } catch (e) {
                        this.fu = false;
                    }
                } else {
                    this.fu = false;
                }
            } else {
                // this is the first key that we're setting, so First-Use is true
                this.fu = true;
            }
            signingKeys.selfSigning = keys.selfSigning;
        } else {
            signingKeys.selfSigning = this.keys.selfSigning;
        }
        // FIXME: if self-signing key is set, then a new user-signing key must
        // be set as well
        if (keys.userSigning) {
            const usk = getPublicKey(signingKeys.selfSigning)[1];
            try {
                pkVerify(keys.userSigning, usk, this.userId);
            } catch (e) {
                // FIXME: what do we want to do here?
                throw e;
            }
        }

        // if everything checks out, then save the keys
        if (keys.selfSigning) {
            this.keys.selfSigning = keys.selfSigning;
        }
        if (keys.userSigning) {
            this.keys.userSigning = keys.userSigning;
        }
    }

    async signUser(key) {
        const [pubkey, usk] = await getPrivateKey(this, "user_signing", (key) => {
            return;
        });
        const otherSsk = key.keys.selfSigning;
        pkSign(otherSsk, usk, this.userId, pubkey);
        return otherSsk;
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
        const userSSK = userCrossSigning.keys.selfSigning;
        const uskId = getPublicKey(this.keys.userSigning)[1];
        try {
            pkVerify(userSSK, uskId, this.userId);
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

        const deviceObj = deviceToObject(device, userCrossSigning.userId);
        try {
            pkVerify(deviceObj, userCrossSigning.getId(), userCrossSigning.userId);
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
    SELF_SIGNING: 1,
    USER_SIGNING: 2,
};

export const CrossSigningVerification = {
    UNVERIFIED: 0,
    TOFU: 1,
    VERIFIED: 2,
};
