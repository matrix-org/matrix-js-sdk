/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import {
    type CallMembershipIdentityParts,
    getEncryptionKeyMapKey,
    type IEncryptionManager,
} from "./EncryptionManager.ts";
import { type EncryptionConfig, type MembershipConfig } from "./MatrixRTCSession.ts";
import { CallMembership } from "./CallMembership.ts";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import { type IKeyTransport, type KeyTransportEventListener, KeyTransportEvents } from "./IKeyTransport.ts";
import { type Logger } from "../logger.ts";
import { sleep } from "../utils.ts";
import {
    type EncryptionKeyMapKey,
    type InboundEncryptionSession,
    type OutboundEncryptionSession,
    type ParticipantDeviceInfo,
    type Statistics,
} from "./types.ts";
import { OutdatedKeyFilter } from "./utils.ts";

/**
 * RTCEncryptionManager is used to manage the encryption keys for a call.
 *
 * It is responsible for distributing the keys to the other participants and rotating the keys if needed.
 *
 * This manager when used with to-device transport will share the existing key only to new joiners, and rotate
 * if there is a leaver.
 *
 * XXX In the future we want to distribute a ratcheted key not the current one for new joiners.
 */
export class RTCEncryptionManager implements IEncryptionManager {
    // This is a stop-gap solution for now. The preferred way to handle this case would be instead
    // to create a NoOpEncryptionManager that does nothing and use it for the session.
    // This will be done when removing the legacy EncryptionManager.
    private manageMediaKeys = false;

    private useHashedRtcBackendIdentity = false;
    private ownRtcBackendIdentityCache: string | undefined;

    /**
     * Store the key rings for each participant.
     * The encryption manager stores the keys because the application layer might not be ready yet to handle the keys.
     * The keys are stored and can be retrieved later when the application layer is ready {@link RTCEncryptionManager#getEncryptionKeys}.
     */
    private participantKeyRings = new Map<
        EncryptionKeyMapKey,
        Array<{
            key: Uint8Array<ArrayBuffer>;
            keyIndex: number;
            membership: CallMembershipIdentityParts;
            rtcBackendIdentity: string;
        }>
    >();

    // The current per-sender media key for this device
    private outboundSession: OutboundEncryptionSession | null = null;

    /**
     * Ensures that there is only one distribute operation at a time for that call.
     */
    private currentKeyDistributionPromise: Promise<void> | null = null;

    /**
     * The time to wait before using the outbound session after it has been distributed.
     * This is to ensure that the key is delivered to all participants before it is used.
     * When creating the first key, this is set to 0 so that the key can be used immediately.
     */
    private useKeyDelay = 5000;

    /**
     * We want to avoid rolling out a new outbound key when the previous one was created less than `keyRotationGracePeriodMs` milliseconds ago.
     * This is to avoid expensive key rotations when users quickly join the call in a row.
     *
     * This must be higher than `useKeyDelay` to have an effect.
     * If it is lower, the current key will always be older than the grace period.
     * @private
     */
    private keyRotationGracePeriodMs = 10_000;

    /**
     * If a new key distribution is being requested while one is going on, we will set this flag to true.
     * This will ensure that a new round is started after the current one.
     * @private
     */
    private needToEnsureKeyAgain = false;

    /**
     * There is a possibility that keys arrive in the wrong order.
     * For example, after a quick join/leave/join, there will be 2 keys of index 0 distributed, and
     * if they are received in the wrong order, the stream won't be decryptable.
     * For that reason we keep a small buffer of keys for a limited time to disambiguate.
     * @private
     */
    private keyBuffer = new OutdatedKeyFilter();

    private logger: Logger | undefined = undefined;

    private rtcIdentityProvider: (userId: string, deviceId: string, memberId: string) => Promise<string>;

    /**
     *
     * @param ownMembership - our own membership info
     * @param getMemberships - function to get current memberships
     * @param transport - key transport (room or to-device)
     * @param statistics - statistics collector
     * @param onEncryptionKeysChanged - callback to notify the media layer of new keys
     * @param parentLogger - optional parent logger
     * @param rtcBackendIdProvider - A function to compute the rtc backend identity, exposed for testing purposes
     */
    public constructor(
        private ownMembership: CallMembershipIdentityParts,
        private getMemberships: () => CallMembership[],
        private transport: IKeyTransport,
        private statistics: Statistics,
        // Callback to notify the media layer of new keys
        private onEncryptionKeysChanged: (
            keyBin: Uint8Array<ArrayBuffer>,
            encryptionKeyIndex: number,
            membership: CallMembershipIdentityParts,
            rtcBackendIdentity: string,
        ) => void,
        parentLogger?: Logger,
        rtcBackendIdProvider?: (userId: string, deviceId: string, memberId: string) => Promise<string>,
    ) {
        this.logger = parentLogger?.getChild(`[EncryptionManager]`);
        this.rtcIdentityProvider = rtcBackendIdProvider ?? CallMembership.computeRtcIdentityRaw;
    }

    private async getOwnRtcBackendIdentity(): Promise<string> {
        if (this.ownRtcBackendIdentityCache) return this.ownRtcBackendIdentityCache;

        if (this.useHashedRtcBackendIdentity) {
            const { userId, deviceId, memberId } = this.ownMembership;
            this.logger?.info(
                // If we see this log multiple times, we need to reconsider the precompute call of getOwnRtcBackendIdentity
                `Computing RTC backend identity for ${userId}:${deviceId}:${memberId} (SHOULD ONLY BE CALLED ONCE)`,
            );
            this.ownRtcBackendIdentityCache = await this.rtcIdentityProvider(userId, deviceId, memberId);
        } else {
            this.ownRtcBackendIdentityCache = `${this.ownMembership.userId}:${this.ownMembership.deviceId}`;
        }
        return this.ownRtcBackendIdentityCache;
    }

    public getEncryptionKeys(): ReadonlyMap<
        EncryptionKeyMapKey,
        ReadonlyArray<{
            key: Uint8Array<ArrayBuffer>;
            keyIndex: number;
            membership: CallMembershipIdentityParts;
            rtcBackendIdentity: string;
        }>
    > {
        return new Map(this.participantKeyRings);
    }

    private keysWithoutMatchingRTCMembership: Array<{
        key: Uint8Array<ArrayBuffer>;
        keyIndex: number;
        membership: CallMembershipIdentityParts;
    }> = [];

    private checkKeysWithoutMatchingRTCMembership(): void {
        const keyInfoTemp = this.keysWithoutMatchingRTCMembership;
        this.keysWithoutMatchingRTCMembership = [];
        keyInfoTemp.forEach((keyInfo) => {
            this.addKeyToParticipant(keyInfo.key, keyInfo.keyIndex, keyInfo.membership);
        });
    }

    private addKeyToParticipant(
        key: Uint8Array<ArrayBuffer>,
        keyIndex: number,
        membership: CallMembershipIdentityParts,
    ): void {
        const knownRtcMembership = this.getMemberships();
        const fullMembership = knownRtcMembership.find(
            (member) => member.userId === membership.userId && member.deviceId === membership.deviceId,
        );
        if (!fullMembership) {
            this.logger?.info(
                `No matching RTC membership for key from ${membership.userId}:${membership.deviceId}, delaying key addition`,
            );
            this.keysWithoutMatchingRTCMembership.push({ key, keyIndex, membership });
            return;
        }
        this.addKeyToParticipantWithBackendIdentity(key, keyIndex, membership, fullMembership.rtcBackendIdentity);
    }

    private addKeyToParticipantWithBackendIdentity(
        key: Uint8Array<ArrayBuffer>,
        keyIndex: number,
        membership: CallMembershipIdentityParts,
        rtcBackendIdentity: string,
    ): void {
        const mapKey = getEncryptionKeyMapKey(membership);
        if (!this.participantKeyRings.has(mapKey)) {
            this.participantKeyRings.set(mapKey, []);
        }
        this.participantKeyRings.get(mapKey)!.push({ key, keyIndex, membership, rtcBackendIdentity });
        this.onEncryptionKeysChanged(key, keyIndex, membership, rtcBackendIdentity);
    }

    public join(joinConfig: (EncryptionConfig & MembershipConfig) | undefined): void {
        this.manageMediaKeys = joinConfig?.manageMediaKeys ?? true; // default to true
        this.useHashedRtcBackendIdentity = joinConfig?.unstableSendStickyEvents ?? false;
        this.useKeyDelay = joinConfig?.useKeyDelay ?? 1000;
        this.keyRotationGracePeriodMs = joinConfig?.keyRotationGracePeriodMs ?? 10_000;

        this.transport.on(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        void this.getOwnRtcBackendIdentity(); // precompute own identity

        this.logger?.info(`Joining room`);
        this.transport.start();
    }

    public leave(): void {
        this.transport.off(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.stop();
        this.participantKeyRings.clear();
    }

    /**
     * Will ensure that a new key is distributed and used to encrypt our media.
     * If there is already a key distribution in progress, it will schedule a new distribution round just after the current one is completed.
     * If this function is called repeatedly while a distribution is in progress,
     * the calls will be coalesced to a single new distribution (that will start just after the current one has completed).
     */
    private ensureKeyDistribution(): void {
        // `manageMediaKeys` is a stop-gap solution for now. The preferred way to handle this case would be instead
        // to create a NoOpEncryptionManager that does nothing and use it for the session.
        // This will be done when removing the legacy EncryptionManager.
        if (!this.manageMediaKeys) return;
        if (this.currentKeyDistributionPromise == null) {
            this.logger?.debug(`No active rollout, start a new one`);
            // start a rollout
            this.currentKeyDistributionPromise = this.rolloutOutboundKey().then(() => {
                this.logger?.debug(`Rollout completed`);
                this.currentKeyDistributionPromise = null;
                if (this.needToEnsureKeyAgain) {
                    this.logger?.debug(`New Rollout needed`);
                    this.needToEnsureKeyAgain = false;
                    // rollout a new one
                    this.ensureKeyDistribution();
                }
            });
        } else {
            // There is a rollout in progress, but a key rotation is requested (could be caused by a ownMembership change)
            // Remember that a new rotation is needed after the current one.
            this.logger?.debug(`Rollout in progress, a new rollout will be started after the current one`);
            this.needToEnsureKeyAgain = true;
        }
    }

    public onNewKeyReceived: KeyTransportEventListener = (membership, keyBase64Encoded, index, timestamp) => {
        // `manageMediaKeys` is a stop-gap solution for now. The preferred way to handle this case would be instead
        // to create a NoOpEncryptionManager that does nothing and use it for the session.
        // This will be done when removing the legacy EncryptionManager.
        if (!this.manageMediaKeys) {
            this.logger?.warn(
                `Received key over transport ${membership.userId}:${membership.deviceId} at index ${index} but media keys are disabled`,
            );
            return;
        }
        this.logger?.debug(`Received key over transport ${membership.userId}:${membership.deviceId} at index ${index}`);

        // We received a new key, notify the video layer of this new key so that it can decrypt the frames properly.
        const keyBin = decodeBase64(keyBase64Encoded);
        const candidateInboundSession: InboundEncryptionSession = {
            key: keyBin,
            membership,
            keyIndex: index,
            creationTS: timestamp,
        };

        const outdated = this.keyBuffer.isOutdated(membership, candidateInboundSession);
        if (!outdated) {
            this.addKeyToParticipant(
                candidateInboundSession.key,
                candidateInboundSession.keyIndex,
                candidateInboundSession.membership,
            );
            this.statistics.counters.roomEventEncryptionKeysReceived += 1;
        } else {
            this.logger?.info(
                `Received an out of order key for ${membership.userId}:${membership.deviceId}, dropping it`,
            );
        }
    };

    /**
     * Called when the ownMembership of the call changes.
     * This encryption manager is very basic, it will rotate the key everytime this is called.
     * @param oldMemberships - This parameter is not used here, but it is kept for compatibility with the interface.
     */
    public onMembershipsUpdate(oldMemberships: CallMembership[] = []): void {
        this.logger?.trace(`onMembershipsUpdate`);

        // Ensure the key is distributed. This will be no-op if the key is already being distributed to everyone.
        // If there is an ongoing distribution, it will be completed before a new one is started.
        this.ensureKeyDistribution();
        // ensure key emission to the rtc backend
        this.checkKeysWithoutMatchingRTCMembership();
    }

    private async rolloutOutboundKey(): Promise<void> {
        const isFirstKey = this.outboundSession == null;
        if (isFirstKey) {
            // create the first key
            const firstKey = {
                key: this.generateRandomKey(),
                creationTS: Date.now(),
                sharedWith: [],
                keyId: 0,
            };
            this.outboundSession = firstKey;
            this.addKeyToParticipantWithBackendIdentity(
                firstKey.key,
                firstKey.keyId,
                this.ownMembership,
                await this.getOwnRtcBackendIdentity(),
            );
        }
        // get current memberships
        const toShareWith: ParticipantDeviceInfo[] = this.getMemberships()
            .filter((membership) => {
                return membership.sender != undefined;
            })
            .map((membership) => {
                return {
                    userId: membership.sender!,
                    deviceId: membership.deviceId,
                    membershipTs: membership.createdTs(),
                };
            });

        let alreadySharedWith = this.outboundSession?.sharedWith ?? [];

        // Some users might have rotate their ownMembership event (formally called fingerprint) meaning they might have
        // clear their key. Reset the `alreadySharedWith` flag for them.
        alreadySharedWith = alreadySharedWith.filter(
            (x) =>
                // If there was a member with same userId and deviceId but different membershipTs, we need to clear it
                !toShareWith.some(
                    (o) => x.userId == o.userId && x.deviceId == o.deviceId && x.membershipTs != o.membershipTs,
                ),
        );

        const anyLeft = alreadySharedWith.filter(
            (x) =>
                !toShareWith.some(
                    (o) => x.userId == o.userId && x.deviceId == o.deviceId && x.membershipTs == o.membershipTs,
                ),
        );
        const anyJoined = toShareWith.filter(
            (x) =>
                !alreadySharedWith.some(
                    (o) => x.userId == o.userId && x.deviceId == o.deviceId && x.membershipTs == o.membershipTs,
                ),
        );

        let toDistributeTo: ParticipantDeviceInfo[] = [];
        let outboundKey: OutboundEncryptionSession;
        let hasKeyChanged = false;
        if (anyLeft.length > 0) {
            // We need to rotate the key
            const newOutboundKey = this.createNewOutboundSession();
            hasKeyChanged = true;
            toDistributeTo = toShareWith;
            outboundKey = newOutboundKey;
        } else if (anyJoined.length > 0) {
            const now = Date.now();
            const keyAge = now - this.outboundSession!.creationTS;
            // If the current key is recently created (less than `keyRotationGracePeriodMs`), we can keep it and just distribute it to the new joiners.
            if (keyAge < this.keyRotationGracePeriodMs) {
                // keep the same key
                // XXX In the future we want to distribute a ratcheted key, not the current one
                this.logger?.debug(`New joiners detected, but the key is recent enough (age:${keyAge}), keeping it`);
                toDistributeTo = anyJoined;
                outboundKey = this.outboundSession!;
            } else {
                // We need to rotate the key
                this.logger?.debug(`New joiners detected, rotating the key`);
                const newOutboundKey = this.createNewOutboundSession();
                hasKeyChanged = true;
                toDistributeTo = toShareWith;
                outboundKey = newOutboundKey;
            }
        } else {
            // no changes
            return;
        }

        try {
            this.logger?.trace(`Sending key...`);
            await this.transport.sendKey(encodeBase64(outboundKey.key), outboundKey.keyId, toDistributeTo);
            this.statistics.counters.roomEventEncryptionKeysSent += 1;
            outboundKey.sharedWith.push(...toDistributeTo);
            this.logger?.trace(
                `key index:${outboundKey.keyId} sent to ${outboundKey.sharedWith.map((m) => `${m.userId}:${m.deviceId}`).join(",")}`,
            );
            if (hasKeyChanged) {
                // Delay a bit before using this key
                // It is recommended not to start using a key immediately but instead wait for a short time to make sure it is delivered.
                this.logger?.trace(`Delay Rollout for key:${outboundKey.keyId}...`);
                await sleep(this.useKeyDelay);
                this.logger?.trace(`...Delayed rollout of index:${outboundKey.keyId} `);
                this.addKeyToParticipantWithBackendIdentity(
                    outboundKey.key,
                    outboundKey.keyId,
                    this.ownMembership,
                    await this.getOwnRtcBackendIdentity(),
                );
            }
        } catch (err) {
            this.logger?.error(`Failed to rollout key`, err);
        }
    }

    private createNewOutboundSession(): OutboundEncryptionSession {
        const newOutboundKey: OutboundEncryptionSession = {
            key: this.generateRandomKey(),
            creationTS: Date.now(),
            sharedWith: [],
            keyId: this.nextKeyIndex(),
        };

        this.logger?.info(`creating new outbound key index:${newOutboundKey.keyId}`);
        // Set this new key as the current one
        this.outboundSession = newOutboundKey;
        return newOutboundKey;
    }

    private nextKeyIndex(): number {
        if (this.outboundSession) {
            return (this.outboundSession!.keyId + 1) % 256;
        }
        return 0;
    }

    private generateRandomKey(): Uint8Array<ArrayBuffer> {
        const key = new Uint8Array(16);
        globalThis.crypto.getRandomValues(key);
        return key;
    }
}
