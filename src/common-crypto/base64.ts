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
 * Base64 encoding and decoding utility for crypo.
 */

/**
 * Encode a typed array of uint8 as base64.
 * @param uint8Array - The data to encode.
 * @returns The base64.
 */
export function encodeBase64(uint8Array: ArrayBuffer | Uint8Array): string {
    return Buffer.from(uint8Array).toString("base64");
}

/**
 * Encode a typed array of uint8 as unpadded base64.
 * @param uint8Array - The data to encode.
 * @returns The unpadded base64.
 */
export function encodeUnpaddedBase64(uint8Array: ArrayBuffer | Uint8Array): string {
    return encodeBase64(uint8Array).replace(/={1,2}$/, "");
}

/**
 * Decode a base64 string to a typed array of uint8.
 * @param base64 - The base64 to decode.
 * @returns The decoded data.
 */
export function decodeBase64(base64: string): Uint8Array {
    return Buffer.from(base64, "base64");
}
