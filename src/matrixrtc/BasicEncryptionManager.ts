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

import {IEncryptionManager, Statistics} from "./EncryptionManager.ts";
import {EncryptionConfig} from "./MatrixRTCSession.ts";

import {CallMembership} from "./CallMembership.ts";
import {decodeBase64, encodeBase64} from "../base64.ts";
import { type KeyTransportEventListener, KeyTransportEvents} from "./IKeyTransport.ts";
import {Logger, logger} from "../logger.ts";
import { defer } from "../utils.ts";
import { ToDeviceKeyTransport } from "./ToDeviceKeyTransport.ts";


type DeviceInfo = {
    userId: string,
    deviceId: string,
}

type OutboundEncryptionSession = {
    key: Uint8Array,
    creationTS: number,
    sharedWith: Array<DeviceInfo>,
    // This is an index acting as the id of the key
    keyId: number,
    dirty: boolean
}

type InboundEncryptionSession = {
    key: Uint8Array,
    participantId: string,
    keyId: number,
    creationTS: number,
}

export type ParticipantId = string

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

    // The store that holds all the keys for the other participants.
    // It is possible that we have multiple keys for a candidate as usually after a rotation the new key is
    // distributed prior to being used to give all recipient to get the key first/.
    // TODO replace the inner Record with a circular buffer
    private keyStore: Map<ParticipantId, Array<InboundEncryptionSession>> = new Map();

    private logger: Logger;

    public constructor(
        private userId: string,
        private deviceId: string,
        private getMemberships: () => CallMembership[],
        private transport: ToDeviceKeyTransport,
        private onEncryptionKeysChanged: (
            keyBin: Uint8Array<ArrayBufferLike>,
            encryptionKeyIndex: number,
            participantId: ParticipantId,
        ) => void,
    ) {
        this.logger = logger.getChild("BasicEncryptionManager");
    }

    statistics: Statistics;

    getEncryptionKeys(): Map<string, Array<{ key: Uint8Array; timestamp: number }>> {
        // TODO what is this timestamp and why?
        // Do that more efficiently
        const map = new Map<ParticipantId, Array<{ key: Uint8Array; timestamp: number }>>();
        this.keyStore.forEach((values, participantId) => {
            map.set(
                participantId,
                values.map( inbound => {
                    return { key: inbound.key, timestamp: inbound.creationTS }
                    })
            )
        })
        return map
    }

    // TODO would be nice to make this async
    join(joinConfig: EncryptionConfig | undefined): void {
        this.logger.info(`Joining room ${joinConfig}`)
        this.transport.on(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.start();

        this.ensureMediaKey();
    }


    /**
     * Will ensure that a new key is distributed and used to encrypt our media.
     * If this function is called repeatidly, the calls will be buffered to a single key rotation.
     */
    private ensureMediaKey(): void {

        this.logger.info(`ensureMediaKey... `)
        if (this.currentKeyDistributionPromise == null) {
            this.logger.info(`No rollout, start a new one`)
            // start a rollout
            this.currentKeyDistributionPromise = this.rolloutOutboundKey().then(() => {
                this.logger.info(`Rollout completed`)
                this.currentKeyDistributionPromise = null
                if (this.outboundSession?.dirty) {
                    this.logger.info(`New Rollout needed`)
                    // rollout a new one 
                    this.ensureMediaKey();
                }
            });

        } else {
            // There is a rollout in progress, but membership has changed and a new rollout is needed.
            // Mark this key as dirty so that a new one is rolled out immediatly after the current one
            this.logger.info(`Rollout in progress, mark outbound as dirty`)
            this.outboundSession!.dirty = true
        }
    }

    leave(): void {
        // Drop key material
        this.keyStore.clear();
        this.transport.off(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.stop();
    }


    public onNewKeyReceived: KeyTransportEventListener = (userId, deviceId, keyBase64Encoded, index, timestamp) => {
        this.logger.info(`Received key over transport ${userId}:${deviceId} at index ${index}`);

        // We have a new key notify the video layer of this new key so that it can decrypt the frames properly.
        // We also store a copy of the key in the key store as we might need to re-emit them to the decoding layer.
        const participantId = getParticipantId(userId, deviceId);
        const keyBin = decodeBase64(keyBase64Encoded);
        const newKey: InboundEncryptionSession = {
            key: keyBin,
            participantId,
            keyId: index,
            creationTS: timestamp,
        }

        const existingKey = this.keyStore.get(participantId)?.[index];
        if (existingKey) {
            // We already have key for that index.
            // This can happen in some edge cases:
            // Like if the participant joined then left and rejoined. In that case he would have distributed
            // two keys of index 0 (just after the joins). And as there is no guarantee for order of to device messages
            // just keep the last one.
            if (timestamp > existingKey.creationTS) {
                // We have a new key, update it
                this.keyStore.get(participantId)![index] = newKey
            } else {
                // this key is outdated, ignore it
                return
            }
        }

        this.onEncryptionKeysChanged(keyBin, index, participantId);
    };

    onMembershipsUpdate(oldMemberships: CallMembership[]): void {
        this.logger.info(`onMembershipsUpdate`);

        // This encryption manager is very basic, it will rotate the key for any membership change
        // Request rotation of the key
        this.ensureMediaKey();
    }


    private async rolloutOutboundKey(): Promise<void> {

        const hasExistingKey = this.outboundSession != null;

        // Create a new key
        const newOutboundKey : OutboundEncryptionSession=  {
            key: this.generateRandomKey(),
            creationTS: Date.now(),
            sharedWith: [],
            keyId: this.nextKeyId(),
            dirty: false
        };

        this.logger.info(`creating new key index:${newOutboundKey.keyId} key:${encodeBase64(newOutboundKey.key)}`);
        // Set this new key has the current one
        this.outboundSession = newOutboundKey;
        const toShareWith = this.getMemberships();

        try {
            this.logger.info(`Sending key...`);
            await this.transport.sendKey(encodeBase64(newOutboundKey.key), newOutboundKey.keyId, toShareWith);
            newOutboundKey.sharedWith = toShareWith.map(ms => {
                return {
                    userId: ms.sender ?? "",
                    deviceId: ms.deviceId ?? ""
                }
            })
            this.logger.info(`key index:${newOutboundKey.keyId} sent to ${newOutboundKey.sharedWith}`);
            if (!hasExistingKey) {
                this.logger.info(`Rollout immediatly`);
                // rollout imediatly
                this.onEncryptionKeysChanged(newOutboundKey.key, newOutboundKey.keyId, getParticipantId(this.userId, this.deviceId))
            } else {
                // Delay a bit using this key
                const rolledOut = defer<void>()
                this.logger.info(`Delay Rollout...`);
                setTimeout(() => {
                    this.logger.info(`...Delayed rollout of index:${newOutboundKey.keyId} `);
                    // Start encrypting with that key now that there was time to distibute it
                    this.onEncryptionKeysChanged(newOutboundKey.key, newOutboundKey.keyId, getParticipantId(this.userId, this.deviceId))
                    rolledOut.resolve()
                }, 1000)
                return rolledOut.promise
            }
 
        } catch (err) {
            this.logger.error(`Failed to rollout key`, err);
        }

    }

    private nextKeyId(): number {
        if (this.outboundSession) {
            return (this.outboundSession!.keyId + 1) % 256
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
