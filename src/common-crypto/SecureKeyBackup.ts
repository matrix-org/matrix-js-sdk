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

import { IPreparedKeyBackupVersion, KeyBackupInfo } from "../crypto-api/keybackup";

/**
 * Interface to server-side key backup
 *
 * Server-side key backup, aka "secure (key) backup" or "session backup", is a feature in which devices save copies of
 * the megolm session keys that they receive on the server. The keys are encrypted with the public part of an asymmetric
 * key, which makes it easy for devices to add newly-received session keys. In future, if the user logs in on another
 * device which lacks history, the backup can be restored by providing the private part of the key (the "backup
 * decryption key"), thus providing access to historical messages.
 *
 * (The backup decryption key is normally retrieved from server-side-secret-storage (4S) or gossipped between devices
 * using secret sharing, rather than being entered directly).
 *
 * @see https://spec.matrix.org/v1.7/client-server-api/#server-side-key-backups
 * @internal
 */
export interface SecureKeyBackup {
    /**
     * Check the server for an active key backup.
     *
     * If a key backup is present, and has a valid signature from one of the user's verified devices, start backing up
     * to it.
     *
     * @returns `null` if there was an error checking for an active backup; otherwise, information about the active backup
     *    (or lack thereof).
     */
    checkAndStart(): Promise<KeyBackupCheck | null>;

    /**
     * Set up the data required to create a new backup version.  The backup version
     * will not be created and enabled until createKeyBackupVersion is called.
     *
     * @param password - Passphrase string that can be entered by the user
     *     when restoring the backup as an alternative to entering the recovery key.
     *     Optional. If null a random recovery key will be created
     *
     * @returns Object that can be passed to createKeyBackupVersion and
     *     additionally has a 'recovery_key' member with the user-facing recovery key string. The backup data is not yet signed, the cryptoBackend will do it.
     */
    prepareUnsignedKeyBackupVersion(
        key?: string | Uint8Array | null,
        algorithm?: string | undefined,
    ): Promise<IPreparedKeyBackupVersion>;

    createKeyBackupVersion(info: KeyBackupInfo): Promise<void>;
}

/**
 * The result of {@link SecureKeyBackup.checkAndStart}.
 *
 * @internal
 */
export interface KeyBackupCheck {
    /** Information from the server about the backup. `undefined` if there is no active backup. */
    backupInfo?: KeyBackupInfo;

    /** Information on whether we trust this backup. */
    trustInfo: BackupTrustInfo;
}

/**
 * Information on whether a given server-side backup is trusted.
 *
 * @internal
 */
export interface BackupTrustInfo {
    /**
     * Is this backup trusted?
     *
     * True if, and only if, there is a valid signature on the backup from a trusted device
     */
    readonly usable: boolean;
}
