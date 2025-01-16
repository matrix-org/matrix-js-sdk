/*
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import { encodeUnpaddedBase64Url } from "./base64.ts";

export const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DIGITS = "0123456789";

export function secureRandomBase64Url(len: number): string {
    const key = new Uint8Array(len);
    globalThis.crypto.getRandomValues(key);

    return encodeUnpaddedBase64Url(key);
}

/**
 * Generates a random string of uppercase and lowercase letters plus digits using a
 * cryptographically secure random number generator.
 * @param len The length of the string to generate
 * @returns Random string of uppercase and lowercase letters plus digits of length `len`
 */
export function secureRandomString(len: number): string {
    return secureRandomStringFrom(len, UPPERCASE + LOWERCASE + DIGITS);
}

/**
 * Generate a cryptographically secure random string using characters given
 * @param len The length of the string to generate
 * @param chars The characters to use in the random string.
 * @returns Random string of characters of length `len`
 */
export function secureRandomStringFrom(len: number, chars: string): string {
    const positions = new Uint32Array(chars.length);
    let ret = "";
    crypto.getRandomValues(positions);
    for (let i = 0; i < len; i++) {
        const currentCharPlace = positions[i % chars.length] % chars.length;
        ret += chars[currentCharPlace];
    }
    return ret;
}
