/*
 * Copyright 2024 The Matrix.org Foundation C.I.C.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { decodeBase64 } from "../base64.ts";
import { deriveKeys } from "../rust-crypto/deriveKeys.ts";
import { SecretEncryptedPayload } from "./@types/SecretEncryptedPayload.ts";

/**
 * Decrypt an AES-encrypted string.
 *
 * @param data - the encrypted data, returned by {@link encryptAES}.
 * @param key - the encryption key to use as an input to the HKDF function which is used to derive the AES key. Must
 *    be the same as provided to {@link encryptAES}.
 * @param name - the name of the secret. Also used as an input to the HKDF operation which is used to derive the AES
 *    key, so again must be the same as provided to {@link encryptAES}.
 */
export async function decryptAES(data: SecretEncryptedPayload, key: Uint8Array, name: string): Promise<string> {
    const [aesKey, hmacKey] = await deriveKeys(key, name);

    const ciphertext = decodeBase64(data.ciphertext);

    if (!(await globalThis.crypto.subtle.verify({ name: "HMAC" }, hmacKey, decodeBase64(data.mac), ciphertext))) {
        throw new Error(`Error decrypting secret ${name}: bad MAC`);
    }

    const plaintext = await globalThis.crypto.subtle.decrypt(
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