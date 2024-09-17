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

import { deriveRecoveryKeyFromPassphrase } from "../crypto-api/index.ts";

/* eslint-disable camelcase */
interface IAuthData {
    private_key_salt?: string;
    private_key_iterations?: number;
    private_key_bits?: number;
}

/**
 * Derive a backup key from a passphrase using the salt and iterations from the auth data.
 * @param authData - The auth data containing the salt and iterations
 * @param passphrase - The passphrase to derive the key from
 * @deprecated Deriving a backup key from a passphrase is not part of the matrix spec. Instead, a random key is generated and stored/shared via 4S.
 */
export function keyFromAuthData(authData: IAuthData, passphrase: string): Promise<Uint8Array> {
    if (!authData.private_key_salt || !authData.private_key_iterations) {
        throw new Error("Salt and/or iterations not found: " + "this backup cannot be restored with a passphrase");
    }

    return deriveRecoveryKeyFromPassphrase(
        passphrase,
        authData.private_key_salt,
        authData.private_key_iterations,
        authData.private_key_bits,
    );
}
