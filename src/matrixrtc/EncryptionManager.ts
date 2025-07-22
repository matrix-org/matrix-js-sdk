import { type Logger, logger as rootLogger } from "../logger.ts";
import { type EncryptionConfig } from "./MatrixRTCSession.ts";
import { secureRandomBase64Url } from "../randomstring.ts";
import { decodeBase64, encodeUnpaddedBase64 } from "../base64.ts";
import { safeGetRetryAfterMs } from "../http-api/errors.ts";
import { type CallMembership } from "./CallMembership.ts";
import { type KeyTransportEventListener, KeyTransportEvents, type IKeyTransport } from "./IKeyTransport.ts";
import { isMyMembership, type ParticipantId, type Statistics } from "./types.ts";
import { getParticipantId } from "./utils.ts";

/**
 * This interface is for testing and for making it possible to interchange the encryption manager.
 * @internal
 */
export interface IEncryptionManager {
    /**
     * Joins the encryption manager with the provided configuration.
     *
     * @param joinConfig - The configuration for joining encryption, or undefined
     * if no specific configuration is provided.
     */
    join(joinConfig: EncryptionConfig | undefined): void;

    /**
     * Leaves the encryption manager, cleaning up any associated resources.
     */
    leave(): void;

    /**
     * Called from the MatrixRTCSession when the memberships in this session updated.
     *
     * @param oldMemberships - The previous state of call memberships before the update.
     */
    onMembershipsUpdate(oldMemberships: CallMembership[]): void;

    /**
     * Retrieves the encryption keys currently managed by the encryption manager.
     *
     * @returns A map of participant IDs to their encryption keys.
     */
    getEncryptionKeys(): ReadonlyMap<ParticipantId, ReadonlyArray<{ key: Uint8Array; keyIndex: number }>>;
}

/**
 * This class implements the IEncryptionManager interface,
 * and takes care of managing the encryption keys of all rtc members:
 *  - generate new keys for the local user and send them to other participants
 *  - track all keys of all other members and update livekit.
 *
 * @internal
 */
export class EncryptionManager implements IEncryptionManager {
    private manageMediaKeys = false;
    private keysEventUpdateTimeout?: ReturnType<typeof setTimeout>;
    private makeNewKeyTimeout?: ReturnType<typeof setTimeout>;
    private setNewKeyTimeouts = new Set<ReturnType<typeof setTimeout>>();

    private get updateEncryptionKeyThrottle(): number {
        return this.joinConfig?.updateEncryptionKeyThrottle ?? 3_000;
    }

    private get makeKeyDelay(): number {
        return this.joinConfig?.makeKeyDelay ?? 3_000;
    }

    private get useKeyDelay(): number {
        return this.joinConfig?.useKeyDelay ?? 5_000;
    }

    private encryptionKeys = new Map<string, Array<{ key: Uint8Array; timestamp: number }>>();
    private lastEncryptionKeyUpdateRequest?: number;

    // We use this to store the last membership fingerprints we saw, so we can proactively re-send encryption keys
    // if it looks like a membership has been updated.
    private lastMembershipFingerprints: Set<string> | undefined;

    private latestGeneratedKeyIndex = -1;
    private joinConfig: EncryptionConfig | undefined;
    private logger: Logger;

    public constructor(
        private userId: string,
        private deviceId: string,
        private getMemberships: () => CallMembership[],
        private transport: IKeyTransport,
        private statistics: Statistics,
        private onEncryptionKeysChanged: (
            keyBin: Uint8Array,
            encryptionKeyIndex: number,
            participantId: string,
        ) => void,
        parentLogger?: Logger,
    ) {
        this.logger = (parentLogger ?? rootLogger).getChild(`[EncryptionManager]`);
    }

    public getEncryptionKeys(): ReadonlyMap<ParticipantId, ReadonlyArray<{ key: Uint8Array; keyIndex: number }>> {
        const keysMap = new Map<ParticipantId, ReadonlyArray<{ key: Uint8Array; keyIndex: number }>>();
        for (const [userId, userKeys] of this.encryptionKeys) {
            const keys = userKeys.map((entry, index) => ({
                key: entry.key,
                keyIndex: index,
            }));
            keysMap.set(userId as ParticipantId, keys);
        }
        return keysMap;
    }

    private joined = false;

    public join(joinConfig: EncryptionConfig): void {
        this.joinConfig = joinConfig;
        this.joined = true;
        this.manageMediaKeys = this.joinConfig?.manageMediaKeys ?? this.manageMediaKeys;

        this.transport.on(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);

        this.transport.start();
        if (this.joinConfig?.manageMediaKeys) {
            this.makeNewSenderKey();
            this.requestSendCurrentKey();
        }
    }

    public leave(): void {
        // clear our encryption keys as we're done with them now (we'll
        // make new keys if we rejoin). We leave keys for other participants
        // as they may still be using the same ones.
        this.encryptionKeys.set(getParticipantId(this.userId, this.deviceId), []);
        this.transport.off(KeyTransportEvents.ReceivedKeys, this.onNewKeyReceived);
        this.transport.stop();

        if (this.makeNewKeyTimeout !== undefined) {
            clearTimeout(this.makeNewKeyTimeout);
            this.makeNewKeyTimeout = undefined;
        }
        for (const t of this.setNewKeyTimeouts) {
            clearTimeout(t);
        }
        this.setNewKeyTimeouts.clear();

        this.manageMediaKeys = false;
        this.joined = false;
    }

    public onMembershipsUpdate(oldMemberships: CallMembership[]): void {
        if (this.manageMediaKeys && this.joined) {
            const oldMembershipIds = new Set(
                oldMemberships
                    .filter((m) => !isMyMembership(m, this.userId, this.deviceId))
                    .map(getParticipantIdFromMembership),
            );
            const newMembershipIds = new Set(
                this.getMemberships()
                    .filter((m) => !isMyMembership(m, this.userId, this.deviceId))
                    .map(getParticipantIdFromMembership),
            );

            // We can use https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set/symmetricDifference
            // for this once available
            const anyLeft = Array.from(oldMembershipIds).some((x) => !newMembershipIds.has(x));
            const anyJoined = Array.from(newMembershipIds).some((x) => !oldMembershipIds.has(x));

            const oldFingerprints = this.lastMembershipFingerprints;
            // always store the fingerprints of these latest memberships
            this.storeLastMembershipFingerprints();

            if (anyLeft) {
                if (this.makeNewKeyTimeout) {
                    // existing rotation in progress, so let it complete
                } else {
                    this.logger.debug(`Member(s) have left: queueing sender key rotation`);
                    this.makeNewKeyTimeout = setTimeout(this.onRotateKeyTimeout, this.makeKeyDelay);
                }
            } else if (anyJoined) {
                this.logger.debug(`New member(s) have joined: re-sending keys`);
                this.requestSendCurrentKey();
            } else if (oldFingerprints) {
                // does it look like any of the members have updated their memberships?
                const newFingerprints = this.lastMembershipFingerprints!;

                // We can use https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set/symmetricDifference
                // for this once available
                const candidateUpdates =
                    Array.from(oldFingerprints).some((x) => !newFingerprints.has(x)) ||
                    Array.from(newFingerprints).some((x) => !oldFingerprints.has(x));
                if (candidateUpdates) {
                    this.logger.debug(`Member(s) have updated/reconnected: re-sending keys to everyone`);
                    this.requestSendCurrentKey();
                }
            }
        }
    }

    /**
     * Generate a new sender key and add it at the next available index
     * @param delayBeforeUse - If true, wait for a short period before setting the key for the
     *                         media encryptor to use. If false, set the key immediately.
     * @returns The index of the new key
     */
    private makeNewSenderKey(delayBeforeUse = false): number {
        const encryptionKey = secureRandomBase64Url(16);
        const encryptionKeyIndex = this.getNewEncryptionKeyIndex();
        this.logger.info("Generated new key at index " + encryptionKeyIndex);
        this.setEncryptionKey(
            this.userId,
            this.deviceId,
            encryptionKeyIndex,
            encryptionKey,
            Date.now(),
            delayBeforeUse,
        );
        return encryptionKeyIndex;
    }

    /**
     * Requests that we resend our current keys to the room. May send a keys event immediately
     * or queue for alter if one has already been sent recently.
     */
    private requestSendCurrentKey(): void {
        if (!this.manageMediaKeys) return;

        if (
            this.lastEncryptionKeyUpdateRequest &&
            this.lastEncryptionKeyUpdateRequest + this.updateEncryptionKeyThrottle > Date.now()
        ) {
            this.logger.info("Last encryption key event sent too recently: postponing");
            if (this.keysEventUpdateTimeout === undefined) {
                this.keysEventUpdateTimeout = setTimeout(
                    () => void this.sendEncryptionKeysEvent(),
                    this.updateEncryptionKeyThrottle,
                );
            }
            return;
        }

        void this.sendEncryptionKeysEvent();
    }

    /**
     * Get the known encryption keys for a given participant device.
     *
     * @param userId the user ID of the participant
     * @param deviceId the device ID of the participant
     * @returns The encryption keys for the given participant, or undefined if they are not known.
     */
    private getKeysForParticipant(userId: string, deviceId: string): Array<Uint8Array> | undefined {
        return this.encryptionKeys.get(getParticipantId(userId, deviceId))?.map((entry) => entry.key);
    }

    /**
     * Re-sends the encryption keys room event
     */
    private sendEncryptionKeysEvent = async (indexToSend?: number): Promise<void> => {
        if (this.keysEventUpdateTimeout !== undefined) {
            clearTimeout(this.keysEventUpdateTimeout);
            this.keysEventUpdateTimeout = undefined;
        }
        this.lastEncryptionKeyUpdateRequest = Date.now();

        if (!this.joined) return;

        const myKeys = this.getKeysForParticipant(this.userId, this.deviceId);

        if (!myKeys) {
            this.logger.warn("Tried to send encryption keys event but no keys found!");
            return;
        }

        if (typeof indexToSend !== "number" && this.latestGeneratedKeyIndex === -1) {
            this.logger.warn("Tried to send encryption keys event but no current key index found!");
            return;
        }

        const keyIndexToSend = indexToSend ?? this.latestGeneratedKeyIndex;

        this.logger.info(
            `Try sending encryption keys event. keyIndexToSend=${keyIndexToSend} (method parameter: ${indexToSend})`,
        );
        const keyToSend = myKeys[keyIndexToSend];

        try {
            this.statistics.counters.roomEventEncryptionKeysSent += 1;
            const targets = this.getMemberships()
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
            await this.transport.sendKey(encodeUnpaddedBase64(keyToSend), keyIndexToSend, targets);
            this.logger.debug(
                `sendEncryptionKeysEvent participantId=${this.userId}:${this.deviceId} numKeys=${myKeys.length} currentKeyIndex=${this.latestGeneratedKeyIndex} keyIndexToSend=${keyIndexToSend}`,
            );
        } catch (error) {
            if (this.keysEventUpdateTimeout === undefined) {
                const resendDelay = safeGetRetryAfterMs(error, 5000);
                this.logger.warn(`Failed to send m.call.encryption_key, retrying in ${resendDelay}`, error);
                this.keysEventUpdateTimeout = setTimeout(() => void this.sendEncryptionKeysEvent(), resendDelay);
            } else {
                this.logger.info("Not scheduling key resend as another re-send is already pending");
            }
        }
    };

    public onNewKeyReceived: KeyTransportEventListener = (userId, deviceId, keyBase64Encoded, index, timestamp) => {
        this.logger.debug(`Received key over key transport ${userId}:${deviceId} at index ${index}`);
        this.setEncryptionKey(userId, deviceId, index, keyBase64Encoded, timestamp);
    };

    private storeLastMembershipFingerprints(): void {
        this.lastMembershipFingerprints = new Set(
            this.getMemberships()
                .filter((m) => !isMyMembership(m, this.userId, this.deviceId))
                .map((m) => `${getParticipantIdFromMembership(m)}:${m.createdTs()}`),
        );
    }

    private getNewEncryptionKeyIndex(): number {
        if (this.latestGeneratedKeyIndex === -1) {
            return 0;
        }

        // maximum key index is 255
        return (this.latestGeneratedKeyIndex + 1) % 256;
    }

    /**
     * Sets an encryption key at a specified index for a participant.
     * The encryption keys for the local participant are also stored here under the
     * user and device ID of the local participant.
     * If the key is older than the existing key at the index, it will be ignored.
     * @param userId - The user ID of the participant
     * @param deviceId - Device ID of the participant
     * @param encryptionKeyIndex - The index of the key to set
     * @param encryptionKeyString - The string representation of the key to set in base64
     * @param timestamp - The timestamp of the key. We assume that these are monotonic for each participant device.
     * @param delayBeforeUse - If true, delay before emitting a key changed event. Useful when setting
     *                         encryption keys for the local participant to allow time for the key to
     *                         be distributed.
     */
    private setEncryptionKey(
        userId: string,
        deviceId: string,
        encryptionKeyIndex: number,
        encryptionKeyString: string,
        timestamp: number,
        delayBeforeUse = false,
    ): void {
        this.logger.debug(`Setting encryption key for ${userId}:${deviceId} at index ${encryptionKeyIndex}`);
        const keyBin = decodeBase64(encryptionKeyString);

        const participantId = getParticipantId(userId, deviceId);
        if (!this.encryptionKeys.has(participantId)) {
            this.encryptionKeys.set(participantId, []);
        }
        const participantKeys = this.encryptionKeys.get(participantId)!;

        const existingKeyAtIndex = participantKeys[encryptionKeyIndex];

        if (existingKeyAtIndex) {
            if (existingKeyAtIndex.timestamp > timestamp) {
                this.logger.info(
                    `Ignoring new key at index ${encryptionKeyIndex} for ${participantId} as it is older than existing known key`,
                );
                return;
            }

            if (keysEqual(existingKeyAtIndex.key, keyBin)) {
                existingKeyAtIndex.timestamp = timestamp;
                return;
            }
        }

        if (userId === this.userId && deviceId === this.deviceId) {
            // It is important to already update the latestGeneratedKeyIndex here
            // NOT IN THE `delayBeforeUse` `setTimeout`.
            // Even though this is where we call onEncryptionKeysChanged and set the key in EC (and livekit).
            // It needs to happen here because we will send the key before the timeout has passed and sending
            // the key will use latestGeneratedKeyIndex as the index. if we update it in the `setTimeout` callback
            // it will use the wrong index (index - 1)!
            this.latestGeneratedKeyIndex = encryptionKeyIndex;
        }
        participantKeys[encryptionKeyIndex] = {
            key: keyBin,
            timestamp,
        };

        if (delayBeforeUse) {
            const useKeyTimeout = setTimeout(() => {
                this.setNewKeyTimeouts.delete(useKeyTimeout);
                this.logger.info(`Delayed-emitting key changed event for ${participantId} index ${encryptionKeyIndex}`);

                this.onEncryptionKeysChanged(keyBin, encryptionKeyIndex, participantId);
            }, this.useKeyDelay);
            this.setNewKeyTimeouts.add(useKeyTimeout);
        } else {
            this.onEncryptionKeysChanged(keyBin, encryptionKeyIndex, participantId);
        }
    }

    private onRotateKeyTimeout = (): void => {
        if (!this.manageMediaKeys) return;

        this.makeNewKeyTimeout = undefined;
        this.logger.info("Making new sender key for key rotation");
        const newKeyIndex = this.makeNewSenderKey(true);
        // send immediately: if we're about to start sending with a new key, it's
        // important we get it out to others as soon as we can.
        void this.sendEncryptionKeysEvent(newKeyIndex);
    };
}

function keysEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (a === b) return true;
    return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

const getParticipantIdFromMembership = (m: CallMembership): string => getParticipantId(m.sender!, m.deviceId);
