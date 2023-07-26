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

import { ISigned } from "../@types/signed";

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
     * Get the current status of key backup.
     *
     * @returns If automatic key backups are enabled, the `version` of the active backup. Otherwise, `null`.
     */
    getActiveBackupVersion(): Promise<string | null>;
}

/**
 * The result of {@link SecureKeyBackup.checkAndStart}.
 */
export interface KeyBackupCheck {
    /** Information from the server about the backup. `undefined` if there is no active backup. */
    backupInfo?: KeyBackupInfo;

    /** Information on whether we trust this backup. */
    trustInfo: BackupTrustInfo;
}

export interface Curve25519AuthData {
    public_key: string;
    private_key_salt?: string;
    private_key_iterations?: number;
    private_key_bits?: number;
}

export interface Aes256AuthData {
    iv: string;
    mac: string;
    private_key_salt?: string;
    private_key_iterations?: number;
}

/**
 * Information about a server-side key backup.
 *
 * Returned by `GET /_matrix/client/v3/room_keys/version`
 * (see https://spec.matrix.org/v1.7/client-server-api/#get_matrixclientv3room_keysversion).
 */
export interface KeyBackupInfo {
    algorithm: string;
    auth_data: ISigned & (Curve25519AuthData | Aes256AuthData);
    count?: number;
    etag?: string;
    version?: string; // number contained within
}

/**
 * Information on whether a given server-side backup is trusted.
 */
export interface BackupTrustInfo {
    /**
     * Is this backup trusted?
     *
     * True if, and only if, there is a valid signature on the backup from a trusted device
     */
    readonly usable: boolean;
}
