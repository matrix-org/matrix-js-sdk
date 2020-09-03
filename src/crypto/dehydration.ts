/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import {decodeBase64, encodeBase64} from './olmlib';
import {IndexedDBCryptoStore} from '../crypto/store/indexeddb-crypto-store';
import {decryptAES, encryptAES} from './aes';
import anotherjson from "another-json";

export const DEHYDRATION_ALGORITHM = "org.matrix.msc2697.v1.olm.libolm_pickle";

const oneweek = 7 * 24 * 60 * 60 * 1000;

export class DehydrationManager {
    private inProgress: boolean = false;
    private timeoutId: any;
    private key: Uint8Array;
    private keyInfo: {[props: string]: any};
    constructor(private crypto) {
        this.getDehydrationKeyFromCache();
    }
    async getDehydrationKeyFromCache(): Promise<void> {
        return this.crypto._cryptoStore.doTxn(
            'readonly',
            [IndexedDBCryptoStore.STORE_ACCOUNT],
            (txn) => {
                this.crypto._cryptoStore.getSecretStorePrivateKey(
                    txn,
                    async (result) => {
                        if (result) {
                            const {key, keyInfo, time} = result;
                            const pickleKey = Buffer.from(this.crypto._olmDevice._pickleKey);
                            const decrypted = await decryptAES(key, pickleKey, DEHYDRATION_ALGORITHM);
                            this.key = decodeBase64(decrypted);
                            this.keyInfo = keyInfo;
                            const now = Date.now();
                            const delay = Math.max(1, time + oneweek - now);
                            this.timeoutId = global.setTimeout(
                                this.dehydrateDevice.bind(this), delay,
                            );
                        }
                    },
                    DEHYDRATION_ALGORITHM,
                );
            },
        );
    }
    async setDehydrationKey(key: Uint8Array, keyInfo: {[props: string]: any} = {}): Promise<void> {
        if (!key) {
            // unsetting the key -- cancel any pending dehydration task
            if (this.timeoutId) {
                global.clearTimeout(this.timeoutId);
                this.timeoutId = undefined;
            }
            // clear storage
            this.crypto._cryptoStore.doTxn(
                'readwrite',
                [IndexedDBCryptoStore.STORE_ACCOUNT],
                (txn) => {
                    this.crypto._cryptoStore.storeSecretStorePrivateKey(
                        txn, DEHYDRATION_ALGORITHM, null,
                    );
                },
            );
            this.key = undefined;
            this.keyInfo = undefined;
            return;
        }

        // Check to see if it's the same key as before.  If it's different,
        // dehydrate a new device.  If it's the same, we can keep the same
        // device.  (Assume that keyInfo will be the same if the key is the same.)
        let matches: boolean = this.key && key.length == this.key.length;
        for (let i = 0; matches && i < key.length; i++) {
            if (key[i] != this.key[i]) {
                matches = false;
            }
        }
        if (!matches) {
            this.key = key;
            this.keyInfo = keyInfo;
            // start dehydration in the background
            this.dehydrateDevice();
        }
    }
    private async dehydrateDevice(): Promise<void> {
        if (this.inProgress) {
            console.log("Dehydration already in progress -- not starting new dehydration");
            return;
        }
        this.inProgress = true;
        if (this.timeoutId) {
            global.clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        try {
            const pickleKey = Buffer.from(this.crypto._olmDevice._pickleKey);

            // update the crypto store with the timestamp
            const key = await encryptAES(encodeBase64(this.key), pickleKey, DEHYDRATION_ALGORITHM);
            this.crypto._cryptoStore.doTxn(
                'readwrite',
                [IndexedDBCryptoStore.STORE_ACCOUNT],
                (txn) => {
                    this.crypto._cryptoStore.storeSecretStorePrivateKey(
                        txn, DEHYDRATION_ALGORITHM, {keyInfo: this.keyInfo, key, time: Date.now()},
                    );
                },
            );
            console.log("Attempting to dehydrate device");

            console.log("Creating account");
            // create the account and all the necessary keys
            const account = new global.Olm.Account();
            account.create();
            const e2eKeys = JSON.parse(account.identity_keys());

            const maxKeys = account.max_number_of_one_time_keys();
            // FIXME: generate in small batches?
            account.generate_one_time_keys(maxKeys / 2);
            account.generate_fallback_key();
            const otks = JSON.parse(account.one_time_keys());
            const fallbacks = JSON.parse(account.fallback_key());
            account.mark_keys_as_published();

            // dehydrate the account and store it on the server
            const pickledAccount = account.pickle(new Uint8Array(this.key));

            const deviceData: {[props: string]: any} = {
                algorithm: DEHYDRATION_ALGORITHM,
                account: pickledAccount,
            };
            if (this.keyInfo.passphrase) {
                deviceData.passphrase = this.keyInfo.passphrase;
            }

            console.log("Uploading account to server");
            const dehydrateResult = await this.crypto._baseApis._http.authedRequest(
                undefined,
                "POST",
                "/device/dehydrate",
                undefined,
                {
                    device_data: deviceData,
                    // FIXME: initial device name?
                },
                {
                    prefix: "/_matrix/client/unstable/org.matrix.msc2697",
                },
            );

            // send the keys to the server
            const deviceId = dehydrateResult.device_id;
            console.log("Preparing device keys", deviceId);
            const deviceKeys = {
                algorithms: this.crypto._supportedAlgorithms,
                device_id: deviceId,
                user_id: this.crypto._userId,
                keys: {
                    [`ed25519:${deviceId}`]: e2eKeys.ed25519,
                    [`curve25519:${deviceId}`]: e2eKeys.curve25519,
                },
                signatures: {},
            };
            const deviceSignature = account.sign(anotherjson.stringify(deviceKeys));
            deviceKeys.signatures = {
                [this.crypto._userId]: {
                    [`ed25519:${deviceId}`]: deviceSignature,
                },
            };
            if (this.crypto._crossSigningInfo.getId(self_signing)) {
                await this.crypto._crossSigningInfo.signObject(deviceKeys, "self_signing");
            }

            console.log("Preparing one-time keys");
            const oneTimeKeys = {};
            for (const [keyId, key] of Object.entries(otks.curve25519)) {
                const k = {key, signatures: {}};
                const signature = account.sign(anotherjson.stringify(k));
                k.signatures = {
                    [this.crypto._userId]: {
                        [`ed25519:${deviceId}`]: signature,
                    },
                };
                oneTimeKeys[`signed_curve25519:${keyId}`] = k;
            }

            console.log("Preparing fallback keys");
            const fallbackKeys = {};
            for (const [keyId, key] of Object.entries(fallbacks.curve25519)) {
                const k = {key, signatures: {}};
                const signature = account.sign(anotherjson.stringify(k));
                k.signatures = {
                    [this.crypto._userId]: {
                        [`ed25519:${deviceId}`]: signature,
                    },
                };
                fallbackKeys[`signed_curve25519:${keyId}`] = k;
            }

            console.log("Uploading keys to server");
            await this.crypto._baseApis._http.authedRequest(
                undefined,
                "POST",
                "/keys/upload/" + encodeURI(deviceId),
                undefined,
                {
                    device_keys: deviceKeys,
                    one_time_keys: oneTimeKeys,
                    fallback_keys: fallbackKeys,
                },
            );
            console.log("Done");

            // dehydrate again in a week
            this.timeoutId = global.setTimeout(
                this.dehydrateDevice.bind(this), oneweek,
            );
        } finally {
            this.inProgress = false;
        }
    }
}
