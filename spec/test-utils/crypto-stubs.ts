/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { CryptoCallbacks } from "../../src/crypto-api";
import { AddSecretStorageKeyOpts } from "../../src/secret-storage";

/**
 * Create a stub {@link CryptoCallbacks} which caches the secret storage key, and returns it when `getSecretStorageKey` is called
 */
export function createCryptoCallbacks(): CryptoCallbacks {
    let cachedKey: { keyId: string; key: Uint8Array };
    const cacheSecretStorageKey = (keyId: string, keyInfo: AddSecretStorageKeyOpts, key: Uint8Array) => {
        cachedKey = {
            keyId,
            key,
        };
    };

    const getSecretStorageKey = () => Promise.resolve<[string, Uint8Array]>([cachedKey.keyId, cachedKey.key]);

    return {
        cacheSecretStorageKey,
        getSecretStorageKey,
    };
}
