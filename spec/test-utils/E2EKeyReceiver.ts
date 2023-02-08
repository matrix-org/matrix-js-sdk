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

import type { IOneTimeKey } from "../../src/@types/crypto";

/** Interface implemented by classes that intercept `/keys/upload` requests from test clients to catch the uploaded keys
 */
export interface IE2EKeyReceiver {
    /**
     * get the uploaded ed25519 device key
     *
     * @returns base64 device key
     */
    getSigningKey(): string;

    /**
     * get the uploaded curve25519 device key
     *
     * @returns base64 device key
     */
    getDeviceKey(): string;

    /**
     * Wait for one-time-keys to be uploaded, then return them.
     *
     * @returns Promise for the one-time keys
     */
    awaitOneTimeKeyUpload(): Promise<Record<string, IOneTimeKey>>;
}
