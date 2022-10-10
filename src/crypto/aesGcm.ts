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

import type { IEncryptedPayload } from './aes';
import { decodeBase64, encodeBase64 } from './olmlib';

const subtleCrypto = (typeof window !== "undefined" && window.crypto) ?
    (window.crypto.subtle || window.crypto.webkitSubtle) : null;

/**
 * encrypt a string in the browser
 *
 * @param {string} data the plaintext to encrypt
 * @param {Uint8Array} key the encryption key to use
 * @param {string} ivStr the initialization vector to use
 */
async function encryptBrowser(data: string, key: Uint8Array, ivStr?: string): Promise<IEncryptedPayload> {
    if (!subtleCrypto) {
        throw new Error('Subtle crypto not available');
    }

    let iv: Uint8Array;
    if (ivStr) {
        iv = decodeBase64(ivStr);
    } else {
        iv = new Uint8Array(32);
        window.crypto.getRandomValues(iv);
    }

    const aesKey = await importKey(key);
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
 * @param {Uint8Array} key the encryption key to use
 */
async function decryptBrowser(data: IEncryptedPayload, key: Uint8Array): Promise<string> {
    if (!subtleCrypto) {
        throw new Error('Subtle crypto not available');
    }

    if (!data.ciphertext || !data.iv) {
        throw new Error('Missing ciphertext and/or iv');
    }

    const aesKey = await importKey(key);

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

async function importKey(key: Uint8Array): Promise<CryptoKey> {
    if (!subtleCrypto) {
        throw new Error('Subtle crypto not available');
    }

    const imported = subtleCrypto.importKey(
        'raw',
        key,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
    );

    return imported;
}

export function encryptAESGCM(data: string, key: Uint8Array, ivStr?: string): Promise<IEncryptedPayload> {
    return encryptBrowser(data, key, ivStr);
}

export function decryptAESGCM(data: IEncryptedPayload, key: Uint8Array): Promise<string> {
    return decryptBrowser(data, key);
}
