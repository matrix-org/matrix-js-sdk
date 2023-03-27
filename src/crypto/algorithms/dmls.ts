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

import { DecryptionAlgorithm, DecryptionError, EncryptionAlgorithm, registerAlgorithm } from "./base";
import { Room } from "../../models/room";
import { IContent, MatrixEvent } from "../../models/event";
import { Crypto, IEncryptedContent, IEventDecryptionResult } from "..";
import { UnstableValue } from "../../NamespacedValue";
import * as matrix_dmls from "matrix-dmls-wasm";
import * as olmlib from "../olmlib";

export const MLS_ALGORITHM = new UnstableValue(
    "m.mls.v1.dhkemx25519-aes128gcm-sha256-ed25519",
    "org.matrix.msc2883.v0.mls.dhkemx25519-aes128gcm-sha256-ed25519",
);
export const INIT_KEY_ALGORITHM = new UnstableValue(
    "m.mls.v1.init_key.dhkemx25519",
    "org.matrix.msc2883.v0.mls.init_key.dhkemx25519",
);
export const WELCOME_PACKAGE = new UnstableValue(
    "m.mls.v1.welcome.dhkemx25519-aes128gcm-sha256-ed25519",
    "org.matrix.msc2883.v0.mls.welcome.dhkemx25519-aes128gcm-sha256-ed25519",
);

let textEncoder = new TextEncoder();
let textDecoder = new TextDecoder("utf-8", {fatal: true});

class MlsEncryption extends EncryptionAlgorithm {
    public async encryptMessage(room: Room, eventType: string, content: IContent): Promise<IEncryptedContent> {
        const mlsProvider = this.crypto.mlsProvider;
        if (!this.roomId) {
            throw "No room ID";
        }
        const group = mlsProvider.getGroup(this.roomId);
        if (!group) {
            throw "No group available";
        }
        // TODO: check if membership needs syncing, if group needs resolving
        const payload = textEncoder.encode(JSON.stringify({
            room_id: this.roomId,
            type: eventType,
            content: content,
        }));
        const [ciphertext, _epoch, creator] = group.encrypt_message(mlsProvider.backend!, payload);
        return {
            algorithm: MLS_ALGORITHM.name,
            ciphertext: olmlib.encodeUnpaddedBase64(Uint8Array.from(ciphertext)),
            epoch_creator: olmlib.encodeUnpaddedBase64(Uint8Array.from(creator)),
        }
    }
}

class MlsDecryption extends DecryptionAlgorithm {
    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const content = event.getWireContent();
        if (typeof(content.ciphertext) !== "string" || typeof(content.epoch_creator) !== "string") {
            throw new DecryptionError("MLS_MISSING_FIELDS", "Missing or invalid fields in input");
        }
        const mlsProvider = this.crypto.mlsProvider;
        if (!this.roomId) {
            throw "No room ID";
        }
        const group = mlsProvider.getGroup(this.roomId);
        if (!group) {
            throw "No group available";
        }
        const ciphertext = olmlib.decodeBase64(content.ciphertext);
        const epoch_creator = olmlib.decodeBase64(content.epoch_creator);
        const unverified_message = group.parse_message(
            ciphertext,
            epoch_creator,
            mlsProvider.backend!,
        );
        const processed_message = group.process_unverified_message(
            unverified_message,
            epoch_creator,
            mlsProvider.backend!,
        );
        if (processed_message.is_application_message()) {
            const messageArr = processed_message.as_application_message();
            console.log(messageArr);
            const clearEvent = JSON.parse(textDecoder.decode(Uint8Array.from(messageArr)));
            if (typeof(clearEvent.room_id) !== "string" ||
                typeof(clearEvent.type) !== "string" ||
                typeof(clearEvent.content) !== "object") {
            throw new DecryptionError("MLS_MISSING_FIELDS", "Missing or invalid fields in plaintext");
            }
            return {
                clearEvent
            }
        } else if (processed_message.is_staged_commit()) {
            // FIXME:
            throw new DecryptionError("MLS_MISSING_FIELDS", "Handling commits not implemented yet");
        } else {
            throw new DecryptionError("MLS_MISSING_FIELDS", "Unknown MLS message type");
        }
    }
}

class WelcomeEncryption extends EncryptionAlgorithm {
    public async encryptMessage(room: Room, eventType: string, content: IContent): Promise<IEncryptedContent> {
        throw new Error("Encrypt not supported for welcome message");
    }
}

class WelcomeDecryption extends DecryptionAlgorithm {
    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const content = event.getWireContent();
        console.log("Got welcome", content);
        // FIXME: check that it's a to-device event
        if (typeof(content.ciphertext) !== "string" || typeof(content.creator) !== "string") {
            throw new DecryptionError("MLS_WELCOME_MISSING_FIELDS", "Missing or invalid fields in input");
        }
        this.crypto.mlsProvider.processWelcome(content.ciphertext, content.creator);
        // welcome packages don't have any visible representation and don't get
        // processed further
        return {
            clearEvent: {
                type: "m.dummy",
                content: {},
            }
        }
    }
}

export class MlsProvider {
    private readonly groups: Map<string, matrix_dmls.DmlsGroup>;
    private readonly storage: Map<string, number[]> ;
    public backend?: matrix_dmls.DmlsCryptoProvider;
    public credential?: matrix_dmls.Credential;

    constructor(public readonly crypto: Crypto) {
        // FIXME: we should persist groups
        this.groups = new Map();
        // FIXME: this should go in the cryptostorage
        // FIXME: DmlsCryptoProvider should also use cryptostorage
        this.storage = new Map();
    }

    async init(): Promise<void> {
        await matrix_dmls.initAsync();
        this.backend = new matrix_dmls.DmlsCryptoProvider(this.store.bind(this), this.read.bind(this));
        let baseApis = this.crypto.baseApis;
        this.credential = new matrix_dmls.Credential(
            this.backend!,
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

    async createGroup(room: Room, invite: string[]): Promise<matrix_dmls.DmlsGroup> {
        let baseApis = this.crypto.baseApis;

        const group = new matrix_dmls.DmlsGroup(this.backend!, this.credential!, textEncoder.encode(room.roomId))
        this.groups.set(room.roomId, group);

        const userId = baseApis.getUserId()!;
        // FIXME: also get keys for invitees
        const deviceMap = await this.crypto.deviceList.downloadKeys([userId], false);
        delete deviceMap[userId][baseApis.getDeviceId()!];
        const devicesToClaim: [string, string][] =
            Object.keys(deviceMap[userId]!).map((deviceId: string) => {
                return [userId, deviceId];
            });
        console.log("Initial devices in group", devicesToClaim);
        if (devicesToClaim.length) {
            const otks = await baseApis.claimOneTimeKeys(devicesToClaim, INIT_KEY_ALGORITHM.name);

            console.log("InitKeys", otks);

            for (const [user, devices] of Object.entries(otks.one_time_keys) || []) {
                for (const [device, key] of Object.entries(devices)) {
                    const initKeyB64 = Object.values(key)[0] as unknown as string;
                    // FIXME: sanity check that initKeyB64 exists and is a string
                    const initKey = olmlib.decodeBase64(initKeyB64);
                    const mlsUser = user + "|" + device;
                    this.backend!.add_init_key(textEncoder.encode(mlsUser), initKey);
                    group.add_member(textEncoder.encode(mlsUser), this.backend!);
                }
            }

            const [_commit, _mls_epoch, creator, _resolves, [welcome, adds]] = group.resolve(this.backend!);

            const creatorB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(creator));
            const welcomeB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(welcome));

            const contentMap: Record<string, Record<string, any>> = {};

            const payload = {
                algorithm: WELCOME_PACKAGE.name,
                ciphertext: welcomeB64,
                creator: creatorB64,
            }

            for (const user of adds) {
                try {
                    const userStr = textDecoder.decode(Uint8Array.from(user));
                    // FIXME: this will do the wrong thing if the device ID has a "|"
                    const [userId, deviceId] = userStr.split("|", 2);
                    if (!(userId in contentMap)) {
                        contentMap[userId] = {};
                    }
                    contentMap[userId][deviceId] = payload;
                } catch (e) {
                    console.error("Unable to add user", user, e);
                }
            }

            await baseApis.sendToDevice("m.room.encrypted", contentMap);
        }

        return group;
    }

    processWelcome(welcomeB64: string, creatorB64: string): void {
        const welcome = olmlib.decodeBase64(welcomeB64);
        const creator = olmlib.decodeBase64(creatorB64);
        const group = matrix_dmls.DmlsGroup.new_from_welcome(this.backend!, welcome, creator);
        const groupIdArr = group.group_id();
        const groupId = textDecoder.decode(groupIdArr);
        console.log("Welcome message for", groupId);
        // FIXME: check that it's a valid room ID
        if (this.groups.has(groupId)) {
            const oldGroup = this.groups.get(groupId)!;
            oldGroup.add_epoch_from_new_group(this.backend!, group);
        } else {
            this.groups.set(groupId, group);
        }
    }

    getGroup(roomId: string): matrix_dmls.DmlsGroup | undefined {
        return this.groups.get(roomId);
    }
}

registerAlgorithm(MLS_ALGORITHM.name, MlsEncryption, MlsDecryption);
registerAlgorithm(WELCOME_PACKAGE.name, WelcomeEncryption, WelcomeDecryption);
