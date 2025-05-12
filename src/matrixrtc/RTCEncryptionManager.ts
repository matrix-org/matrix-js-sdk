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

import { type IEncryptionManager } from "./EncryptionManager.ts";
import { type EncryptionConfig } from "./MatrixRTCSession.ts";
import { type CallMembership } from "./CallMembership.ts";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import { type IKeyTransport, type KeyTransportEventListener, KeyTransportEvents } from "./IKeyTransport.ts";
import { logger as rootLogger, type Logger } from "../logger.ts";
import { defer, type IDeferred, sleep } from "../utils.ts";
import type { InboundEncryptionSession, ParticipantDeviceInfo, ParticipantId, Statistics } from "./types.ts";
import { getParticipantId, KeyBuffer } from "./utils.ts";
import {
    type EnabledTransports,
    RoomAndToDeviceEvents,
    RoomAndToDeviceTransport,
} from "./RoomAndToDeviceKeyTransport.ts";

type OutboundEncryptionSession = {
    key: Uint8Array;
    creationTS: number;
    sharedWith: Array<ParticipantDeviceInfo>;
    // This is an index acting as the id of the key
    keyId: number;
};

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
    // The current per-sender media key for this device
    private outboundSession: OutboundEncryptionSession | null = null;

    /**
     * Ensures that there is only one distribute operation at a time for that call.
     */
    private currentKeyDistributionPromise: Promise<void> | null = null;
    /** The time to wait before using outbound session after it has been distributed */
    private delayRolloutTimeMillis = 1000;
    /**
     * If a new key distribution is being requested while one is going on, we will set this flag to true.
     * This will ensure that a new round is started after the current one.
     * @private
     */
    private needToEnsureKeyAgain = false;

    /**
     * There is a possibility that keys arrive in wrong order.
     * For example after a quick join/leave/join, there will be 2 keys of index 0 distributed and
     * if they are received in wrong order the stream won't be decryptable.
     * For that reason we keep a small buffer of keys for a limited time to disambiguate.
     * @private
     */
    private keyBuffer = new KeyBuffer(1000 /** 1 second */);

    private logger: Logger;

    private currentRatchetRequest: IDeferred<{ key: ArrayBuffer; keyIndex: number }> | null = null;

    public constructor(
        private userId: string,
        private deviceId: string,
        private getMemberships: () => CallMembership[],
        private transport: IKeyTransport,
        private statistics: Statistics,
        private onEncryptionKeysChanged: (
            keyBin: Uint8Array,
            encryptionKeyIndex: number,
            participantId: ParticipantId,
        ) => void,
        private ratchetKey: (participantId: ParticipantId, encryptionKeyIndex: number) => void,
        parentLogger?: Logger,
    ) {
        this.logger = (parentLogger ?? rootLogger).getChild(`[RTCEncryptionManager]`);
    }

    public getEncryptionKeys(): Map<string, Array<{ key: Uint8Array; timestamp: number }>> {
        // This is deprecated should be ignored. Only use by tests?
        return new Map();
    }

    public join(joinConfig: EncryptionConfig | undefined): void {
        this.logger.info(`Joining room`);
        this.delayRolloutTimeMillis = joinConfig?.useKeyDelay ?? 1000;
        this.transport.on(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        // Deprecate RoomKeyTransport: this can get removed.
        if (this.transport instanceof RoomAndToDeviceTransport) {
            this.transport.on(RoomAndToDeviceEvents.EnabledTransportsChanged, this.onTransportChanged);
        }

        this.transport.start();
    }

    public leave(): void {
        this.keyBuffer.clear();
        this.transport.off(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.stop();
    }

    private onTransportChanged: (enabled: EnabledTransports) => void = () => {
        this.logger.info("Transport change detected, restarting key distribution");
        // Temporary for backwards compatibility
        if (this.currentKeyDistributionPromise) {
            this.currentKeyDistributionPromise
                .then(() => {
                    if (this.outboundSession) {
                        this.outboundSession.sharedWith = [];
                        this.ensureMediaKey();
                    }
                })
                .catch((e) => {
                    this.logger.error("Failed to restart key distribution", e);
                });
        } else {
            if (this.outboundSession) {
                this.outboundSession.sharedWith = [];
                this.ensureMediaKey();
            }
        }
    };

    /**
     * Will ensure that a new key is distributed and used to encrypt our media.
     * If this function is called repeatidly, the calls will be buffered to a single key rotation.
     */
    private ensureMediaKey(): void {
        if (this.currentKeyDistributionPromise == null) {
            this.logger.debug(`No active rollout, start a new one`);
            // start a rollout
            this.currentKeyDistributionPromise = this.rolloutOutboundKey().then(() => {
                this.logger.debug(`Rollout completed`);
                this.currentKeyDistributionPromise = null;
                if (this.needToEnsureKeyAgain) {
                    this.logger.debug(`New Rollout needed`);
                    this.needToEnsureKeyAgain = false;
                    // rollout a new one
                    this.ensureMediaKey();
                }
            });
        } else {
            // There is a rollout in progress, but a key rotation is requested (could be caused by a membership change)
            // Remember that a new rotation is needed after the current one.
            this.logger.debug(`Rollout in progress, a new rollout will be started after the current one`);
            this.needToEnsureKeyAgain = true;
        }
    }

    public onNewKeyReceived: KeyTransportEventListener = (userId, deviceId, keyBase64Encoded, index, timestamp) => {
        this.logger.debug(
            `Received key over transport ${userId}:${deviceId} at index ${index} key: ${keyBase64Encoded}`,
        );

        // We received a new key, notify the video layer of this new key so that it can decrypt the frames properly.
        const participantId = getParticipantId(userId, deviceId);
        const keyBin = decodeBase64(keyBase64Encoded);
        const candidateInboundSession: InboundEncryptionSession = {
            key: keyBin,
            participantId,
            keyIndex: index,
            creationTS: timestamp,
        };

        const validSession = this.keyBuffer.disambiguate(participantId, candidateInboundSession);
        if (validSession) {
            this.onEncryptionKeysChanged(validSession.key, validSession.keyIndex, validSession.participantId);
            this.statistics.counters.roomEventEncryptionKeysReceived += 1;
        } else {
            this.logger.info(`Received an out of order key for ${userId}:${deviceId}, dropping it`);
        }
    };

    /**
     * Called when the membership of the call changes.
     * This encryption manager is very basic, it will rotate the key everytime this is called.
     * @param oldMemberships
     */
    public onMembershipsUpdate(oldMemberships: CallMembership[]): void {
        this.logger.trace(`onMembershipsUpdate`);

        // Ensure the key is distributed. This will be no-op if the key is already being distributed to everyone.
        // If there is an ongoing distribution, it will be completed before a new one is started.
        this.ensureMediaKey();
    }

    private async rolloutOutboundKey(): Promise<void> {
        const isFirstKey = this.outboundSession == null;
        if (isFirstKey) {
            // create the first key
            this.outboundSession = {
                key: this.generateRandomKey(),
                creationTS: Date.now(),
                sharedWith: [],
                keyId: 0,
            };
            this.onEncryptionKeysChanged(
                this.outboundSession.key,
                this.outboundSession.keyId,
                getParticipantId(this.userId, this.deviceId),
            );
        }
        // get current memberships
        const toShareWith: ParticipantDeviceInfo[] = this.getMemberships()
            .filter((membership) => {
                return (
                    membership.sender != undefined &&
                    !(
                        // filter me out
                        (membership.sender == this.userId && membership.deviceId == this.deviceId)
                    )
                );
            })
            .map((membership) => {
                return {
                    userId: membership.sender!,
                    deviceId: membership.deviceId,
                    membershipTs: membership.createdTs(),
                };
            });

        let alreadySharedWith = this.outboundSession?.sharedWith ?? [];

        // Some users might have rotate their membership event (formally called fingerprint) meaning they might have
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
            const newOutboundKey: OutboundEncryptionSession = {
                key: this.generateRandomKey(),
                creationTS: Date.now(),
                sharedWith: [],
                keyId: this.nextKeyIndex(),
            };
            hasKeyChanged = true;

            this.logger.info(`creating new outbound key index:${newOutboundKey.keyId}`);
            // Set this new key as the current one
            this.outboundSession = newOutboundKey;

            // Send
            toDistributeTo = toShareWith;
            outboundKey = newOutboundKey;
        } else if (anyJoined.length > 0) {
            if (this.outboundSession!.sharedWith.length > 0) {
                // This key was already shared with someone, we need to ratchet it
                // We want to ratchet the current key and only distribute the ratcheted key to the new joiners
                // This needs to send some async messages, so we need to wait for the ratchet to finish
                const deferredKey = defer<{ key: ArrayBuffer; keyIndex: number }>();
                this.currentRatchetRequest = deferredKey;
                this.logger.info(`Query ratcheting key index:${this.outboundSession!.keyId} ...`);
                this.ratchetKey(getParticipantId(this.userId, this.deviceId), this.outboundSession!.keyId);
                const res = await Promise.race([deferredKey.promise, sleep(1000)]);
                if (res === undefined) {
                    // TODO: we might want to rotate the key instead?
                    this.logger.error("Ratchet key timed out sharing the same key for now :/");
                } else {
                    const { key, keyIndex } = await deferredKey.promise;
                    this.logger.info(
                        `... Ratcheting done key index:${keyIndex} key:${encodeBase64(new Uint8Array(key))}`,
                    );
                    this.outboundSession!.key = new Uint8Array(key);
                    this.onEncryptionKeysChanged(
                        this.outboundSession!.key,
                        this.outboundSession!.keyId,
                        getParticipantId(this.userId, this.deviceId),
                    );
                }
            }
            toDistributeTo = anyJoined;
            outboundKey = this.outboundSession!;
        } else {
            // No one joined or left, it could just be the first key, keep going
            toDistributeTo = [];
            outboundKey = this.outboundSession!;
        }

        try {
            if (toDistributeTo.length > 0) {
                this.logger.trace(`Sending key...`);
                await this.transport.sendKey(encodeBase64(outboundKey.key), outboundKey.keyId, toDistributeTo);
                this.statistics.counters.roomEventEncryptionKeysSent += 1;
                outboundKey.sharedWith.push(...toDistributeTo);
                this.logger.trace(
                    `key index:${outboundKey.keyId} sent to ${outboundKey.sharedWith.map((m) => `${m.userId}:${m.deviceId}`).join(",")}`,
                );
            }
            if (hasKeyChanged) {
                // Delay a bit before using this key
                // It is recommended not to start using a key immediately but instead wait for a short time to make sure it is delivered.
                this.logger.trace(`Delay Rollout for key:${outboundKey.keyId}...`);
                await sleep(this.delayRolloutTimeMillis);
                this.logger.trace(`...Delayed rollout of index:${outboundKey.keyId} `);
                this.onEncryptionKeysChanged(
                    outboundKey.key,
                    outboundKey.keyId,
                    getParticipantId(this.userId, this.deviceId),
                );
            }
        } catch (err) {
            this.logger.error(`Failed to rollout key`, err);
        }
    }

    private nextKeyIndex(): number {
        if (this.outboundSession) {
            return (this.outboundSession!.keyId + 1) % 256;
        }
        return 0;
    }

    private generateRandomKey(): Uint8Array {
        const key = new Uint8Array(16);
        globalThis.crypto.getRandomValues(key);
        return key;
    }

    public onKeyRatcheted(key: ArrayBuffer, participantId: ParticipantId | undefined, keyIndex: number | undefined): void {
        if (participantId == getParticipantId(this.userId, this.deviceId)) {
            // DO NOT COMMIT
            this.logger.debug(`Own key ratcheted for key index:${keyIndex} key:${encodeBase64(new Uint8Array(key))}`);

            this.currentRatchetRequest?.resolve({key, keyIndex: keyIndex!});
        }
    }
}
