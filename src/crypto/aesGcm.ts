/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { decodeBase64, encodeBase64 } from './olmlib';

const subtleCrypto = (typeof window !== "undefined" && window.crypto) ?
    (window.crypto.subtle || window.crypto.webkitSubtle) : null;

export interface IEncryptedPayload {
    iv?: string;
    ciphertext?: string;
    mac?: string;
}

// salt for HKDF, with 8 bytes of zeros
const zeroSalt = new Uint8Array(8);

/**
 * encrypt a string in the browser
 *
 * @param {string} data the plaintext to encrypt
 * @param {Uint8Array} key the encryption key to use
 * @param {string} name the name of the secret
 * @param {string} ivStr the initialization vector to use
 */
async function encryptBrowser(data: string, key: Uint8Array, name: string, ivStr?: string): Promise<IEncryptedPayload> {
    let iv: Uint8Array;
    if (ivStr) {
        iv = decodeBase64(ivStr);
    } else {
        iv = new Uint8Array(32);
        window.crypto.getRandomValues(iv);
    }

    const aesKey = await deriveKeysBrowser(key, name);
    const encodedData = new TextEncoder().encode(data);

    const ciphertext = await subtleCrypto.encrypt(
        {
            name: "AES-GCM",
            iv,
        },
        aesKey,
        encodedData,
    );

    return {
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(ciphertext),
    };
}

/**
 * decrypt a string in the browser
 *
 * @param {object} data the encrypted data
 * @param {string} data.ciphertext the ciphertext in base64
 * @param {string} data.iv the initialization vector in base64
 * @param {string} data.mac the HMAC in base64
 * @param {Uint8Array} key the encryption key to use
 * @param {string} name the name of the secret
 */
async function decryptBrowser(data: IEncryptedPayload, key: Uint8Array, name: string): Promise<string> {
    const aesKey = await deriveKeysBrowser(key, name);

    const ciphertext = decodeBase64(data.ciphertext);

    const plaintext = await subtleCrypto.decrypt(
        {
            name: "AES-GCM",
            iv: decodeBase64(data.iv),
        },
        aesKey,
        ciphertext,
    );

    return new TextDecoder().decode(new Uint8Array(plaintext));
}

async function deriveKeysBrowser(key: Uint8Array, name: string): Promise<CryptoKey> {
    const hkdfkey = await subtleCrypto.importKey(
        'raw',
        key,
        { name: "HKDF" },
        false,
        ["deriveBits"],
    );

    const aesKey = await subtleCrypto.deriveBits(
        {
            name: "HKDF",
            salt: zeroSalt,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore: https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/879
            info: (new TextEncoder().encode(name)),
            hash: "SHA-256",
        },
        hkdfkey,
        256,
    );

    const aesProm = subtleCrypto.importKey(
        'raw',
        aesKey,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
    );

    return aesProm;
}

export function encryptAESGCM(data: string, key: Uint8Array, name: string, ivStr?: string): Promise<IEncryptedPayload> {
    if (!subtleCrypto) {
        throw new Error('Subtle crypto not available');
    }
    return encryptBrowser(data, key, name, ivStr);
}

export function decryptAESGCM(data: IEncryptedPayload, key: Uint8Array, name: string): Promise<string> {
    if (!subtleCrypto) {
        throw new Error('Subtle crypto not available');
    }
    return decryptBrowser(data, key, name);
}
