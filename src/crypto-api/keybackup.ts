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

export type AuthData = KeyBackupInfo["auth_data"];

/**
 * Prepared backup data.
 * Contains the data needed to create a new version.
 */
/* eslint-disable camelcase */
export interface IPreparedKeyBackupVersion {
    algorithm: string;
    auth_data: AuthData;
    recovery_key: string;
    privateKey: Uint8Array;
}
/* eslint-enable camelcase */
