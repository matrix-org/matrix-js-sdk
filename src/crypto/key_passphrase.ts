/*
Copyright 2018 - 2021 The Matrix.org Foundation C.I.C.

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

import { randomString } from "../randomstring.ts";
import { deriveRecoveryKeyFromPassphrase } from "../crypto-api/index.ts";

const DEFAULT_ITERATIONS = 500000;

interface IKey {
    key: Uint8Array;
    salt: string;
    iterations: number;
}

/**
 * Generate a new recovery key, based on a passphrase.
 * @param passphrase - The passphrase to generate the key from
 */
export async function keyFromPassphrase(passphrase: string): Promise<IKey> {
    const salt = randomString(32);

    const key = await deriveRecoveryKeyFromPassphrase(passphrase, salt, DEFAULT_ITERATIONS);

    return { key, salt, iterations: DEFAULT_ITERATIONS };
}

// Re-export the key passphrase functions to avoid breaking changes
export { deriveRecoveryKeyFromPassphrase as deriveKey };
export { keyFromAuthData } from "../common-crypto/key-passphrase.ts";
