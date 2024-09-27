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

import { encryptAES } from "./encryptAES.ts";
import { AESEncryptedSecretStoragePayload } from "../@types/AESEncryptedSecretStoragePayload.ts";

// string of zeroes, for calculating the key check
const ZERO_STR = "\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

/** Calculate the MAC for checking the key.
 *
 * @param key - the key to use
 * @param iv - The initialization vector as a base64-encoded string.
 *     If omitted, a random initialization vector will be created.
 * @returns An object that contains, `mac` and `iv` properties.
 */
export function calculateKeyCheck(key: Uint8Array, iv?: string): Promise<AESEncryptedSecretStoragePayload> {
    return encryptAES(ZERO_STR, key, "", iv);
}
