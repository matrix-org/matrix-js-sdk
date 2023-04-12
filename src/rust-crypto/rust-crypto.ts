/*
Copyright 2022-2023 The Matrix.org Foundation C.I.C.

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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-js";

import type { IEventDecryptionResult, IMegolmSessionData } from "../@types/crypto";
import type { IDeviceLists, IToDeviceEvent } from "../sync-accumulator";
import type { IEncryptedEventInfo } from "../crypto/api";
import { MatrixEvent } from "../models/event";
import { Room } from "../models/room";
import { RoomMember } from "../models/room-member";
import { CryptoBackend, OnSyncCompletedData } from "../common-crypto/CryptoBackend";
import { logger } from "../logger";
import { IHttpOpts, MatrixHttpApi } from "../http-api";
import { DeviceTrustLevel, UserTrustLevel } from "../crypto/CrossSigning";
import { RoomEncryptor } from "./RoomEncryptor";
import { OutgoingRequest, OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { KeyClaimManager } from "./KeyClaimManager";
import { MapWithDefault } from "../utils";

/**
 * An implementation of {@link CryptoBackend} using the Rust matrix-sdk-crypto.
 */
export class RustCrypto implements CryptoBackend {
    public globalErrorOnUnknownDevices = false;

    /** whether {@link stop} has been called */
    private stopped = false;

    /** whether {@link outgoingRequestLoop} is currently running */
    private outgoingRequestLoopRunning = false;

    /** mapping of roomId → encryptor class */
    private roomEncryptors: Record<string, RoomEncryptor> = {};

    private eventDecryptor: EventDecryptor;
    private keyClaimManager: KeyClaimManager;
    private outgoingRequestProcessor: OutgoingRequestProcessor;

    public constructor(
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,
        http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        _userId: string,
        _deviceId: string,
    ) {
        this.outgoingRequestProcessor = new OutgoingRequestProcessor(olmMachine, http);
        this.keyClaimManager = new KeyClaimManager(olmMachine, this.outgoingRequestProcessor);
        this.eventDecryptor = new EventDecryptor(olmMachine);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // CryptoBackend implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    public stop(): void {
        // stop() may be called multiple times, but attempting to close() the OlmMachine twice
        // will cause an error.
        if (this.stopped) {
            return;
        }
        this.stopped = true;

        this.keyClaimManager.stop();

        // make sure we close() the OlmMachine; doing so means that all the Rust objects will be
        // cleaned up; in particular, the indexeddb connections will be closed, which means they
        // can then be deleted.
        this.olmMachine.close();
    }

    public async encryptEvent(event: MatrixEvent, _room: Room): Promise<void> {
        const roomId = event.getRoomId()!;
        const encryptor = this.roomEncryptors[roomId];

        if (!encryptor) {
            throw new Error(`Cannot encrypt event in unconfigured room ${roomId}`);
        }

        await encryptor.encryptEvent(event);
    }

    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const roomId = event.getRoomId();
        if (!roomId) {
            // presumably, a to-device message. These are normally decrypted in preprocessToDeviceMessages
            // so the fact it has come back here suggests that decryption failed.
            //
            // once we drop support for the libolm crypto implementation, we can stop passing to-device messages
            // through decryptEvent and hence get rid of this case.
            throw new Error("to-device event was not decrypted in preprocessToDeviceMessages");
        }
        return await this.eventDecryptor.attemptEventDecryption(event);
    }

    public getEventEncryptionInfo(event: MatrixEvent): IEncryptedEventInfo {
        // TODO: make this work properly. Or better, replace it.

        const ret: Partial<IEncryptedEventInfo> = {};

        ret.senderKey = event.getSenderKey() ?? undefined;
        ret.algorithm = event.getWireContent().algorithm;

        if (!ret.senderKey || !ret.algorithm) {
            ret.encrypted = false;
            return ret as IEncryptedEventInfo;
        }
        ret.encrypted = true;
        ret.authenticated = true;
        ret.mismatchedSender = true;
        return ret as IEncryptedEventInfo;
    }

    public checkUserTrust(userId: string): UserTrustLevel {
        // TODO
        return new UserTrustLevel(false, false, false);
    }

    public checkDeviceTrust(userId: string, deviceId: string): DeviceTrustLevel {
        // TODO
        return new DeviceTrustLevel(false, false, false, false);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // CryptoApi implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    public globalBlacklistUnverifiedDevices = false;

    public async userHasCrossSigningKeys(): Promise<boolean> {
        // TODO
        return false;
    }

    public prepareToEncrypt(room: Room): void {
        const encryptor = this.roomEncryptors[room.roomId];

        if (encryptor) {
            encryptor.ensureEncryptionSession();
        }
    }

    public forceDiscardSession(roomId: string): Promise<void> {
        return this.roomEncryptors[roomId]?.forceDiscardSession();
    }

    public async exportRoomKeys(): Promise<IMegolmSessionData[]> {
        // TODO
        return [];
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // SyncCryptoCallbacks implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Apply sync changes to the olm machine
     * @param events - the received to-device messages
     * @param oneTimeKeysCounts - the received one time key counts
     * @param unusedFallbackKeys - the received unused fallback keys
     * @param devices - the received device list updates
     * @returns A list of preprocessed to-device messages.
     */
    private async receiveSyncChanges({
        events,
        oneTimeKeysCounts = new Map<string, number>(),
        unusedFallbackKeys = new Set<string>(),
        devices = new RustSdkCryptoJs.DeviceLists(),
    }: {
        events?: IToDeviceEvent[];
        oneTimeKeysCounts?: Map<string, number>;
        unusedFallbackKeys?: Set<string>;
        devices?: RustSdkCryptoJs.DeviceLists;
    }): Promise<IToDeviceEvent[]> {
        const result = await this.olmMachine.receiveSyncChanges(
            events ? JSON.stringify(events) : "[]",
            devices,
            oneTimeKeysCounts,
            unusedFallbackKeys,
        );

        // receiveSyncChanges returns a JSON-encoded list of decrypted to-device messages.
        return JSON.parse(result);
    }

    /** called by the sync loop to preprocess incoming to-device messages
     *
     * @param events - the received to-device messages
     * @returns A list of preprocessed to-device messages.
     */
    public preprocessToDeviceMessages(events: IToDeviceEvent[]): Promise<IToDeviceEvent[]> {
        // send the received to-device messages into receiveSyncChanges. We have no info on device-list changes,
        // one-time-keys, or fallback keys, so just pass empty data.
        return this.receiveSyncChanges({ events });
    }

    /** called by the sync loop to process one time key counts and unused fallback keys
     *
     * @param oneTimeKeysCounts - the received one time key counts
     * @param unusedFallbackKeys - the received unused fallback keys
     */
    public async processKeyCounts(
        oneTimeKeysCounts?: Record<string, number>,
        unusedFallbackKeys?: string[],
    ): Promise<void> {
        const mapOneTimeKeysCount = oneTimeKeysCounts && new Map<string, number>(Object.entries(oneTimeKeysCounts));
        const setUnusedFallbackKeys = unusedFallbackKeys && new Set<string>(unusedFallbackKeys);

        if (mapOneTimeKeysCount !== undefined || setUnusedFallbackKeys !== undefined) {
            await this.receiveSyncChanges({
                oneTimeKeysCounts: mapOneTimeKeysCount,
                unusedFallbackKeys: setUnusedFallbackKeys,
            });
        }
    }

    /** called by the sync loop to process the notification that device lists have
     * been changed.
     *
     * @param deviceLists - device_lists field from /sync
     */
    public async processDeviceLists(deviceLists: IDeviceLists): Promise<void> {
        const devices = new RustSdkCryptoJs.DeviceLists(
            deviceLists.changed?.map((userId) => new RustSdkCryptoJs.UserId(userId)),
            deviceLists.left?.map((userId) => new RustSdkCryptoJs.UserId(userId)),
        );
        await this.receiveSyncChanges({ devices });
    }

    /** called by the sync loop on m.room.encrypted events
     *
     * @param room - in which the event was received
     * @param event - encryption event to be processed
     */
    public async onCryptoEvent(room: Room, event: MatrixEvent): Promise<void> {
        const config = event.getContent();

        const existingEncryptor = this.roomEncryptors[room.roomId];
        if (existingEncryptor) {
            existingEncryptor.onCryptoEvent(config);
        } else {
            this.roomEncryptors[room.roomId] = new RoomEncryptor(
                this.olmMachine,
                this.keyClaimManager,
                this.outgoingRequestProcessor,
                room,
                config,
            );
        }

        // start tracking devices for any users already known to be in this room.
        const members = await room.getEncryptionTargetMembers();
        logger.debug(
            `[${room.roomId} encryption] starting to track devices for: `,
            members.map((u) => `${u.userId} (${u.membership})`),
        );
        await this.olmMachine.updateTrackedUsers(members.map((u) => new RustSdkCryptoJs.UserId(u.userId)));
    }

    /** called by the sync loop after processing each sync.
     *
     * TODO: figure out something equivalent for sliding sync.
     *
     * @param syncState - information on the completed sync.
     */
    public onSyncCompleted(syncState: OnSyncCompletedData): void {
        // Processing the /sync may have produced new outgoing requests which need sending, so kick off the outgoing
        // request loop, if it's not already running.
        this.outgoingRequestLoop();
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Other public functions
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /** called by the MatrixClient on a room membership event
     *
     * @param event - The matrix event which caused this event to fire.
     * @param member - The member whose RoomMember.membership changed.
     * @param oldMembership - The previous membership state. Null if it's a new member.
     */
    public onRoomMembership(event: MatrixEvent, member: RoomMember, oldMembership?: string): void {
        const enc = this.roomEncryptors[event.getRoomId()!];
        if (!enc) {
            // not encrypting in this room
            return;
        }
        enc.onRoomMembership(member);
    }

    /** Callback for OlmMachine.registerRoomKeyUpdatedCallback
     *
     * Called by the rust-sdk whenever there is an update to (megolm) room keys. We
     * check if we have any events waiting for the given keys, and schedule them for
     * a decryption retry if so.
     *
     * @param keys - details of the updated keys
     */
    public async onRoomKeysUpdated(keys: RustSdkCryptoJs.RoomKeyInfo[]): Promise<void> {
        for (const key of keys) {
            this.onRoomKeyUpdated(key);
        }
    }

    private onRoomKeyUpdated(key: RustSdkCryptoJs.RoomKeyInfo): void {
        logger.debug(`Got update for session ${key.senderKey.toBase64()}|${key.sessionId} in ${key.roomId.toString()}`);
        const pendingList = this.eventDecryptor.getEventsPendingRoomKey(key);
        if (pendingList.length === 0) return;

        logger.debug(
            "Retrying decryption on events:",
            pendingList.map((e) => `${e.getId()}`),
        );

        // Have another go at decrypting events with this key.
        //
        // We don't want to end up blocking the callback from Rust, which could otherwise end up dropping updates,
        // so we don't wait for the decryption to complete. In any case, there is no need to wait:
        // MatrixEvent.attemptDecryption ensures that there is only one decryption attempt happening at once,
        // and deduplicates repeated attempts for the same event.
        for (const ev of pendingList) {
            ev.attemptDecryption(this, { isRetry: true }).catch((_e) => {
                logger.info(`Still unable to decrypt event ${ev.getId()} after receiving key`);
            });
        }
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // Outgoing requests
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private async outgoingRequestLoop(): Promise<void> {
        if (this.outgoingRequestLoopRunning) {
            return;
        }
        this.outgoingRequestLoopRunning = true;
        try {
            while (!this.stopped) {
                const outgoingRequests: Object[] = await this.olmMachine.outgoingRequests();
                if (outgoingRequests.length == 0 || this.stopped) {
                    // no more messages to send (or we have been told to stop): exit the loop
                    return;
                }
                for (const msg of outgoingRequests) {
                    await this.outgoingRequestProcessor.makeOutgoingRequest(msg as OutgoingRequest);
                }
            }
        } catch (e) {
            logger.error("Error processing outgoing-message requests from rust crypto-sdk", e);
        } finally {
            this.outgoingRequestLoopRunning = false;
        }
    }
}

class EventDecryptor {
    /**
     * Events which we couldn't decrypt due to unknown sessions / indexes.
     *
     * Map from senderKey to sessionId to Set of MatrixEvents
     */
    private eventsPendingKey = new MapWithDefault<string, MapWithDefault<string, Set<MatrixEvent>>>(
        () => new MapWithDefault<string, Set<MatrixEvent>>(() => new Set()),
    );

    public constructor(private readonly olmMachine: RustSdkCryptoJs.OlmMachine) {}

    public async attemptEventDecryption(event: MatrixEvent): Promise<IEventDecryptionResult> {
        logger.info("Attempting decryption of event", event);
        // add the event to the pending list *before* attempting to decrypt.
        // then, if the key turns up while decryption is in progress (and
        // decryption fails), we will schedule a retry.
        // (fixes https://github.com/vector-im/element-web/issues/5001)
        this.addEventToPendingList(event);

        const res = (await this.olmMachine.decryptRoomEvent(
            JSON.stringify({
                event_id: event.getId(),
                type: event.getWireType(),
                sender: event.getSender(),
                state_key: event.getStateKey(),
                content: event.getWireContent(),
                origin_server_ts: event.getTs(),
            }),
            new RustSdkCryptoJs.RoomId(event.getRoomId()!),
        )) as RustSdkCryptoJs.DecryptedRoomEvent;

        // Success. We can remove the event from the pending list, if
        // that hasn't already happened.
        this.removeEventFromPendingList(event);

        return {
            clearEvent: JSON.parse(res.event),
            claimedEd25519Key: res.senderClaimedEd25519Key,
            senderCurve25519Key: res.senderCurve25519Key,
            forwardingCurve25519KeyChain: res.forwardingCurve25519KeyChain,
        };
    }

    /**
     * Look for events which are waiting for a given megolm session
     *
     * Returns a list of events which were encrypted by `session` and could not be decrypted
     *
     * @param session -
     */
    public getEventsPendingRoomKey(session: RustSdkCryptoJs.RoomKeyInfo): MatrixEvent[] {
        const senderPendingEvents = this.eventsPendingKey.get(session.senderKey.toBase64());
        if (!senderPendingEvents) return [];

        const sessionPendingEvents = senderPendingEvents.get(session.sessionId);
        if (!sessionPendingEvents) return [];

        const roomId = session.roomId.toString();
        return [...sessionPendingEvents].filter((ev) => ev.getRoomId() === roomId);
    }

    /**
     * Add an event to the list of those awaiting their session keys.
     */
    private addEventToPendingList(event: MatrixEvent): void {
        const content = event.getWireContent();
        const senderKey = content.sender_key;
        const sessionId = content.session_id;

        const senderPendingEvents = this.eventsPendingKey.getOrCreate(senderKey);
        const sessionPendingEvents = senderPendingEvents.getOrCreate(sessionId);
        sessionPendingEvents.add(event);
    }

    /**
     * Remove an event from the list of those awaiting their session keys.
     */
    private removeEventFromPendingList(event: MatrixEvent): void {
        const content = event.getWireContent();
        const senderKey = content.sender_key;
        const sessionId = content.session_id;

        const senderPendingEvents = this.eventsPendingKey.get(senderKey);
        if (!senderPendingEvents) return;

        const sessionPendingEvents = senderPendingEvents.get(sessionId);
        if (!sessionPendingEvents) return;

        sessionPendingEvents.delete(event);

        // also clean up the higher-level maps if they are now empty
        if (sessionPendingEvents.size === 0) {
            senderPendingEvents.delete(sessionId);
            if (senderPendingEvents.size === 0) {
                this.eventsPendingKey.delete(senderKey);
            }
        }
    }
}
