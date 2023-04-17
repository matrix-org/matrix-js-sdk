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

import {
    DecryptionAlgorithm,
    DecryptionError,
    EncryptionAlgorithm,
    registerAlgorithm,
} from "./base";
import { Room } from "../../models/room";
import { IContent, MatrixEvent } from "../../models/event";
import { Crypto, IEncryptedContent, IEventDecryptionResult } from "..";
import { UnstableValue } from "../../NamespacedValue";
import * as matrixDmls from "matrix-dmls-wasm";
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

        // check if membership needs syncing, if group needs resolving
        const members = await room.getEncryptionTargetMembers();
        const roomMembers = members.map(function (u) {
            return u.userId;
        });
        const devices = await this.crypto.downloadKeys(roomMembers, false);
        // FIXME: remove blocked devices

        const memberMap: Map<string, Set<string>> = new Map();

        for (const [userId, userDevices] of Object.entries(devices)) {
            memberMap.set(userId, new Set(Object.keys(userDevices)));
        }

        mlsProvider.syncMembers(this.roomId, memberMap);

        if (group.has_changes() || group.needs_resolve()) {
            console.log("has changes/needs resolve", group.has_changes(), group.needs_resolve());
            const [commit, _mls_epoch, creator, resolves, [welcome, adds]] = await group.resolve(mlsProvider.backend!);

            const creatorB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(creator));
            const welcomeB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(welcome));

            const contentMap: Record<string, Record<string, any>> = {};

            const payload = {
                algorithm: WELCOME_PACKAGE.name,
                ciphertext: welcomeB64,
                creator: creatorB64,
                resolves: resolves.map(([epochNum, creator]: [number, number[]]) => {
                    return [epochNum, olmlib.encodeUnpaddedBase64(Uint8Array.from(creator))];
                }),
            }

            for (const user of adds) {
                try {
                    const [userId, deviceId] = splitId(user);
                    if (!(userId in contentMap)) {
                        contentMap[userId] = {};
                    }
                    contentMap[userId][deviceId] = payload;
                } catch (e) {
                    console.error("Unable to add user", user, e);
                }
            }

            await this.baseApis.sendToDevice("m.room.encrypted", contentMap);

            await this.baseApis.sendEvent(this.roomId, "m.room.encrypted", {
                algorithm: MLS_ALGORITHM.name,
                ciphertext: olmlib.encodeUnpaddedBase64(Uint8Array.from(commit)),
                epoch_creator: creatorB64,
            });
        }

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
        const epochCreator = olmlib.decodeBase64(content.epoch_creator);
        const unverifiedMessage = group.parse_message(
            ciphertext,
            epochCreator,
            mlsProvider.backend!,
        );
        const processedMessage = group.process_unverified_message(
            unverifiedMessage,
            epochCreator,
            mlsProvider.backend!,
        );
        if (processedMessage.is_application_message()) {
            const messageArr = processedMessage.as_application_message();
            const clearEvent = JSON.parse(textDecoder.decode(Uint8Array.from(messageArr)));
            if (typeof(clearEvent.room_id) !== "string" ||
                typeof(clearEvent.type) !== "string" ||
                typeof(clearEvent.content) !== "object") {
            throw new DecryptionError("MLS_MISSING_FIELDS", "Missing or invalid fields in plaintext");
            }
            return {
                clearEvent
            }
        } else if (processedMessage.is_staged_commit()) {
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
        if (typeof(content.ciphertext) !== "string" ||
            typeof(content.creator) !== "string" ||
            !Array.isArray(content.resolves)) {
            throw new DecryptionError("MLS_WELCOME_MISSING_FIELDS", "Missing or invalid fields in input");
        }
        this.crypto.mlsProvider.processWelcome(content.ciphertext, content.creator, content.resolves);
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

function joinId(userId: string, deviceId: string): Uint8Array {
    return textEncoder.encode(userId + "|" + deviceId);
}

function splitId(id: Uint8Array | number[]): [string, string] {
    const userStr = textDecoder.decode(id instanceof Uint8Array ? id : Uint8Array.from(id));
    // FIXME: this will do the wrong thing if the device ID has a "|"
    return userStr.split("|", 2) as [string, string];
}

export class MlsProvider {
    private readonly groups: Map<string, matrixDmls.DmlsGroup>;
    private readonly storage: Map<string, number[]>;
    private readonly members: Map<string, Map<string, Set<string>>>;
    public backend?: matrixDmls.DmlsCryptoProvider;
    public credential?: matrixDmls.Credential;

    constructor(public readonly crypto: Crypto) {
        // FIXME: we should persist groups
        this.groups = new Map();
        // FIXME: this should go in the cryptostorage
        // FIXME: DmlsCryptoProvider should also use cryptostorage
        this.storage = new Map();
        this.members = new Map();
    }

    async init(): Promise<void> {
        await matrixDmls.initAsync();
        this.backend = new matrixDmls.DmlsCryptoProvider(
            this.store.bind(this),
            this.read.bind(this),
            this.getInitKeys.bind(this),
        );
        let baseApis = this.crypto.baseApis;
        this.credential = new matrixDmls.Credential(
            this.backend!,
            joinId(baseApis.getUserId()!, baseApis.getDeviceId()!),
        );
    }

    static keyToString([groupIdArr, epoch, creatorArr]: [number[], number, number[]]): string {
        let groupId = new Uint8Array(groupIdArr);
        let creator = new Uint8Array(creatorArr);
        return olmlib.encodeUnpaddedBase64(groupId) + "|" + epoch + "|" + olmlib.encodeUnpaddedBase64(creator);
    }

    store(key: [number[], number, number[]], value: number[]): void {
        this.storage.set(MlsProvider.keyToString(key), value);
    }

    read(key: [number[], number, number[]]): number[] | undefined {
        return this.storage.get(MlsProvider.keyToString(key));
    }

    async getInitKeys(users: Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
        let baseApis = this.crypto.baseApis;

        if (users.length) {
            const devicesToClaim: [string, string][] = users.map(splitId)

            const otks = await baseApis.claimOneTimeKeys(devicesToClaim, INIT_KEY_ALGORITHM.name);

            console.log("InitKeys", otks);

            const keys: (Uint8Array | undefined)[] = [];

            for (const [user, device] of devicesToClaim) {
                if (user in otks.one_time_keys && device in otks.one_time_keys[user]) {
                    const key = otks.one_time_keys[user][device];
                    const initKeyB64 = Object.values(key)[0] as unknown as string;
                    const initKey = olmlib.decodeBase64(initKeyB64);
                    keys.push(initKey);
                } else {
                    keys.push(undefined);
                }
            }

            return keys;
        } else {
            return [];
        }
    }

    async createGroup(room: Room, invite: string[]): Promise<matrixDmls.DmlsGroup> {
        let baseApis = this.crypto.baseApis;

        const group = new matrixDmls.DmlsGroup(this.backend!, this.credential!, textEncoder.encode(room.roomId))
        this.groups.set(room.roomId, group);

        const userId = baseApis.getUserId()!;
        const deviceMap = await this.crypto.deviceList.downloadKeys([userId].concat(invite), false);
        delete deviceMap[userId][baseApis.getDeviceId()!];

        let addedMembers = false;
        const members: Map<string, Set<string>> = new Map();

        for (const [user, devices] of Object.entries(deviceMap)) {
            const memberDevices: Set<string> = new Set();
            members.set(user, memberDevices);
            for (const deviceId of Object.keys(devices)) {
                addedMembers = true;
                const mlsUser = joinId(user, deviceId);
                group.add_member(mlsUser, this.backend!);
                memberDevices.add(deviceId);
            }
        }

        members.get(userId)!.add(baseApis.getDeviceId()!);
        this.members.set(room.roomId, members);

        if (addedMembers) {
            const [_commit, _mls_epoch, creator, resolves, [welcome, adds]] = await group.resolve(this.backend!);

            const creatorB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(creator));
            const welcomeB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(welcome));

            const contentMap: Record<string, Record<string, any>> = {};

            const payload = {
                algorithm: WELCOME_PACKAGE.name,
                ciphertext: welcomeB64,
                creator: creatorB64,
                resolves: resolves.map(([epochNum, creator]: [number, number[]]) => {
                    return [epochNum, olmlib.encodeUnpaddedBase64(Uint8Array.from(creator))];
                }),
            }

            for (const user of adds) {
                try {
                    const [userId, deviceId] = splitId(user);
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

    processWelcome(welcomeB64: string, creatorB64: string, resolvesB64: [number, string][]): void {
        const welcome = olmlib.decodeBase64(welcomeB64);
        const creator = olmlib.decodeBase64(creatorB64);
        const resolves = resolvesB64.map(([epochNum, creatorB64]) => {
            return [epochNum, olmlib.decodeBase64(creatorB64)];
        });
        const group = matrixDmls.DmlsGroup.new_from_welcome(this.backend!, welcome, creator);
        const groupIdArr = group.group_id();
        const groupId = textDecoder.decode(groupIdArr);
        console.log("Welcome message for", groupId);
        // FIXME: check that it's a valid room ID
        if (this.groups.has(groupId)) {
            const oldGroup = this.groups.get(groupId)!;
            oldGroup.add_epoch_from_new_group(this.backend!, group, resolves);
        } else {
            this.groups.set(groupId, group);

            const members: Map<string, Set<string>> = new Map();
            for (const member of group.members(this.backend!)) {
                const [userId, deviceId] = splitId(member);
                if (!members.has(userId)) {
                    members.set(userId, new Set());
                }
                members.get(userId)!.add(deviceId);
            }

            this.members.set(groupId, members);
        }
    }

    getGroup(roomId: string): matrixDmls.DmlsGroup | undefined {
        return this.groups.get(roomId);
    }

    syncMembers(roomId: string, members: Map<string, Set<string>>): void {
        /* Membership tracking: ideally, the way it would work is:
         *
         * - When we get a membership event in an encrypted group (join, leave,
         *   invite, etc.), then we mark the appropriate group adds/removes.
         *   (In the case of a join/invite, we need to get the user's devices,
         *   then add them all.)
         *
         * - We also store group membership by user -> groups.  When we are
         *   notified that a user's devices have changed, we flag the user's
         *   groups a dirty.  We will, at a later time, update the user's
         *   devices, and synchronize the device's membership.
         *
         * - We continue to receive and process incoming commits.
         *
         * - At a later time, we determine whether we need to send a commit, and
         *   do so if needed.
         */
        const recordedMembers = this.members.get(roomId)!;

        console.log("Syncing members", members, recordedMembers);

        // find out what devices have been added/removed
        const adds: [string, string][] = [];
        const removes: [string, string][] = [];

        for (const [userId, devices] of members.entries()) {
            const recordedDevices = recordedMembers.get(userId);
            if (recordedDevices) {
                for (const deviceId of devices.values()) {
                    if (!recordedDevices.has(deviceId)) {
                        adds.push([userId, deviceId]);
                    }
                }
                for (const deviceId of recordedDevices.values()) {
                    if (!devices.has(deviceId)) {
                        removes.push([userId, deviceId])
                    }
                }
            } else {
                for (const deviceId of devices.values()) {
                    adds.push([userId, deviceId]);
                }
            }
        }

        for (const [userId, devices] of recordedMembers.entries()) {
            if (!members.has(userId)) {
                for (const deviceId of devices.values()) {
                    removes.push([userId, deviceId]);
                }
            }
        }

        console.log(adds, removes);

        // sync up the group and recorded members
        const group = this.groups.get(roomId)!;

        for (const [userId, deviceId] of adds) {
            group.add_member(joinId(userId, deviceId), this.backend!);
            if (!recordedMembers.has(userId)) {
                recordedMembers.set(userId, new Set());
            }
            recordedMembers.get(userId)!.add(deviceId);
        }

        for (const [userId, deviceId] of removes) {
            group.remove_member(joinId(userId, deviceId), this.backend!);
            if (recordedMembers.has(userId)) { // should always be true, but be safe
                const recordedDevices = recordedMembers.get(userId)!;
                recordedDevices.delete(deviceId);
                if (recordedDevices.size == 0) {
                    recordedMembers.delete(userId);
                }
            }
        }
    }
}

registerAlgorithm(MLS_ALGORITHM.name, MlsEncryption, MlsDecryption);
registerAlgorithm(WELCOME_PACKAGE.name, WelcomeEncryption, WelcomeDecryption);
