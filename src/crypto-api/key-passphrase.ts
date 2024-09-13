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

import { randomString } from "../randomstring.ts";

const DEFAULT_ITERATIONS = 500000;

const DEFAULT_BITSIZE = 256;

/* eslint-enable camelcase */

interface IKey {
    key: Uint8Array;
    salt: string;
    iterations: number;
}

/**
 * Derive a key from a passphrase.
 * @param password
 */
export async function keyFromPassphrase(password: string): Promise<IKey> {
    const salt = randomString(32);

    const key = await deriveKey(password, salt, DEFAULT_ITERATIONS, DEFAULT_BITSIZE);

    return { key, salt, iterations: DEFAULT_ITERATIONS };
}

/**
 * Derive a key from a passphrase using PBKDF2.
 * @param password
 * @param salt
 * @param iterations
 * @param numBits
 */
export async function deriveKey(
    password: string,
    salt: string,
    iterations: number,
    numBits = DEFAULT_BITSIZE,
): Promise<Uint8Array> {
    if (!globalThis.crypto.subtle || !TextEncoder) {
        throw new Error("Password-based backup is not available on this platform");
    }

    const key = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
    );

    const keybits = await globalThis.crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: new TextEncoder().encode(salt),
            iterations: iterations,
            hash: "SHA-512",
        },
        key,
        numBits,
    );

    return new Uint8Array(keybits);
}
