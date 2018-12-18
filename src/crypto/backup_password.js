/*
Copyright 2018 New Vector Ltd

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

import { randomString } from '../randomstring';

const DEFAULT_ITERATIONS = 500000;

export async function keyForExistingBackup(backupData, password) {
    if (!global.Olm) {
        throw new Error("Olm is not available");
    }

    const authData = backupData.auth_data;

    if (!authData.private_key_salt || !authData.private_key_iterations) {
        throw new Error(
            "Salt and/or iterations not found: " +
            "this backup cannot be restored with a passphrase",
        );
    }

    return await deriveKey(
        password, backupData.auth_data.private_key_salt,
        backupData.auth_data.private_key_iterations,
    );
}

export async function keyForNewBackup(password) {
    if (!global.Olm) {
        throw new Error("Olm is not available");
    }

    const salt = randomString(32);

    const key = await deriveKey(password, salt, DEFAULT_ITERATIONS);

    return { key, salt, iterations: DEFAULT_ITERATIONS };
}

async function deriveKey(password, salt, iterations) {
    const subtleCrypto = global.crypto.subtle;
    const TextEncoder = global.TextEncoder;
    if (!subtleCrypto || !TextEncoder) {
        // TODO: Implement this for node
        throw new Error("Password-based backup is not avaiable on this platform");
    }

    const key = await subtleCrypto.importKey(
        'raw',
        new TextEncoder().encode(password),
        {name: 'PBKDF2'},
        false,
        ['deriveBits'],
    );

    const keybits = await subtleCrypto.deriveBits(
        {
            name: 'PBKDF2',
            salt: new TextEncoder().encode(salt),
            iterations: iterations,
            hash: 'SHA-512',
        },
        key,
        global.Olm.PRIVATE_KEY_LENGTH * 8,
    );

    return new Uint8Array(keybits);
}
