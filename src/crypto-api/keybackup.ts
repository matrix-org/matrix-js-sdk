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
import { DeviceTrustLevel } from "../crypto/CrossSigning";
import { DeviceInfo } from "../crypto/deviceinfo";
import { IKeyBackupInfo } from "../crypto/keybackup";

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
 * Extra info of a recovery key
 */
export interface KeyBackupInfo {
    algorithm: string;
    auth_data: ISigned & (Curve25519AuthData | Aes256AuthData);
    count?: number;
    etag?: string;
    version?: string; // number contained within
}

export interface KeyBackupStatus {
    version: string;
    enabled: boolean;
}

export type SigInfo = {
    deviceId: string;
    valid?: boolean | null; // true: valid, false: invalid, null: cannot attempt validation
    device?: DeviceInfo | null;
    crossSigningId?: boolean;
    deviceTrust?: DeviceTrustLevel;
};

export type TrustInfo = {
    usable: boolean; // is the backup trusted, true iff there is a sig that is valid & from a trusted device
    sigs: SigInfo[];
    // eslint-disable-next-line camelcase
    trusted_locally?: boolean;
};

export interface IKeyBackupCheck {
    backupInfo?: IKeyBackupInfo;
    trustInfo: TrustInfo;
}

export interface SecureKeyBackup {
    getKeyBackupStatus(): Promise<KeyBackupStatus | null>;

    stop(): void;

    /**
     * Check the server for an active key backup and
     * if one is present and has a valid signature from
     * one of the user's verified devices, start backing up
     * to it.
     */
    checkAndStart(): Promise<IKeyBackupCheck | null>;
}
