/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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
import type { IToDeviceEvent } from "../sync-accumulator";
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

/**
 * An implementation of {@link CryptoBackend} using the Rust matrix-sdk-crypto.
 */
export class RustCrypto implements CryptoBackend {
    public globalBlacklistUnverifiedDevices = false;
    public globalErrorOnUnknownDevices = false;

    /** whether {@link stop} has been called */
    private stopped = false;

    /** whether {@link outgoingRequestLoop} is currently running */
    private outgoingRequestLoopRunning = false;

    /** mapping of roomId → encryptor class */
    private roomEncryptors: Record<string, RoomEncryptor> = {};

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

    public prepareToEncrypt(room: Room): void {
        const encryptor = this.roomEncryptors[room.roomId];

        if (encryptor) {
            encryptor.ensureEncryptionSession();
        }
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
        return {
            clearEvent: JSON.parse(res.event),
            claimedEd25519Key: res.senderClaimedEd25519Key,
            senderCurve25519Key: res.senderCurve25519Key,
            forwardingCurve25519KeyChain: res.forwardingCurve25519KeyChain,
        };
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

    public async userHasCrossSigningKeys(): Promise<boolean> {
        // TODO
        return false;
    }

    public async exportRoomKeys(): Promise<IMegolmSessionData[]> {
        // TODO
        return [];
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
    // SyncCryptoCallbacks implementation
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /** called by the sync loop to preprocess incoming to-device messages
     *
     * @param events - the received to-device messages
     * @returns A list of preprocessed to-device messages.
     */
    public async preprocessToDeviceMessages(events: IToDeviceEvent[]): Promise<IToDeviceEvent[]> {
        // send the received to-device messages into receiveSyncChanges. We have no info on device-list changes,
        // one-time-keys, or fallback keys, so just pass empty data.
        const result = await this.olmMachine.receiveSyncChanges(
            JSON.stringify(events),
            new RustSdkCryptoJs.DeviceLists(),
            new Map(),
            new Set(),
        );

        // receiveSyncChanges returns a JSON-encoded list of decrypted to-device messages.
        return JSON.parse(result);
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
            this.roomEncryptors[room.roomId] = new RoomEncryptor(this.olmMachine, this.keyClaimManager, room, config);
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
