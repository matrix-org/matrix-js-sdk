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
export function encodeBase64(uint8Array: ArrayBuffer | Uint8Array): string {
    // A brief note on the state of base64 encoding in Javascript.
    // As of 2023, there is still no common native impl between both browsers and
    // node. Older Webpack provides an impl for Buffer and there is a polyfill class
    // for it. There are also plenty of pure js impls, eg. base64-js which has 2336
    // dependents at current count. Using this would probably be fine although it's
    // a little under-docced and run by an individual. The node impl works fine,
    // the browser impl works but predates Uint8Array and so only uses strings.
    // Right now, switching between native (or polyfilled) impls like this feels
    // like the least bad option, but... *shrugs*.
    if (typeof Buffer === "function") {
        return Buffer.from(uint8Array).toString("base64");
    } else if (typeof btoa === "function" && uint8Array instanceof Uint8Array) {
        // ArrayBuffer is a node concept so the param should always be a Uint8Array on
        // the browser. We need to check because ArrayBuffers don't have reduce.
        return btoa(uint8Array.reduce((acc, current) => acc + String.fromCharCode(current), ""));
    } else {
        throw new Error("No base64 impl found!");
    }
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
 * Encode a typed array of uint8 as unpadded base64 using the URL-safe encoding.
 * @param uint8Array - The data to encode.
 * @returns The unpadded base64.
 */
export function encodeUnpaddedBase64Url(uint8Array: ArrayBuffer | Uint8Array): string {
    return encodeUnpaddedBase64(uint8Array).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Decode a base64 (or base64url) string to a typed array of uint8.
 * @param base64 - The base64 to decode.
 * @returns The decoded data.
 */
export function decodeBase64(base64: string): Uint8Array {
    // See encodeBase64 for a short treatise on base64 en/decoding in JS
    if (typeof Buffer === "function") {
        return Buffer.from(base64, "base64");
    } else if (typeof atob === "function") {
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
    } else {
        throw new Error("No base64 impl found!");
    }
}
