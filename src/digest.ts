/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { encodeUnpaddedBase64Url } from "./base64";

/**
 * @param plaintext The string to hash
 * @returns Unpadded base64-url string representing the sha256 hash of the input
 * @throws If the subtle crypto API is not available, for example if the code is running
 *         in a web page with an insecure context (eg. served over plain HTTP).
 */
export async function sha256Base64UrlUnpadded(plaintext: string): Promise<string> {
    if (!globalThis.crypto.subtle) {
        throw new Error("Crypto.subtle is not available: insecure context?");
    }
    const utf8 = new TextEncoder().encode(plaintext);

    const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8);

    return encodeUnpaddedBase64Url(digest);
}
