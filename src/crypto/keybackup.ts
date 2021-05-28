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

import { ISignatures } from "../@types/signed";
import { DeviceInfo } from "./deviceinfo";

export interface IKeyBackupSession {
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: {
        ciphertext: string;
        ephemeral: string;
        mac: string;
    };
}

export interface IKeyBackupRoomSessions {
    [sessionId: string]: IKeyBackupSession;
}

export interface IKeyBackupVersion {
    algorithm: string;
    auth_data: {
        public_key: string;
        signatures: ISignatures;
    };
    count: number;
    etag: string;
    version: string; // number contained within
}

// TODO: Verify types
export interface IKeyBackupTrustInfo {
    /**
     * is the backup trusted, true if there is a sig that is valid & from a trusted device
     */
    usable: boolean[];
    sigs: {
        valid: boolean[];
        device: DeviceInfo[];
    }[];
}

export interface IKeyBackupPrepareOpts {
    secureSecretStorage: boolean;
}

export interface IKeyBackupRestoreResult {
    total: number;
    imported: number;
}

export interface IKeyBackupRestoreOpts {
    cacheCompleteCallback?: () => void;
    progressCallback?: ({stage: string}) => void;
}
