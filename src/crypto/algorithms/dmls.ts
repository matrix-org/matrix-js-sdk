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
    EventType
} from "../../@types/event";
import {
    DecryptionAlgorithm,
    DecryptionError,
    EncryptionAlgorithm,
    registerAlgorithm,
} from "./base";
import type {
    IImportRoomKeysOpts,
} from "../api";
import { Room } from "../../models/room";
import { IContent, MatrixEvent } from "../../models/event";
import { Crypto, IEncryptedContent, IEventDecryptionResult } from "..";
import { UnstableValue } from "../../NamespacedValue";
import * as matrixDmls from "@matrix-org/matrix-dmls-wasm";
import * as olmlib from "../olmlib";

export const MLS_ALGORITHM = new UnstableValue(
    "m.dmls.v1.dhkemx25519-aes128gcm-sha256-ed25519",
    "org.matrix.msc2883.v0.dmls.dhkemx25519-aes128gcm-sha256-ed25519",
);
export const INIT_KEY_ALGORITHM = new UnstableValue(
    "m.dmls.v1.key_package.dhkemx25519-aes128gcm-sha256-ed25519",
    "org.matrix.msc2883.v0.dmls.key_package.dhkemx25519-aes128gcm-sha256-ed25519",
);
export const WELCOME_PACKAGE = new UnstableValue(
    "m.dmls.v1.welcome.dhkemx25519-aes128gcm-sha256-ed25519",
    "org.matrix.msc2883.v0.dmls.welcome.dhkemx25519-aes128gcm-sha256-ed25519",
);

/* eslint-disable camelcase */

export interface IMlsSessionData {
    room_id: string;
    epoch: [number, string];
    group_export: string;
    algorithm?: string;
    untrusted?: boolean;
}

/* eslint-enable camelcase */

let textEncoder = new TextEncoder();
let textDecoder = new TextDecoder("utf-8", {fatal: true});

class MlsEncryption extends EncryptionAlgorithm {
    public async encryptMessage(room: Room, eventType: string, content: IContent): Promise<IEncryptedContent> {
        const mlsProvider = this.crypto.mlsProvider;
        if (!this.roomId) {
            console.error("MLS Error: No room ID")
            throw "No room ID";
        }
        let group = mlsProvider.getGroup(this.roomId);
        if (!group || !group.is_joined()) {
            const timeline = room.getLiveTimeline();
            const events = timeline.getEvents();
            events.reverse();
            let publicGroupStateEvent: MatrixEvent | undefined;
            for (const event of events) {
                if (event.getWireType() == "m.room.encrypted") {
                    const contents = event.getWireContent();
                    if (contents.algorithm == MLS_ALGORITHM.name &&
                        "public_group_state" in contents &&
                        "sender" in contents) {
                        publicGroupStateEvent = event;
                        break;
                    }
                }
            }
            // FIXME: search for more events if we still don't have public state
            // FIXME: search for public group state again if the join fails
            if (publicGroupStateEvent) {
                const publicGroupStateContents = publicGroupStateEvent.getWireContent();
                const [joinedGroup, message] = mlsProvider.joinByExternalCommit(
                    publicGroupStateContents.public_group_state,
                    this.roomId,
                    publicGroupStateEvent.getId()!,
                );

                const senderB64 = olmlib.encodeUnpaddedBase64(joinId(this.userId, this.deviceId));
                group = joinedGroup;
                const publicGroupState = group.public_group_state(mlsProvider.backend!);
                const publicGroupStateB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(publicGroupState));
                const {event_id: eventId} = await this.baseApis.sendEvent(this.roomId, "m.room.encrypted", {
                    algorithm: MLS_ALGORITHM.name,
                    ciphertext: olmlib.encodeUnpaddedBase64(message),
                    epoch_creator: publicGroupStateContents.sender,
                    sender: senderB64,
                    resolves: [],
                    public_group_state: publicGroupStateB64,
                    commit_event: publicGroupStateEvent.getId(),
                });
                mlsProvider.addEpochEvent(group, this.roomId, eventId);
            }
        }
        if (!group) {
            console.error("MLS error: No group available");
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
            console.log("[MLS] has changes/needs resolve", group.has_changes(), group.needs_resolve());
            const [commit, baseEpochNum, baseEpochCreator, resolves, welcomeInfo] = await group.resolve(mlsProvider.backend!);
            const [epochNum, epochCreator] = group.epoch();
            // don't wait for it to complete
            this.crypto.backupManager.backupGroupSession(this.roomId, epochNum, olmlib.encodeUnpaddedBase64(epochCreator));

            const creatorB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(baseEpochCreator));
            const senderB64 = olmlib.encodeUnpaddedBase64(joinId(this.userId, this.deviceId));

            // FIXME: check if external commits are allowed
            const publicGroupState = group.public_group_state(mlsProvider.backend!);
            const publicGroupStateB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(publicGroupState));
            // FIXME: should we store public group state in media repo instead?

            const baseEventId = mlsProvider.getEpochEvent(
                this.roomId, BigInt(baseEpochNum), creatorB64,
            );

            const {event_id: eventId} = await this.baseApis.sendEvent(this.roomId, "m.room.encrypted", {
                algorithm: MLS_ALGORITHM.name,
                ciphertext: olmlib.encodeUnpaddedBase64(Uint8Array.from(commit)),
                epoch_creator: creatorB64,
                sender: senderB64,
                resolves: resolves.map(([epochNum, creator]: [number, number[]]) => {
                    return [epochNum, olmlib.encodeUnpaddedBase64(Uint8Array.from(creator))];
                }),
                public_group_state: publicGroupStateB64,
                commit_event: baseEventId,
            });
            mlsProvider.addEpochEvent(group, this.roomId, eventId);

            if (welcomeInfo) {
                const [welcome, adds] = welcomeInfo;

                const welcomeB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(welcome));

                const contentMap: Record<string, Record<string, any>> = {};

                const payload = {
                    algorithm: WELCOME_PACKAGE.name,
                    ciphertext: welcomeB64,
                    sender: senderB64,
                    room_id: room.roomId,
                    resolves: resolves.map(([epochNum, creator]: [number, number[]]) => {
                        return [epochNum, olmlib.encodeUnpaddedBase64(Uint8Array.from(creator))];
                    }),
                    commit_event: eventId,
                }

                for (const user of adds) {
                    try {
                        const [userId, deviceId] = splitId(user);
                        if (!(userId in contentMap)) {
                            contentMap[userId] = {};
                        }
                        contentMap[userId][deviceId] = payload;
                    } catch (e) {
                        console.error("[MLS] Unable to add user", user, e);
                    }
                }

                await this.baseApis.sendToDevice("m.room.encrypted", contentMap);
            }
        }

        const payload = textEncoder.encode(JSON.stringify({
            room_id: this.roomId,
            type: eventType,
            content: content,
        }));
        const [ciphertext, baseEpochNum, baseEpochCreator] = group.encrypt_message(mlsProvider.backend!, payload);
        const creatorB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(baseEpochCreator));
        const baseEventId = mlsProvider.getEpochEvent(
            this.roomId, BigInt(baseEpochNum), creatorB64,
        )!;
        return {
            algorithm: MLS_ALGORITHM.name,
            ciphertext: olmlib.encodeUnpaddedBase64(Uint8Array.from(ciphertext)),
            epoch_creator: creatorB64,
            commit_event: baseEventId,
        }
    }
}

class MlsDecryption extends DecryptionAlgorithm {
    private pendingEvents = new Map<BigInt, Map<string, Set<MatrixEvent>>>();
    private pendingBackfills = new Map<string, Promise<void>>();

    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const content = event.getWireContent();
        if (typeof(content.ciphertext) !== "string" || typeof(content.epoch_creator) !== "string") {
            throw new DecryptionError("MLS_MISSING_FIELDS", "Missing or invalid fields in input");
        }
        if (content.ciphertext === "") {
            // probably the initial commit
            return {
                clearEvent: {
                    type: "io.element.mls.internal",
                    content: {"body": "This is an MLS handshake message, so there's nothing useful to see here."},
                },
            };
        }
        const mlsProvider = this.crypto.mlsProvider;
        if (!this.roomId) {
            throw "No room ID";
        }
        const group = mlsProvider.getGroup(this.roomId);
        const mlsMessage = new matrixDmls.MlsMessageIn(olmlib.decodeBase64(content.ciphertext));
        const isHandshake = mlsMessage.is_handshake_message;
        const epochNumber = mlsMessage.epoch;
        if (!group) {
            this.addEventToPendingList(event, epochNumber, content.epoch_creator);
            if (isHandshake) {
                return {
                    clearEvent: {
                        type: "io.element.mls.internal",
                        content: {"body": "This is an MLS handshake message, so there's nothing useful to see here."},
                    },
                };
            }
            throw "No group available";
        }
        const epochCreator = olmlib.decodeBase64(content.epoch_creator);
        let unverifiedMessage;
        try {
            unverifiedMessage = group.parse_message(
                mlsMessage,
                epochCreator,
                mlsProvider.backend!,
            );
        } catch (e) {
            console.log("Adding to pending:", epochNumber, content.epoch_creator);
            this.addEventToPendingList(event, epochNumber, content.epoch_creator);
            if (e == "Epoch not found") {
                const parentCommit = content.commit_event;
                if (parentCommit) {
                    this.backfillParent(parentCommit);
                }
            }
            if (isHandshake) {
                return {
                    clearEvent: {
                        type: "io.element.mls.internal",
                        content: {"body": "This is an MLS handshake message, so there's nothing useful to see here."},
                    },
                };
            }
            throw e;
        }
        const processedMessage = group.process_unverified_message(
            unverifiedMessage,
            epochCreator,
            mlsProvider.backend!,
        );
        this.removeEventFromPendingList(event, epochNumber, content.epoch_creator);
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
            if (typeof(content.sender) !== "string" || !Array.isArray(content.resolves)) {
                throw new DecryptionError("MLS_MISSING_FIELDS", "Missing or invalid fields in cleartext");
            }
            const sender = olmlib.decodeBase64(content.sender);
            const resolves = content.resolves.map(([epochNum, creatorB64]: [number, string]) => {
                return [epochNum, olmlib.decodeBase64(creatorB64)];
            });
            const commit = processedMessage.as_staged_commit();
            const [newEpochNum, newEpochCreator] = group.merge_staged_commit(
                commit, epochNumber, epochCreator,
                sender, resolves,
                mlsProvider.backend!,
            );
            this.retryDecryption(newEpochNum, olmlib.encodeUnpaddedBase64(newEpochCreator));
            // don't wait for it to complete
            this.crypto.backupManager.backupGroupSession(this.roomId, newEpochNum, olmlib.encodeUnpaddedBase64(newEpochCreator));
            return {
                clearEvent: {
                    type: "io.element.mls.internal",
                    content: {"body": "This is an MLS handshake message, so there's nothing useful to see here."},
                },
            };
        } else {
            throw new DecryptionError("MLS_UNKNOWN_TYPE", "Unknown MLS message type");
        }
    }

    public async importRoomKey(key: IMlsSessionData, opts: IImportRoomKeysOpts): Promise<void> {
        if (key.group_export) {
            const mlsProvider = this.crypto.mlsProvider;
            const [epochNumber, epochCreator] = key.epoch;
            mlsProvider.importGroupData(this.roomId!, epochNumber, epochCreator, key.group_export);
            this.retryDecryption(epochNumber, epochCreator);
        }
    }

    private async backfillParent(commitEventId: string): Promise<void> {
        if (!this.pendingBackfills.has(commitEventId)) {
            this.pendingBackfills.set(commitEventId, (async () => {
                try {
                    const event = await this.baseApis.fetchRoomEvent(this.roomId!, commitEventId);
                    if (event.type != "m.room.encrypted") {
                        return;
                    }

                    const matrixEvent = new MatrixEvent(event);
                    await matrixEvent.attemptDecryption(this.crypto);
                } finally {
                    this.pendingBackfills.delete(commitEventId);
                }
            })());
        }
        return this.pendingBackfills.get(commitEventId)!;
    }

    /**
     * Add an event to the list of those awaiting their session keys.
     *
     * @internal
     *
     */
    private addEventToPendingList(
        event: MatrixEvent,
        epochNumber: BigInt,
        epochCreator: string,
    ): void {
        if (!this.pendingEvents.has(epochNumber)) {
            this.pendingEvents.set(epochNumber, new Map<string, Set<MatrixEvent>>());
        }
        const epochNumPendingEvents = this.pendingEvents.get(epochNumber)!;
        if (!epochNumPendingEvents.has(epochCreator)) {
            epochNumPendingEvents.set(epochCreator, new Set());
        }
        epochNumPendingEvents.get(epochCreator)!.add(event);
    }

    /**
     * Remove an event from the list of those awaiting their session keys.
     *
     * @internal
     *
     */
    private removeEventFromPendingList(
        event: MatrixEvent,
        epochNumber: BigInt,
        epochCreator: string,
    ): void {
        const epochNumPendingEvents = this.pendingEvents.get(epochNumber);
        const pendingEvents = epochNumPendingEvents?.get(epochCreator);
        if (!pendingEvents) {
            return;
        }

        pendingEvents.delete(event);
        if (pendingEvents.size === 0) {
            epochNumPendingEvents!.delete(epochCreator);
        }
        if (epochNumPendingEvents!.size === 0) {
            this.pendingEvents.delete(epochNumber);
        }
    }

    private async retryDecryption(
        epochNumber: number,
        epochCreator: string,
    ): Promise<boolean> {
        const pending = this.pendingEvents.get(BigInt(epochNumber))?.get(epochCreator);
        if (!pending) {
            return true;
        }

        const pendingList = [...pending];
        console.debug(
            "Retrying decryption on events:",
            pendingList.map((e) => `${e.getId()}`),
        );

        await Promise.all(
            pendingList.map(async (ev) => {
                try {
                    await ev.attemptDecryption(this.crypto, { isRetry: true });
                } catch (e) {
                    // don't die if something goes wrong
                }
            }),
        );

        // If decrypted successfully with trusted keys, they'll have
        // been removed from pendingEvents
        return !this.pendingEvents.get(BigInt(epochNumber))?.has(epochCreator);
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
        console.log("[MLS] Got welcome", content);
        // FIXME: check that it's a to-device event
        if (typeof(content.ciphertext) !== "string" ||
            typeof(content.sender) !== "string" ||
            !Array.isArray(content.resolves)) {
            throw new DecryptionError("MLS_WELCOME_MISSING_FIELDS", "Missing or invalid fields in input");
        }
        this.crypto.mlsProvider.processWelcome(
            content.ciphertext,
            content.sender,
            content.resolves,
            content.commit_event,
        );
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
    private readonly epochMap: Map<string, Map<BigInt, Map<string, string>>>;
    public backend?: matrixDmls.DmlsCryptoProvider;
    public credential?: matrixDmls.Credential;

    constructor(public readonly crypto: Crypto) {
        // FIXME: we should persist groups
        this.groups = new Map();
        // FIXME: this should go in the cryptostorage
        // FIXME: DmlsCryptoProvider should also use cryptostorage
        this.storage = new Map();
        this.members = new Map();
        this.epochMap = new Map();
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

    static keyToString([groupIdArr, epoch, creatorArr, historical]: [number[], number, number[], boolean]): string {
        let groupId = new Uint8Array(groupIdArr);
        let creator = new Uint8Array(creatorArr);
        return olmlib.encodeUnpaddedBase64(groupId) + "|" + epoch + "|" + olmlib.encodeUnpaddedBase64(creator) + "|" + historical;
    }

    store(key: [number[], number, number[], boolean], value: number[]): void {
        this.storage.set(MlsProvider.keyToString(key), value);
    }

    read(key: [number[], number, number[], boolean]): number[] | undefined {
        return this.storage.get(MlsProvider.keyToString(key));
    }

    async getInitKeys(users: Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
        let baseApis = this.crypto.baseApis;

        if (users.length) {
            const devicesToClaim: [string, string][] = users.map(splitId)

            const otks = await baseApis.claimOneTimeKeys(devicesToClaim, INIT_KEY_ALGORITHM.name);

            console.log("[MLS] InitKeys", otks);

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

        const [epochNum, epochCreator] = group.epoch();
        const epochCreatorB64 = olmlib.encodeUnpaddedBase64(epochCreator);
        // don't wait for it to complete
        this.crypto.backupManager.backupGroupSession(room.roomId, epochNum, epochCreatorB64);

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

        const sender = joinId(baseApis.getUserId()!, baseApis.getDeviceId()!);
        const senderB64 = olmlib.encodeUnpaddedBase64(sender);

        const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "")!;

        if (addedMembers) {
            const [commit, _mlsEpoch, creator, resolves, welcomeInfo] = await group.resolve(this.backend!);

            const [epochNum, epochCreator] = group.epoch();
            const epochCreatorB64 = olmlib.encodeUnpaddedBase64(epochCreator);
            // don't wait for it to complete
            this.crypto.backupManager.backupGroupSession(room.roomId, epochNum, epochCreatorB64);

            const creatorB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(creator));

            // FIXME: check if external commits are allowed
            const publicGroupState = group.public_group_state(this.backend!);
            const publicGroupStateB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(publicGroupState));

            const {event_id: eventId} = await baseApis.sendEvent(room.roomId, "m.room.encrypted", {
                algorithm: MLS_ALGORITHM.name,
                ciphertext: olmlib.encodeUnpaddedBase64(Uint8Array.from(commit)),
                epoch_creator: creatorB64,
                sender: senderB64,
                resolves: resolves.map(([epochNum, creator]: [number, number[]]) => {
                    return [epochNum, olmlib.encodeUnpaddedBase64(Uint8Array.from(creator))];
                }),
                public_group_state: publicGroupStateB64,
                commit_event: createEvent.getId(),
            });

            const roomEpochMap = new Map<BigInt, Map<string, string>>();
            roomEpochMap.set(BigInt(epochNum), new Map<string, string>([[epochCreatorB64, eventId]]));
            this.epochMap.set(room.roomId, roomEpochMap);

            if (welcomeInfo) {
                const [welcome, adds] = welcomeInfo;

                const welcomeB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(welcome));

                const contentMap: Record<string, Record<string, any>> = {};

                const payload = {
                    algorithm: WELCOME_PACKAGE.name,
                    ciphertext: welcomeB64,
                    sender: creatorB64,
                    room_id: room.roomId,
                    resolves: resolves.map(([epochNum, creator]: [number, number[]]) => {
                        return [epochNum, olmlib.encodeUnpaddedBase64(Uint8Array.from(creator))];
                    }),
                    commit_event: eventId,
                }

                for (const user of adds) {
                    try {
                        const [userId, deviceId] = splitId(user);
                        if (!(userId in contentMap)) {
                            contentMap[userId] = {};
                        }
                        contentMap[userId][deviceId] = payload;
                    } catch (e) {
                        console.error("[MLS] Unable to add user", user, e);
                    }
                }

                await baseApis.sendToDevice("m.room.encrypted", contentMap);
            }
        } else {
            // FIXME: check if external commits are allowed
            const publicGroupState = group.public_group_state(this.backend!);
            const publicGroupStateB64 = olmlib.encodeUnpaddedBase64(Uint8Array.from(publicGroupState));

            const {event_id: eventId} = await baseApis.sendEvent(room.roomId, "m.room.encrypted", {
                algorithm: MLS_ALGORITHM.name,
                ciphertext: "",
                epoch_creator: senderB64,
                sender: senderB64,
                resolves: [],
                public_group_state: publicGroupStateB64,
                commit_event: createEvent.getId(),
            });

            const roomEpochMap = new Map<BigInt, Map<string, string>>();
            roomEpochMap.set(BigInt(epochNum), new Map<string, string>([[epochCreatorB64, eventId]]));
            this.epochMap.set(room.roomId, roomEpochMap);
        }

        return group;
    }

    processWelcome(
        welcomeB64: string,
        creatorB64: string,
        resolvesB64: [number, string][],
        commitEvent: string,
    ): void {
        const welcome = olmlib.decodeBase64(welcomeB64);
        const creator = olmlib.decodeBase64(creatorB64);
        const resolves = resolvesB64.map(([epochNum, creatorB64]) => {
            return [epochNum, olmlib.decodeBase64(creatorB64)];
        });
        const group = matrixDmls.DmlsGroup.new_from_welcome(this.backend!, welcome, creator);
        const groupIdArr = group.group_id();
        const groupId = textDecoder.decode(groupIdArr);
        console.log("[MLS] Welcome message for", groupId);
        // FIXME: check that it's a valid room ID

        const [epochNum, epochCreator] = group.epoch();
        const epochCreatorB64 = olmlib.encodeUnpaddedBase64(epochCreator);
        // don't wait for it to complete
        this.crypto.backupManager.backupGroupSession(groupId, epochNum, epochCreatorB64);

        if (!this.epochMap.has(groupId)) {
            this.epochMap.set(groupId, new Map());
        }
        const roomEpochMap = this.epochMap.get(groupId)!;
        if (!roomEpochMap.has(BigInt(epochNum))) {
            roomEpochMap.set(BigInt(epochNum), new Map());
        }
        roomEpochMap.get(BigInt(epochNum))!.set(epochCreatorB64, commitEvent);

        const oldGroup = this.groups.get(groupId);

        if (oldGroup) {
            const joined = group.is_joined();
            oldGroup.add_epoch_from_new_group(this.backend!, group, resolves);

            if (!joined) {
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

    joinByExternalCommit(publicGroupStateB64: string, roomId: string, commitEvent: string): [matrixDmls.DmlsGroup, Uint8Array] {
        const publicGroupState = olmlib.decodeBase64(publicGroupStateB64);
        const joinResult = matrixDmls.DmlsGroup.join_by_external_commit(
            this.backend!,
            publicGroupState,
            this.credential!,
        );
        const joinMsg = joinResult.message;
        let group = joinResult.group;
        const groupIdArr = group.group_id();
        const groupId = textDecoder.decode(groupIdArr);
        if (groupId != roomId) {
            throw "Group ID mismatch";
        }

        const oldGroup = this.groups.get(groupId);
        if (oldGroup) {
            oldGroup.add_epoch_from_new_group(this.backend!, group, []);
            group = oldGroup;
        } else {
            this.groups.set(groupId, group);
        }

        const [epochNum, epochCreator] = group.epoch();
        const epochCreatorB64 = olmlib.encodeUnpaddedBase64(epochCreator);
        // don't wait for it to complete
        this.crypto.backupManager.backupGroupSession(roomId, epochNum, epochCreatorB64);

        if (!this.epochMap.has(roomId)) {
            this.epochMap.set(roomId, new Map());
        }
        const roomEpochMap = this.epochMap.get(roomId)!;
        if (!roomEpochMap.has(BigInt(epochNum))) {
            roomEpochMap.set(BigInt(epochNum), new Map());
        }
        roomEpochMap.get(BigInt(epochNum))!.set(epochCreatorB64, commitEvent);

        const members: Map<string, Set<string>> = new Map();
        for (const member of group.members(this.backend!)) {
            const [userId, deviceId] = splitId(member);
            if (!members.has(userId)) {
                members.set(userId, new Set());
            }
            members.get(userId)!.add(deviceId);
        }

        this.members.set(groupId, members);

        return [group, joinMsg];
    }

    getGroup(roomId: string): matrixDmls.DmlsGroup | undefined {
        return this.groups.get(roomId);
    }

    addEpochEvent(group: matrixDmls.DmlsGroup, roomId: string, eventId: string): void {
        const [epochNum, epochCreator] = group.epoch();
        const epochCreatorB64 = olmlib.encodeUnpaddedBase64(epochCreator);

        if (!this.epochMap.has(roomId)) {
            this.epochMap.set(roomId, new Map());
        }
        const roomEpochMap = this.epochMap.get(roomId)!;
        if (!roomEpochMap.has(BigInt(epochNum))) {
            roomEpochMap.set(BigInt(epochNum), new Map());
        }
        roomEpochMap.get(BigInt(epochNum))!.set(epochCreatorB64, eventId);
    }

    getEpochEvent(roomId: string, epochNum: BigInt, epochCreator: string): string | undefined {
        return this.epochMap.get(roomId)?.get(epochNum)?.get(epochCreator);
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

        console.log("[MLS] Syncing members", members, recordedMembers);

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

        console.log("[MLS] adds, removes", adds, removes);

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

    exportGroupData(roomId: string, epochNumber: number, epochCreator: string): string {
        const group = this.getGroup(roomId);
        if (!group) {
            throw new Error("No such group");
        }
        console.info(roomId, epochNumber, BigInt(epochNumber), epochCreator, olmlib.decodeBase64(epochCreator));
        const groupExport = group.export_group(this.backend!, BigInt(epochNumber), olmlib.decodeBase64(epochCreator));
        console.info("OK", roomId, epochNumber, BigInt(epochNumber), epochCreator, olmlib.decodeBase64(epochCreator));
        return olmlib.encodeUnpaddedBase64(Uint8Array.from(groupExport));
    }

    importGroupData(roomId: string, epochNumber: number, epochCreator: string, groupExport: string): void {
        console.log("Import group data for", roomId, epochNumber, epochCreator);
        const groupExportBin = olmlib.decodeBase64(groupExport);
        console.log("Decoded export");
        let group = this.getGroup(roomId);
        if (!group) {
            console.log("Creating group");
            const baseApis = this.crypto.baseApis;
            group = matrixDmls.DmlsGroup.new_dummy_group(
                this.backend!,
                textEncoder.encode(roomId),
                joinId(baseApis.getUserId()!, baseApis.getDeviceId()!),
            );
            this.groups.set(roomId, group);
        }
        console.log("Importing...");
        try {
            group.import_group(this.backend!, BigInt(epochNumber), olmlib.decodeBase64(epochCreator), groupExportBin);
        } catch(e) {
            console.error(e);
            throw e;
        }
        console.log("Done");
    }
}

registerAlgorithm(MLS_ALGORITHM.name, MlsEncryption, MlsDecryption);
registerAlgorithm(WELCOME_PACKAGE.name, WelcomeEncryption, WelcomeDecryption);
