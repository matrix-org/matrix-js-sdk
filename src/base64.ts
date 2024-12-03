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

/**
 * Base64 encoding and decoding utilities
 */

/**
 * Encode a typed array of uint8 as base64.
 * @param uint8Array - The data to encode.
 * @returns The base64.
 */
export function encodeBase64(uint8Array: Uint8Array): string {
    return btoa(uint8Array.reduce((acc, current) => acc + String.fromCharCode(current), ""));
}

/**
 * Encode a typed array of uint8 as unpadded base64.
 * @param uint8Array - The data to encode.
 * @returns The unpadded base64.
 */
export function encodeUnpaddedBase64(uint8Array: Uint8Array): string {
    return encodeBase64(uint8Array).replace(/={1,2}$/, "");
}

/**
 * Encode a typed array of uint8 as unpadded base64 using the URL-safe encoding.
 * @param uint8Array - The data to encode.
 * @returns The unpadded base64.
 */
export function encodeUnpaddedBase64Url(uint8Array: Uint8Array): string {
    return encodeUnpaddedBase64(uint8Array).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Decode a base64 (or base64url) string to a typed array of uint8.
 * @param base64 - The base64 to decode.
 * @returns The decoded data.
 */
export function decodeBase64(base64: string): Uint8Array {
    const itFunc = function* (): Generator<number> {
        const decoded = atob(
            // built-in atob doesn't support base64url: convert so we support either
            base64.replace(/-/g, "+").replace(/_/g, "/"),
        );
        for (let i = 0; i < decoded.length; ++i) {
            yield decoded.charCodeAt(i);
        }
    };
    return Uint8Array.from(itFunc());
}
