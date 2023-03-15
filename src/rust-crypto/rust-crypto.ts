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
import { IDeviceKeys } from "../@types/crypto";
import type { IToDeviceEvent } from "../sync-accumulator";
import type { IEncryptedEventInfo } from "../crypto/api";
import { MatrixEvent } from "../models/event";
import { Room } from "../models/room";
import { RoomMember } from "../models/room-member";
import { CryptoBackend, OnSyncCompletedData } from "../common-crypto/CryptoBackend";
import { logger } from "../logger";
import { IHttpOpts, MatrixHttpApi, Method } from "../http-api";
import { DeviceTrustLevel, UserTrustLevel } from "../crypto/CrossSigning";
import { RoomEncryptor } from "./RoomEncryptor";
import { OutgoingRequest, OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { KeyClaimManager } from "./KeyClaimManager";
import { DeviceVerification, IDevice } from "../crypto/deviceinfo";
import { DeviceKeys, IDownloadKeyResult, IQueryKeysRequest } from "../client";

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

    private keyClaimManager: KeyClaimManager;
    private outgoingRequestProcessor: OutgoingRequestProcessor;

    public constructor(
        private readonly olmMachine: RustSdkCryptoJs.OlmMachine,
        private readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
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

    public async exportRoomKeys(): Promise<IMegolmSessionData[]> {
        // TODO
        return [];
    }

    public async getUserDeviceInfo(
        userIds: string[],
        downloadUncached = false,
    ): Promise<Map<string, Map<string, IDevice>>> {
        const trackedUsers: Set<RustSdkCryptoJs.UserId> = await this.olmMachine.trackedUsers();
        const result = new Map();

        const untrackedUsers: Set<string> = new Set();

        for (const userId of userIds) {
            const rustUserId = new RustSdkCryptoJs.UserId(userId);

            // if this is a tracked user, we can just fetch the device list from the rust-sdk
            // (NB: this is probably ok even if we race with a leave event such that we stop tracking the user's
            // devices: the rust-sdk will return the last-known device list, which will be good enough.)
            if (trackedUsers.has(rustUserId)) {
                const devices: RustSdkCryptoJs.UserDevices = await this.olmMachine.getUserDevices(rustUserId);
                result.set(
                    userId,
                    new Map(
                        devices
                            .devices()
                            .map((device: RustSdkCryptoJs.Device) => [
                                device.deviceId.toString(),
                                this.rustDeviceToJsDevice(device),
                            ]),
                    ),
                );
            } else if (downloadUncached) {
                untrackedUsers.add(userId);
            }
        }

        // for any users whose device lists we are not tracking, fall back to downloading the device list
        // over HTTP.
        if (untrackedUsers.size >= 1) {
            const queryBody: IQueryKeysRequest = { device_keys: {} };
            for (const u of untrackedUsers) {
                queryBody.device_keys[u] = [];
            }

            const queryResult: IDownloadKeyResult = await this.http.authedRequest(
                Method.Post,
                "/_matrix/client/v3/keys/query",
                undefined,
                queryBody,
                { prefix: "" },
            );
            for (const [userId, keys] of Object.entries(queryResult.device_keys)) {
                result.set(
                    userId,
                    new Map(
                        Object.entries(keys).map(([deviceId, device]) => [
                            deviceId,
                            this.downloadDeviceToJsDevice(device),
                        ]),
                    ),
                );
            }
        }
        return result;
    }

    private rustDeviceToJsDevice(device: RustSdkCryptoJs.Device): IDevice {
        const keys: Record<string, string> = Object.create(null);
        for (const [keyId, key] of device.keys.entries()) {
            keys[keyId.toString()] = key.toBase64();
        }

        let verified: DeviceVerification = DeviceVerification.Unverified;
        if (device.isBlacklisted()) {
            verified = DeviceVerification.Blocked;
        } else if (device.isVerified()) {
            verified = DeviceVerification.Verified;
        }

        return {
            algorithms: [], // TODO
            keys: keys,
            known: false, // TODO
            signatures: undefined, // TODO
            verified: verified,
        };
    }

    private downloadDeviceToJsDevice(device: DeviceKeys[keyof DeviceKeys]): IDevice {
        return {
            algorithms: device.algorithms,
            keys: device.keys,
            known: false,
            signatures: device.signatures,
            verified: DeviceVerification.Unverified,
            unsigned: device.unsigned,
        };
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
