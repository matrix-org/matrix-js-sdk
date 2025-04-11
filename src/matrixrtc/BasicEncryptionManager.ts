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
import { type KeyTransportEventListener, KeyTransportEvents } from "./IKeyTransport.ts";
import { type Logger, logger } from "../logger.ts";
import { defer } from "../utils.ts";
import { type ToDeviceKeyTransport } from "./ToDeviceKeyTransport.ts";
import { type InboundEncryptionSession, type ParticipantId, type Statistics } from "./types.ts";
import { KeyBuffer } from "./utils.ts";

type DeviceInfo = {
    userId: string;
    deviceId: string;
};

type OutboundEncryptionSession = {
    key: Uint8Array;
    creationTS: number;
    sharedWith: Array<DeviceInfo>;
    // This is an index acting as the id of the key
    keyId: number;
};

/**
 * A simple encryption manager.
 * This manager is basic becasue it will rotate the keys for any membership change.
 * There is no ratchetting, or time based rotation.
 * It works with to-device transport.
 */
export class BasicEncryptionManager implements IEncryptionManager {
    // The current per-sender media key for this device
    private outboundSession: OutboundEncryptionSession | null = null;

    /**
     * Ensures that there is only one distribute operation at a time for that call.
     */
    private currentKeyDistributionPromise: Promise<void> | null = null;

    /**
     * There is a possibility that keys arrive in wrong order.
     * For example after a quick join/leave/join, there will be 2 keys of index 0 distributed and
     * it they are received in wrong order the stream won't be decryptable.
     * For that reason we keep a small buffer of keys for a limited time to disambiguate.
     * @private
     */
    private keyBuffer = new KeyBuffer(1000 /** 1 second */);

    private logger: Logger;

    private needToRotateAgain = false;

    public constructor(
        private userId: string,
        private deviceId: string,
        private getMemberships: () => CallMembership[],
        private transport: ToDeviceKeyTransport,
        private statistics: Statistics,
        private onEncryptionKeysChanged: (
            keyBin: Uint8Array<ArrayBufferLike>,
            encryptionKeyIndex: number,
            participantId: ParticipantId,
        ) => void,
    ) {
        this.logger = logger.getChild("BasicEncryptionManager");
    }

    public getEncryptionKeys(): Map<string, Array<{ key: Uint8Array; timestamp: number }>> {
        // This is deprecated should be ignored. Only use by tests?
        return new Map();
    }

    public join(joinConfig: EncryptionConfig | undefined): void {
        this.logger.info(`Joining room`);
        this.transport.on(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.start();

        this.ensureMediaKey();
    }

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
                if (this.needToRotateAgain) {
                    this.logger.debug(`New Rollout needed`);
                    // rollout a new one
                    this.ensureMediaKey();
                }
            });
        } else {
            // There is a rollout in progress, but membership has changed and a new rollout is needed.
            // Remember that a new rotation in needed after the current one.
            this.logger.debug(`Rollout in progress, a new rollout will be started after the current one`);
            this.needToRotateAgain = true;
        }
    }

    public leave(): void {
        this.keyBuffer.clear();
        this.transport.off(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.stop();
    }

    public onNewKeyReceived: KeyTransportEventListener = (userId, deviceId, keyBase64Encoded, index, timestamp) => {
        this.logger.debug(`Received key over transport ${userId}:${deviceId} at index ${index}`);

        // We have a new key notify the video layer of this new key so that it can decrypt the frames properly.
        // We also store a copy of the key in the key store as we might need to re-emit them to the decoding layer.
        const participantId = getParticipantId(userId, deviceId);
        const keyBin = decodeBase64(keyBase64Encoded);
        const newKey: InboundEncryptionSession = {
            key: keyBin,
            participantId,
            keyId: index,
            creationTS: timestamp,
        };

        const validKey = this.keyBuffer.disambiguate(participantId, newKey);
        if (validKey) {
            this.onEncryptionKeysChanged(validKey.key, index, validKey.participantId);
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

        // This encryption manager is very basic, it will rotate the key for any membership change
        // Request rotation of the key
        this.ensureMediaKey();
    }

    private async rolloutOutboundKey(): Promise<void> {
        const hasExistingKey = this.outboundSession != null;

        // Create a new key
        const newOutboundKey: OutboundEncryptionSession = {
            key: this.generateRandomKey(),
            creationTS: Date.now(),
            sharedWith: [],
            keyId: this.nextKeyId(),
        };

        this.logger.info(`creating new outbound key index:${newOutboundKey.keyId}`);
        // Set this new key has the current one
        this.outboundSession = newOutboundKey;
        this.needToRotateAgain = false;
        const toShareWith = this.getMemberships();

        try {
            this.logger.trace(`Sending key...`);
            await this.transport.sendKey(encodeBase64(newOutboundKey.key), newOutboundKey.keyId, toShareWith);
            this.statistics.counters.roomEventEncryptionKeysSent += 1;
            newOutboundKey.sharedWith = toShareWith.map((ms) => {
                return {
                    userId: ms.sender ?? "",
                    deviceId: ms.deviceId ?? "",
                };
            });
            this.logger.trace(
                `key index:${newOutboundKey.keyId} sent to ${newOutboundKey.sharedWith.map((m) => `${m.userId}:${m.deviceId}`).join(",")}`,
            );
            if (!hasExistingKey) {
                this.logger.trace(`Rollout immediately`);
                // rollout immediately
                this.onEncryptionKeysChanged(
                    newOutboundKey.key,
                    newOutboundKey.keyId,
                    getParticipantId(this.userId, this.deviceId),
                );
            } else {
                // Delay a bit using this key
                const rolledOut = defer<void>();
                this.logger.trace(`Delay Rollout...`);
                setTimeout(() => {
                    this.logger.trace(`...Delayed rollout of index:${newOutboundKey.keyId} `);
                    // Start encrypting with that key now that there was time to distibute it
                    this.onEncryptionKeysChanged(
                        newOutboundKey.key,
                        newOutboundKey.keyId,
                        getParticipantId(this.userId, this.deviceId),
                    );
                    rolledOut.resolve();
                }, 1000);
                return rolledOut.promise;
            }
        } catch (err) {
            this.logger.error(`Failed to rollout key`, err);
        }
    }

    private nextKeyId(): number {
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
}

const getParticipantId = (userId: string, deviceId: string): ParticipantId => `${userId}:${deviceId}`;
