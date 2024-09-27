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

/**
 * An AES-encrypted secret storage payload.
 * See https://spec.matrix.org/v1.11/client-server-api/#msecret_storagev1aes-hmac-sha2-1
 */
export interface AESEncryptedSecretStoragePayload {
    [key: string]: any; // extensible
    /** the initialization vector in base64 */
    iv: string;
    /** the ciphertext in base64 */
    ciphertext: string;
    /** the HMAC in base64 */
    mac: string;
}
