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

/**
 * Defines m.dmls encryption/decryption
 */

import { DecryptionAlgorithm, EncryptionAlgorithm, registerAlgorithm } from "./base";
import { Room } from "../../models/room";
import { IContent, MatrixEvent } from "../../models/event";
import { Crypto, IEncryptedContent, IEventDecryptionResult } from "..";
import { UnstableValue } from "../../NamespacedValue";
import * as matrix_dmls from "matrix-dmls-wasm";

export const MLS_ALGORITHM = new UnstableValue(
    "m.mls.v1.dhkemx25519-aes128gcm-sha256-ed25519",
    "org.matrix.msc2883.v0.mls.dhkemx25519-aes128gcm-sha256-ed25519",
);
//const INIT_KEY_ALGORITHM = new UnstableValue("org.matrix.msc2883.v0.mls.init_key");
//const WELCOME_PACKAGE = new UnstableValue("org.matrix.msc2883.v0.mls.welcome.dhkemx25519-aes128gcm-sha256-ed25519");

let textEncoder = new TextEncoder();
//let textDecoder = new TextDecoder();

class MlsEncryption extends EncryptionAlgorithm {
    public async encryptMessage(room: Room, eventType: string, content: IContent): Promise<IEncryptedContent> {
        return {
            algorithm: MLS_ALGORITHM.name,
            ciphertext: "",
            epoch_creator: "",
        }
    }
}

class MlsDecryption extends DecryptionAlgorithm {
    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        return {
            clearEvent: {
                room_id: this.roomId,
                type: "m.room.message",
                content: {
                    body: "Decryption doesn't work yet.",
                },
            }
        }
    }
}

export class MlsProvider {
    private readonly groups: Map<string, matrix_dmls.DmlsGroup>;
    private readonly storage: Map<string, number[]> ;
    private readonly backend: matrix_dmls.DmlsCryptoProvider;
    public readonly credential: matrix_dmls.Credential;

    constructor(public readonly crypto: Crypto) {
        // FIXME: we should persist groups
        this.groups = new Map();
        // FIXME: this should go in the cryptostorage
        // FIXME: DmlsCryptoProvider should also use cryptostorage
        this.storage = new Map();
        this.backend = new matrix_dmls.DmlsCryptoProvider(this.store.bind(this), this.read.bind(this));
        let baseApis = crypto.baseApis;
        this.credential = new matrix_dmls.Credential(
            this.backend,
            textEncoder.encode(baseApis.getUserId() + "|" + baseApis.getDeviceId()),
        );
    }

    static key_to_string([group_id_arr, epoch, creator_arr]: [number[], number, number[]]): string {
        let group_id = new Uint8Array(group_id_arr);
        let creator = new Uint8Array(creator_arr);
        return olmlib.encodeUnpaddedBase64(group_id) + "|" + epoch + "|" + olmlib.encodeUnpaddedBase64(creator);
    }

    store(key: [number[], number, number[]], value: number[]): void {
        this.storage.set(MlsProvider.key_to_string(key), value);
    }

    read(key: [number[], number, number[]]): number[] | undefined {
        return this.storage.get(MlsProvider.key_to_string(key));
    }

    createGroup(roomId: string): matrix_dmls.DmlsGroup {
        const group = new matrix_dmls.DmlsGroup(this.backend, this.credential, textEncoder.encode(roomId))
        this.groups.set(roomId, group);
        return group;
    }

    processWelcome(welcome: string): void {
        // FIXME:
    }

    getGroup(roomId: string): matrix_dmls.DmlsGroup | undefined {
        return this.groups.get(roomId);
    }
}

registerAlgorithm(MLS_ALGORITHM.name, MlsEncryption, MlsDecryption);
