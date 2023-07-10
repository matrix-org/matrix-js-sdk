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

import { IEncryptedPayload } from "./aes";

export interface Curve25519SessionData {
    ciphertext: string;
    ephemeral: string;
    mac: string;
}

/* eslint-disable camelcase */
export interface IKeyBackupSession<T = Curve25519SessionData | IEncryptedPayload> {
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: T;
}

export interface IKeyBackupRoomSessions {
    [sessionId: string]: IKeyBackupSession;
}

// Export for backward compatibility
export type {
    Curve25519AuthData as ICurve25519AuthData,
    Aes256AuthData as IAes256AuthData,
    KeyBackupInfo as IKeyBackupInfo,
} from "../crypto-api/keybackup";

/* eslint-enable camelcase */

export interface IKeyBackupPrepareOpts {
    /**
     * Whether to use Secure Secret Storage to store the key encrypting key backups.
     * Optional, defaults to false.
     */
    secureSecretStorage: boolean;
}

export interface IKeyBackupRestoreResult {
    total: number;
    imported: number;
}

export interface IKeyBackupRestoreOpts {
    cacheCompleteCallback?: () => void;
    progressCallback?: (progress: { stage: string }) => void;
}
