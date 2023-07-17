/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { DeviceInfo } from "./deviceinfo";

/* re-exports for backwards compatibility. */
// CrossSigningKey is used as a value in `client.ts`, we can't export it as a type
export { CrossSigningKey } from "../crypto-api";
export type {
    GeneratedSecretStorageKey as IRecoveryKey,
    CreateSecretStorageOpts as ICreateSecretStorageOpts,
} from "../crypto-api";

export type {
    ImportRoomKeyProgressData as IImportOpts,
    ImportRoomKeysOpts as IImportRoomKeysOpts,
} from "../crypto-api";

export type {
    AddSecretStorageKeyOpts as IAddSecretStorageKeyOpts,
    PassphraseInfo as IPassphraseInfo,
    SecretStorageKeyDescription as ISecretStorageKeyInfo,
} from "../secret-storage";

// TODO: Merge this with crypto.js once converted

export interface IEncryptedEventInfo {
    /**
     * whether the event is encrypted (if not encrypted, some of the other properties may not be set)
     */
    encrypted: boolean;

    /**
     * the sender's key
     */
    senderKey: string;

    /**
     * the algorithm used to encrypt the event
     */
    algorithm: string;

    /**
     * whether we can be sure that the owner of the senderKey sent the event
     */
    authenticated: boolean;

    /**
     * the sender's device information, if available
     */
    sender?: DeviceInfo;

    /**
     * if the event's ed25519 and curve25519 keys don't match (only meaningful if `sender` is set)
     */
    mismatchedSender: boolean;
}
