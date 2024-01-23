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

// Export for backward compatibility
import { ImportRoomKeyProgressData } from "../crypto-api";

export type {
    Curve25519AuthData as ICurve25519AuthData,
    Aes256AuthData as IAes256AuthData,
    KeyBackupInfo as IKeyBackupInfo,
    Curve25519SessionData,
    KeyBackupSession as IKeyBackupSession,
    KeyBackupRoomSessions as IKeyBackupRoomSessions,
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
    progressCallback?: (progress: ImportRoomKeyProgressData) => void;
}
