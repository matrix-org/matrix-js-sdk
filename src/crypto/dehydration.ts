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

export const DEHYDRATION_ALGORITHM = "m.dehydration.v1.olm";

export class DehydrationManager {
    constructor(private client) {}
    async cacheDehydrationKey(key, keyInfo = {}): Promise<void> {
        const pickleKey = Buffer.from(this.client._crypto._olmDevice._pickleKey);
        key = await encryptAES(encodeBase64(key), pickleKey, DEHYDRATION_ALGORITHM);
        this.client._crypto._cryptoStore.doTxn(
            'readwrite',
            [IndexedDBCryptoStore.STORE_ACCOUNT],
            (txn) => {
                this.client._crypto._cryptoStore.storeSecretStorePrivateKey(
                    txn, DEHYDRATION_ALGORITHM, {keyInfo, key},
                );
            },
        );
    }
    async dehydrateDevice(): Promise<void> {
        console.log("Attempting to dehydrate device");
        const {keyInfo, key} = await new Promise((resolve) => {
            return this.client._crypto._cryptoStore.doTxn(
                'readonly',
                [IndexedDBCryptoStore.STORE_ACCOUNT],
                (txn) => {
                    this.client._crypto._cryptoStore.getSecretStorePrivateKey(
                        txn, resolve, DEHYDRATION_ALGORITHM,
                    );
                },
            );
        });
        // FIXME: abort nicely if key not found
        const pickleKey = Buffer.from(this.client._crypto._olmDevice._pickleKey);
        const decrypted = await decryptAES(key, pickleKey, DEHYDRATION_ALGORITHM);
        const decryptedKey = decodeBase64(decrypted);

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
        const pickledAccount = account.pickle(decryptedKey);

        const deviceData: {[props: string]: any} = {
            algorithm: DEHYDRATION_ALGORITHM,
            account: pickledAccount,
        };
        if (keyInfo.passphrase) {
            deviceData.passphrase = keyInfo.passphrase;
        }

        console.log("Uploading account to server");
        const dehydrateResult = await this.client._http.authedRequest(
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
            algorithms: this.client._crypto._supportedAlgorithms,
            device_id: deviceId,
            user_id: this.client.credentials.userId,
            keys: {
                [`ed25519:${deviceId}`]: e2eKeys.ed25519,
                [`curve25519:${deviceId}`]: e2eKeys.curve25519,
            },
            signatures: {},
        };
        const deviceSignature = account.sign(anotherjson.stringify(deviceKeys));
        deviceKeys.signatures = {
            [this.client.credentials.userId]: {
                [`ed25519:${deviceId}`]: deviceSignature,
            },
        };
        await this.client._crypto._crossSigningInfo.signObject(deviceKeys, "self_signing");

        console.log("Preparing one-time keys");
        const oneTimeKeys = {};
        for (const [keyId, key] of Object.entries(otks.curve25519)) {
            const k = {key, signatures: {}};
            const signature = account.sign(anotherjson.stringify(k));
            k.signatures = {
                [this.client.credentials.userId]: {
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
                [this.client.credentials.userId]: {
                    [`ed25519:${deviceId}`]: signature,
                },
            };
            fallbackKeys[`signed_curve25519:${keyId}`] = k;
        }

        console.log("Uploading keys to server");
        await this.client._http.authedRequest(
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
    }
}
