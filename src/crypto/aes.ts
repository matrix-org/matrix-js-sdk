/*
Copyright 2020 - 2021 The Matrix.org Foundation C.I.C.

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

import { decodeBase64, encodeBase64 } from "../base64.ts";

// salt for HKDF, with 8 bytes of zeros
const zeroSalt = new Uint8Array(8);

export interface IEncryptedPayload {
    [key: string]: any; // extensible
    /** the initialization vector in base64 */
    iv: string;
    /** the ciphertext in base64 */
    ciphertext: string;
    /** the HMAC in base64 */
    mac: string;
}

/**
 * Encrypt a string using AES-CTR.
 *
 * @param data - the plaintext to encrypt
 * @param key - the encryption key to use as an input to the HKDF function which is used to derive the AES key for
 *    encryption. Obviously, the same key must be provided when decrypting.
 * @param name - the name of the secret. Used as an input to the HKDF operation which is used to derive the AES key,
 *    so again the same value must be provided when decrypting.
 * @param ivStr - the base64-encoded initialization vector to use. If not supplied, a random one will be generated.
 *
 * @returns The encrypted result, including the ciphertext itself, the initialization vector (as supplied in `ivStr`,
 *   or generated), and an HMAC on the ciphertext — all base64-encoded.
 */
export async function encryptAES(
    data: string,
    key: Uint8Array,
    name: string,
    ivStr?: string,
): Promise<IEncryptedPayload> {
    let iv: Uint8Array;
    if (ivStr) {
        iv = decodeBase64(ivStr);
    } else {
        iv = new Uint8Array(16);
        globalThis.crypto.getRandomValues(iv);

        // clear bit 63 of the IV to stop us hitting the 64-bit counter boundary
        // (which would mean we wouldn't be able to decrypt on Android). The loss
        // of a single bit of iv is a price we have to pay.
        iv[8] &= 0x7f;
    }

    const [aesKey, hmacKey] = await deriveKeys(key, name);
    const encodedData = new TextEncoder().encode(data);

    const ciphertext = await globalThis.crypto.subtle.encrypt(
        {
            name: "AES-CTR",
            counter: iv,
            length: 64,
        },
        aesKey,
        encodedData,
    );

    const hmac = await globalThis.crypto.subtle.sign({ name: "HMAC" }, hmacKey, ciphertext);

    return {
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(ciphertext),
        mac: encodeBase64(hmac),
    };
}

/**
 * Decrypt an AES-encrypted string.
 *
 * @param data - the encrypted data, returned by {@link encryptAES}.
 * @param key - the encryption key to use as an input to the HKDF function which is used to derive the AES key. Must
 *    be the same as provided to {@link encryptAES}.
 * @param name - the name of the secret. Also used as an input to the HKDF operation which is used to derive the AES
 *    key, so again must be the same as provided to {@link encryptAES}.
 */
export async function decryptAES(data: IEncryptedPayload, key: Uint8Array, name: string): Promise<string> {
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

async function deriveKeys(key: Uint8Array, name: string): Promise<[CryptoKey, CryptoKey]> {
    const hkdfkey = await globalThis.crypto.subtle.importKey("raw", key, { name: "HKDF" }, false, ["deriveBits"]);
    const keybits = await globalThis.crypto.subtle.deriveBits(
        {
            name: "HKDF",
            salt: zeroSalt,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore: https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/879
            info: new TextEncoder().encode(name),
            hash: "SHA-256",
        },
        hkdfkey,
        512,
    );

    const aesKey = keybits.slice(0, 32);
    const hmacKey = keybits.slice(32);

    const aesProm = globalThis.crypto.subtle.importKey("raw", aesKey, { name: "AES-CTR" }, false, [
        "encrypt",
        "decrypt",
    ]);

    const hmacProm = globalThis.crypto.subtle.importKey(
        "raw",
        hmacKey,
        {
            name: "HMAC",
            hash: { name: "SHA-256" },
        },
        false,
        ["sign", "verify"],
    );

    return Promise.all([aesProm, hmacProm]);
}

// string of zeroes, for calculating the key check
const ZERO_STR = "\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

/** Calculate the MAC for checking the key.
 *
 * @param key - the key to use
 * @param iv - The initialization vector as a base64-encoded string.
 *     If omitted, a random initialization vector will be created.
 * @returns An object that contains, `mac` and `iv` properties.
 */
export function calculateKeyCheck(key: Uint8Array, iv?: string): Promise<IEncryptedPayload> {
    return encryptAES(ZERO_STR, key, "", iv);
}
