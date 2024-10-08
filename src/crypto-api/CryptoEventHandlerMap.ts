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

import { CryptoEvent } from "./CryptoEvent.ts";
import { CryptoEvent as LegacyCryptoEvent } from "../crypto/index.ts";
import { VerificationRequest } from "./verification.ts";
import { UserVerificationStatus } from "./index.ts";
import { RustBackupCryptoEventMap } from "../rust-crypto/backup.ts";

export type CryptoEventHandlerMap = {
    /**
     * Fires when a key verification request is received.
     */
    [CryptoEvent.VerificationRequestReceived]: (request: VerificationRequest) => void;

    /**
     * Fires when the trust status of a user changes.
     */
    [CryptoEvent.UserTrustStatusChanged]: (userId: string, userTrustLevel: UserVerificationStatus) => void;

    [CryptoEvent.KeyBackupDecryptionKeyCached]: (version: string) => void;
    /**
     * Fires when the user's cross-signing keys have changed or cross-signing
     * has been enabled/disabled. The client can use getStoredCrossSigningForUser
     * with the user ID of the logged in user to check if cross-signing is
     * enabled on the account. If enabled, it can test whether the current key
     * is trusted using with checkUserTrust with the user ID of the logged
     * in user. The checkOwnCrossSigningTrust function may be used to reconcile
     * the trust in the account key.
     *
     * The cross-signing API is currently UNSTABLE and may change without notice.
     * @experimental
     */
    [CryptoEvent.KeysChanged]: (data: {}) => void;
    /**
     * Fires whenever the stored devices for a user will be updated
     * @param users - A list of user IDs that will be updated
     * @param initialFetch - If true, the store is empty (apart
     *     from our own device) and is being seeded.
     */
    [LegacyCryptoEvent.WillUpdateDevices]: (users: string[], initialFetch: boolean) => void;
    /**
     * Fires whenever the stored devices for a user have changed
     * @param users - A list of user IDs that were updated
     * @param initialFetch - If true, the store was empty (apart
     *     from our own device) and has been seeded.
     */
    [CryptoEvent.DevicesUpdated]: (users: string[], initialFetch: boolean) => void;
} & RustBackupCryptoEventMap;
