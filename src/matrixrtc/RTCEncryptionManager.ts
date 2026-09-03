/*
Copyright 2025-2026 The Matrix.org Foundation C.I.C.

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
import type { CallMembership } from "./CallMembership.ts";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import { type IKeyTransport, type KeyTransportEventListener, KeyTransportEvents } from "./IKeyTransport.ts";
import { type Logger } from "../logger.ts";
import { sleep } from "../utils.ts";
import {
    type EncryptionKeyMapKey,
    type InboundEncryptionSession,
    type OutboundEncryptionSession,
    type ParticipantDeviceInfo,
} from "./types.ts";
import { OutdatedKeyFilter } from "./utils.ts";
import { computeRtcIdentityRaw } from "./membershipData/rtc.ts";

/**
 * Default for {@link EncryptionConfig.keyRotationParticipantLimit}.
 *
 * Setting this to undefined implies that we do not have a limit and full rotations are always done.
 * This is the most secure and least performant option.
 * It is highly recommended to set this to < 50 for client deployments that are planned to be used for large calls.
 * But before setting this, make yourself familiar with the exact security implications.
 * Key, rotations will stop when reaching this user limit in a call. The call will still be encrypted.
 */
const DEFAULT_KEY_ROTATION_PARTICIPANT_LIMIT: number | undefined = undefined;

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
    private readonly participantKeyRings = new Map<
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
     * The amount of keys that can be shared per minute.
     * This is a shared contingent so it scales quadratically with the amount of users.
     * Each additional user increases
     *  - the amount of to-device messages per rotation
     *  - the amount of all rotations (whole call) per leave/join event
     *
     * The client can only share sharedPerMinuteKeyRotationContingent/N keys per minute where N is the number of call participants.
     * As each rotation sends N-1 to-device messages, the client can only do sharedPerMinuteKeyRotationContingent/(N*(N-1)) = clientRotationsPerMinute.
     * This implies that each key share has to be at least 60s / clientRotationsPerMinute apart.
     *
     * This implies the following rotation interval:
     *  - 2000: 50 users: 1.2min, 100 users: 4.9min, 200: users: 19.9min
     *  - 3000: 50 users: 0.8min, 100 users: 3.3min, 200: users: 13.2min
     *  - 5000: 50 users: 0.5min, 100 users: 1.9min, 200: users: 7.9min
     */
    private sharedPerMinuteToDeviceContingent = 6000;

    /**
     * 15 minutes force key rotation.
     *
     * This is a stop gap until we have ratcheting.
     * On join we want/need to share the current key with any participatns in the call.
     * This is particularly important in larger calls, where the jitter can span multiple minutes.
     * Hence we can end up with media delays on join of multiple minutes.
     *
     * As a workaround we share immediatlye but make sure we never use a key that is older than 15min + jitter.
     */
    private maxKeyTTL: number | undefined = 60 * 15 * 1000;

    /**
     * We want to avoid rolling out a new outbound key when the previous one was created less than `keyRotationGracePeriodMs` milliseconds ago.
     * This is a computed property. With more users in a call each roation implies more to-device messages.
     * This value increases quadratically with more users.
     *
     * With `N` participants each rotation sends `N-1` to-device messages and every participant does a rotation.
     * That is where the quadratic scaling comes from: more to-device messages per rotation for one user and more user who need to rotate.
     * The call as a whole can only afford a limit amount per time.
     * See {@link RTCEncryptionManager.sharedPerMinuteToDeviceContingent} for more details.
     *
     * This must be higher than `useKeyDelay` to have an effect.
     * If it is lower, the current key will always be older than the grace period.
     * @private
     */
    private get keyRotationGracePeriodMs(): number {
        const participantCount = this.getMemberships().length;
        return (60_000 * participantCount * (participantCount - 1)) / this.sharedPerMinuteToDeviceContingent;
    }

    /**
     * The number of participants at or above which we stop rotating the key altogether.
     * The current key is still distributed to new joiners, but no new key is generated.
     * @see EncryptionConfig.keyRotationParticipantLimit
     * @private
     */
    private keyRotationParticipantLimit = DEFAULT_KEY_ROTATION_PARTICIPANT_LIMIT;

    /**
     * If a new key distribution is being requested while one is going on, we will set this flag to true.
     * This will ensure that a new round is started after the current one.
     * @private
     */
    private needToEnsureKeyAgain: { scheduled: boolean; fakeMemberChange: boolean } | undefined = undefined;

    /**
     * There is a possibility that keys arrive in the wrong order.
     * For example, after a quick join/leave/join, there will be 2 keys of index 0 distributed, and
     * if they are received in the wrong order, the stream won't be decryptable.
     * For that reason we keep a small buffer of keys for a limited time to disambiguate.
     * @private
     */
    private keyBuffer = new OutdatedKeyFilter();

    private logger: Logger | undefined = undefined;

    private readonly rtcIdentityProvider: (userId: string, deviceId: string, memberId: string) => Promise<string>;

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
        private readonly ownMembership: CallMembershipIdentityParts,
        private getMemberships: () => CallMembership[],
        private transport: IKeyTransport,
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
        this.rtcIdentityProvider = rtcBackendIdProvider ?? computeRtcIdentityRaw;
    }

    /**
     * Whether the session currently has too many participants for the key to be rotated.
     *
     * This is computed by checking the participant count. If there are too many participants for efficient rotations,
     * the key rotation will be suppressed.
     * While this is true, the current key is still shared with new joiners and the current call is still fully encrypted,
     * but no new key is generated for joiners or leavers. Changes are signalled by {@link MatrixRTCSessionEvent.KeyRotationSuppressedChanged}.
     * @see EncryptionConfig.keyRotationParticipantLimit
     */
    public get isKeyRotationSuppressed(): boolean {
        if (!this.manageMediaKeys) return false;
        if (this.keyRotationParticipantLimit === undefined) return false;
        return this.getMemberships().length >= this.keyRotationParticipantLimit;
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
        this.sharedPerMinuteToDeviceContingent =
            joinConfig?.sharedPerMinuteToDeviceContingent ?? this.sharedPerMinuteToDeviceContingent;
        this.keyRotationParticipantLimit =
            joinConfig?.keyRotationParticipantLimit ?? DEFAULT_KEY_ROTATION_PARTICIPANT_LIMIT;

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
    private ensureKeyDistribution(scheduled = false, fakeMemberChange = false): void {
        // `manageMediaKeys` is a stop-gap solution for now. The preferred way to handle this case would be instead
        // to create a NoOpEncryptionManager that does nothing and use it for the session.
        // This will be done when removing the legacy EncryptionManager.
        if (!this.manageMediaKeys) return;
        if (this.currentKeyDistributionPromise == null) {
            this.logger?.debug(`No active rollout, start a new one`);
            // start a rollout
            this.currentKeyDistributionPromise = this.rolloutOutboundKey(scheduled, fakeMemberChange).then(() => {
                this.logger?.debug(`Rollout completed`);
                this.currentKeyDistributionPromise = null;
                if (this.needToEnsureKeyAgain !== undefined) {
                    this.logger?.debug(`New Rollout needed`);
                    const againWith = this.needToEnsureKeyAgain;
                    this.needToEnsureKeyAgain = undefined;
                    // rollout a new one
                    this.ensureKeyDistribution(againWith.scheduled, againWith.fakeMemberChange);
                }
            });
        } else {
            // There is a rollout in progress, but a key rotation is requested (could be caused by a ownMembership change)
            // Remember that a new rotation is needed after the current one.
            this.logger?.debug(`Rollout in progress, a new rollout will be started after the current one`);
            this.needToEnsureKeyAgain = { scheduled, fakeMemberChange };
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
        } else {
            this.logger?.info(
                `Received an out of order key for ${membership.userId}:${membership.deviceId}, dropping it`,
            );
        }
    };

    /**
     * Called when the memberships of the call change. (including ownMembership)
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

    private rotationBlockedUntilTs: number = 0;
    private scheduledForBlockTs: number | undefined = undefined;
    private async rolloutOutboundKey(scheduled: boolean = false, fakeMemberChange: boolean = false): Promise<void> {
        const isFirstKey = this.outboundSession === null;
        if (isFirstKey) {
            // create the first key
            const firstKey = this.createNewOutboundSession(0)
            // Immediatly start using first key for media. Skipping: await sleep(this.useKeyDelay);
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
                    userId: membership.sender,
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

        // A membership change requires a rotation if someone we shared the current key with is gone (`anyLeft`)
        // or if someone joined who is not supposed to be able to decrypt the media we sent before they joined (`anyJoined`).
        const membershipChanged = anyLeft.length > 0 || anyJoined.length > 0;

        // Default to the current session: unless we rotate below, the new joiners simply get the current key.
        let newOutboundEncryptionSession: OutboundEncryptionSession = this.outboundSession!;
        let hasKeyChanged = false;
        let toDistributeTo: ParticipantDeviceInfo[] = [];

        if (!membershipChanged && !scheduled && !fakeMemberChange) {
            // Nothing changed and there is no rotation that we postponed earlier: nothing to do.
            return;
        }
        const rotationJitter = Math.random() * 2;
        const now = Date.now();

        if (this.isKeyRotationSuppressed) {
            // The session is too large to rotate at all (hard limit). The key is only shared with the new joiners.
            // There is nothing to schedule: this will not change until the session shrinks again, which will
            // show up as a membership change of its own.
            toDistributeTo = anyJoined;
            this.logger?.debug(
                `Key rotation is suppressed, the session has ${toShareWith.length} participants (limit:${this.keyRotationParticipantLimit})`,
            );
        } else if (isFirstKey) {
            // key is shared with everyone toDistributeTo = anyJoined = toShareWith (because alreadySharedWith=[])
            toDistributeTo = anyJoined;
            this.rotationBlockedUntilTs = now + this.keyRotationGracePeriodMs * rotationJitter;
        } else if (scheduled) {
            // This is caused by a scheduled sleep(blockTime) -> we rotate right away
            newOutboundEncryptionSession = this.createNewOutboundSession();
            hasKeyChanged = true;
            toDistributeTo = toShareWith;
            // We set a blockTs but do not schedule a ensureKeyDistribution. Reason: We might not need to rotate after the block.
            // Only if there was a memship change until rotationBlockedUntilTs.
            this.rotationBlockedUntilTs = now + this.keyRotationGracePeriodMs;
        } else if (this.rotationBlockedUntilTs <= now) {
            // Currently Not-Blocked! But we dont rotate immediatly prohibit bursts.
            // We apply jitter -> dont rotate now -> toDistributeTo = [];
            const blockTime = this.keyRotationGracePeriodMs * rotationJitter;
            this.rotationBlockedUntilTs = blockTime + now;
            this.scheduleEnsureKeyDistributionIfNotYetScheduled(blockTime);
            // still distribute to new joiners. This is possible due to maxKeyTTL.
            // (we leak at most the last maxKeyTTL of the call for new joiners)
            toDistributeTo = anyJoined;
        } else if (now < this.rotationBlockedUntilTs) {
            // Currently Blocked! We prohibit rotation (toDistributeTo = []). But we schedule ensureKeyDistribution.
            // If already scheduled we dont reschedule to prohibit the `if(scheduled)` case to be fire multiple times.
            this.scheduleEnsureKeyDistributionIfNotYetScheduled(this.rotationBlockedUntilTs - now);
            // still distribute to new joiners. This is possible due to maxKeyTTL.
            // (we leak at most the last maxKeyTTL of the call for new joiners)
            toDistributeTo = anyJoined;
        }
        if (toDistributeTo.length === 0) return;

        try {
            this.logger?.trace(`Sending key...`);
            await this.transport.sendKey(
                encodeBase64(newOutboundEncryptionSession.key),
                newOutboundEncryptionSession.keyId,
                toDistributeTo,
            );
            newOutboundEncryptionSession.sharedWith.push(...toDistributeTo);
            const outboundSessionList = newOutboundEncryptionSession.sharedWith
                .map((m) => `${m.userId}:${m.deviceId}`)
                .join(",");
            this.logger?.trace(`key index:${newOutboundEncryptionSession.keyId} sent to ${outboundSessionList}`);
            if (hasKeyChanged) {
                // Delay a bit before using this key
                // It is recommended not to start using a key immediately but instead wait for a short time to make sure it is delivered.
                this.logger?.trace(`Delay Rollout for key:${newOutboundEncryptionSession.keyId}...`);
                await sleep(this.useKeyDelay);
                this.logger?.trace(`...Delayed rollout of index:${newOutboundEncryptionSession.keyId} `);
                this.addKeyToParticipantWithBackendIdentity(
                    newOutboundEncryptionSession.key,
                    newOutboundEncryptionSession.keyId,
                    this.ownMembership,
                    await this.getOwnRtcBackendIdentity(),
                );
            }
        } catch (err) {
            this.logger?.error(`Failed to rollout key`, err);
        }
    }

    private scheduleEnsureKeyDistributionIfNotYetScheduled(blockTime: number): void {
        if (this.scheduledForBlockTs !== this.rotationBlockedUntilTs) {
            this.scheduledForBlockTs = this.rotationBlockedUntilTs;
            void sleep(blockTime).then(() => this.ensureKeyDistribution(true));
        }
    }

    /**
     * Schedule the rotation of the key when it reaches its maximum age.
     * This has to be called for every new outbound key: the TTL of a key starts
     * @see RTCEncryptionManager.maxKeyTTL
     */
    private scheduleMaxKeyTTLRotation(): void {
        if (this.maxKeyTTL === undefined) return;
        const fakeMemberChange = true;
        // trick the key rollout system to execute the rollout as if there was a member change.
        setTimeout(
            () => this.ensureKeyDistribution(false, fakeMemberChange),
            Math.max(this.maxKeyTTL, this.keyRotationGracePeriodMs),
        );
    }

    private createNewOutboundSession(index:number|undefined = undefined): OutboundEncryptionSession {
        const newOutboundKey: OutboundEncryptionSession = {
            key: this.generateRandomKey(),
            creationTS: Date.now(),
            sharedWith: [],
            keyId: index ?? this.nextKeyIndex(),
        };

        this.scheduleMaxKeyTTLRotation();

        this.logger?.info(`creating new outbound key index:${newOutboundKey.keyId}`);
        // Set this new key as the current one
        this.outboundSession = newOutboundKey;
        return newOutboundKey;
    }

    private nextKeyIndex(): number {
        if (this.outboundSession) {
            return (this.outboundSession.keyId + 1) % 256;
        }
        return 0;
    }

    private generateRandomKey(): Uint8Array<ArrayBuffer> {
        const key = new Uint8Array(16);
        globalThis.crypto.getRandomValues(key);
        return key;
    }
}
