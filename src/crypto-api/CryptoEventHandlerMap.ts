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
import { VerificationRequest } from "./verification.ts";
import { UserVerificationStatus } from "./index.ts";
import { RustBackupCryptoEventMap } from "../rust-crypto/backup.ts";

/**
 * A map of the {@link CryptoEvent} fired by the {@link CryptoApi} and their payloads.
 */
export type CryptoEventHandlerMap = {
    [CryptoEvent.VerificationRequestReceived]: (request: VerificationRequest) => void;
    [CryptoEvent.UserTrustStatusChanged]: (userId: string, userTrustLevel: UserVerificationStatus) => void;
    [CryptoEvent.KeyBackupDecryptionKeyCached]: (version: string) => void;
    [CryptoEvent.KeysChanged]: (data: {}) => void;
    [CryptoEvent.WillUpdateDevices]: (users: string[], initialFetch: boolean) => void;
    [CryptoEvent.DevicesUpdated]: (users: string[], initialFetch: boolean) => void;
} & RustBackupCryptoEventMap;
