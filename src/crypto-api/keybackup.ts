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
import { IEncryptedPayload } from "../crypto/aes";

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
 * Returned by [`GET /_matrix/client/v3/room_keys/version`](https://spec.matrix.org/v1.7/client-server-api/#get_matrixclientv3room_keysversion)
 * and hence {@link MatrixClient#getKeyBackupVersion}.
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
     * True if, and only if, there is a valid signature on the backup from a trusted device.
     */
    readonly trusted: boolean;

    /**
     * True if this backup matches the stored decryption key.
     */
    readonly matchesDecryptionKey: boolean;
}

/**
 * The result of {@link Crypto.CryptoApi.checkKeyBackupAndEnable}.
 */
export interface KeyBackupCheck {
    backupInfo: KeyBackupInfo;
    trustInfo: BackupTrustInfo;
}

export interface Curve25519SessionData {
    ciphertext: string;
    ephemeral: string;
    mac: string;
}

/* eslint-disable camelcase */
export interface KeyBackupSession<T = Curve25519SessionData | IEncryptedPayload> {
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: T;
}

export interface KeyBackupRoomSessions {
    [sessionId: string]: KeyBackupSession;
}
