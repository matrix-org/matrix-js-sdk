import { type MatrixClient } from "../client.ts";
import { logger as rootLogger } from "../logger.ts";
import { type MatrixEvent } from "../models/event.ts";
import { type Room } from "../models/room.ts";
import { type EncryptionConfig } from "./MatrixRTCSession.ts";
import { secureRandomBase64Url } from "../randomstring.ts";
import { type EncryptionKeysEventContent } from "./types.ts";
import { decodeBase64, encodeUnpaddedBase64 } from "../base64.ts";
import { type MatrixError, safeGetRetryAfterMs } from "../http-api/errors.ts";
import { type CallMembership } from "./CallMembership.ts";
import { EventType } from "../@types/event.ts";
const logger = rootLogger.getChild("MatrixRTCSession");

/**
 * A type collecting call encryption statistics for a session.
 */
export type Statistics = {
    counters: {
        /**
         * The number of times we have sent a room event containing encryption keys.
         */
        roomEventEncryptionKeysSent: number;
        /**
         * The number of times we have received a room event containing encryption keys.
         */
        roomEventEncryptionKeysReceived: number;
    };
    totals: {
        /**
         * The total age (in milliseconds) of all room events containing encryption keys that we have received.
         * We track the total age so that we can later calculate the average age of all keys received.
         */
        roomEventEncryptionKeysReceivedTotalAge: number;
    };
};

/**
 * This interface is for testing and for making it possible to interchange the encryption manager.
 * @internal
 */
export interface IEncryptionManager {
    join(joinConfig: EncryptionConfig | undefined): void;
    leave(): void;
    onMembershipsUpdate(oldMemberships: CallMembership[]): void;
    /**
     * Process `m.call.encryption_keys` events to track the encryption keys for call participants.
     * This should be called each time the relevant event is received from a room timeline.
     * If the event is malformed then it will be logged and ignored.
     *
     * @param event the event to process
     */
    onCallEncryptionEventReceived(event: MatrixEvent): void;
    getEncryptionKeys(): Map<string, Array<{ key: Uint8Array; timestamp: number }>>;
    statistics: Statistics;
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

    private currentEncryptionKeyIndex = -1;

    public statistics: Statistics = {
        counters: {
            roomEventEncryptionKeysSent: 0,
            roomEventEncryptionKeysReceived: 0,
        },
        totals: {
            roomEventEncryptionKeysReceivedTotalAge: 0,
        },
    };
    private joinConfig: EncryptionConfig | undefined;

    public constructor(
        private client: Pick<MatrixClient, "sendEvent" | "getDeviceId" | "getUserId" | "cancelPendingEvent">,
        private room: Pick<Room, "roomId">,
        private getMemberships: () => CallMembership[],
        private onEncryptionKeysChanged: (
            keyBin: Uint8Array<ArrayBufferLike>,
            encryptionKeyIndex: number,
            participantId: string,
        ) => void,
    ) {}

    public getEncryptionKeys(): Map<string, Array<{ key: Uint8Array; timestamp: number }>> {
        return this.encryptionKeys;
    }
    private joined = false;
    public join(joinConfig: EncryptionConfig): void {
        this.joinConfig = joinConfig;
        this.joined = true;
        this.manageMediaKeys = this.joinConfig?.manageMediaKeys ?? this.manageMediaKeys;
        if (this.joinConfig?.manageMediaKeys) {
            this.makeNewSenderKey();
            this.requestSendCurrentKey();
        }
    }

    public leave(): void {
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();

        if (!userId) throw new Error("No userId");
        if (!deviceId) throw new Error("No deviceId");
        // clear our encryption keys as we're done with them now (we'll
        // make new keys if we rejoin). We leave keys for other participants
        // as they may still be using the same ones.
        this.encryptionKeys.set(getParticipantId(userId, deviceId), []);

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
    // TODO deduplicate this method. It also is in MatrixRTCSession.
    private isMyMembership = (m: CallMembership): boolean =>
        m.sender === this.client.getUserId() && m.deviceId === this.client.getDeviceId();

    public onMembershipsUpdate(oldMemberships: CallMembership[]): void {
        if (this.manageMediaKeys && this.joined) {
            const oldMembershipIds = new Set(
                oldMemberships.filter((m) => !this.isMyMembership(m)).map(getParticipantIdFromMembership),
            );
            const newMembershipIds = new Set(
                this.getMemberships()
                    .filter((m) => !this.isMyMembership(m))
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
                    logger.debug(`Member(s) have left: queueing sender key rotation`);
                    this.makeNewKeyTimeout = setTimeout(this.onRotateKeyTimeout, this.makeKeyDelay);
                }
            } else if (anyJoined) {
                logger.debug(`New member(s) have joined: re-sending keys`);
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
                    logger.debug(`Member(s) have updated/reconnected: re-sending keys to everyone`);
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
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();

        if (!userId) throw new Error("No userId");
        if (!deviceId) throw new Error("No deviceId");

        const encryptionKey = secureRandomBase64Url(16);
        const encryptionKeyIndex = this.getNewEncryptionKeyIndex();
        logger.info("Generated new key at index " + encryptionKeyIndex);
        this.setEncryptionKey(userId, deviceId, encryptionKeyIndex, encryptionKey, Date.now(), delayBeforeUse);
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
            logger.info("Last encryption key event sent too recently: postponing");
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

        logger.info(`Sending encryption keys event. indexToSend=${indexToSend}`);

        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();

        if (!userId) throw new Error("No userId");
        if (!deviceId) throw new Error("No deviceId");

        const myKeys = this.getKeysForParticipant(userId, deviceId);

        if (!myKeys) {
            logger.warn("Tried to send encryption keys event but no keys found!");
            return;
        }

        if (typeof indexToSend !== "number" && this.currentEncryptionKeyIndex === -1) {
            logger.warn("Tried to send encryption keys event but no current key index found!");
            return;
        }

        const keyIndexToSend = indexToSend ?? this.currentEncryptionKeyIndex;
        const keyToSend = myKeys[keyIndexToSend];

        try {
            const content: EncryptionKeysEventContent = {
                keys: [
                    {
                        index: keyIndexToSend,
                        key: encodeUnpaddedBase64(keyToSend),
                    },
                ],
                device_id: deviceId,
                call_id: "",
                sent_ts: Date.now(),
            };

            this.statistics.counters.roomEventEncryptionKeysSent += 1;

            await this.client.sendEvent(this.room.roomId, EventType.CallEncryptionKeysPrefix, content);

            logger.debug(
                `Embedded-E2EE-LOG updateEncryptionKeyEvent participantId=${userId}:${deviceId} numKeys=${myKeys.length} currentKeyIndex=${this.currentEncryptionKeyIndex} keyIndexToSend=${keyIndexToSend}`,
                this.encryptionKeys,
            );
        } catch (error) {
            const matrixError = error as MatrixError;
            if (matrixError.event) {
                // cancel the pending event: we'll just generate a new one with our latest
                // keys when we resend
                this.client.cancelPendingEvent(matrixError.event);
            }
            if (this.keysEventUpdateTimeout === undefined) {
                const resendDelay = safeGetRetryAfterMs(matrixError, 5000);
                logger.warn(`Failed to send m.call.encryption_key, retrying in ${resendDelay}`, error);
                this.keysEventUpdateTimeout = setTimeout(() => void this.sendEncryptionKeysEvent(), resendDelay);
            } else {
                logger.info("Not scheduling key resend as another re-send is already pending");
            }
        }
    };

    public onCallEncryptionEventReceived = (event: MatrixEvent): void => {
        const userId = event.getSender();
        const content = event.getContent<EncryptionKeysEventContent>();

        const deviceId = content["device_id"];
        const callId = content["call_id"];

        if (!userId) {
            logger.warn(`Received m.call.encryption_keys with no userId: callId=${callId}`);
            return;
        }

        // We currently only handle callId = "" (which is the default for room scoped calls)
        if (callId !== "") {
            logger.warn(
                `Received m.call.encryption_keys with unsupported callId: userId=${userId}, deviceId=${deviceId}, callId=${callId}`,
            );
            return;
        }

        if (!Array.isArray(content.keys)) {
            logger.warn(`Received m.call.encryption_keys where keys wasn't an array: callId=${callId}`);
            return;
        }

        if (userId === this.client.getUserId() && deviceId === this.client.getDeviceId()) {
            // We store our own sender key in the same set along with keys from others, so it's
            // important we don't allow our own keys to be set by one of these events (apart from
            // the fact that we don't need it anyway because we already know our own keys).
            logger.info("Ignoring our own keys event");
            return;
        }

        this.statistics.counters.roomEventEncryptionKeysReceived += 1;
        const age = Date.now() - (typeof content.sent_ts === "number" ? content.sent_ts : event.getTs());
        this.statistics.totals.roomEventEncryptionKeysReceivedTotalAge += age;

        for (const key of content.keys) {
            if (!key) {
                logger.info("Ignoring false-y key in keys event");
                continue;
            }

            const encryptionKey = key.key;
            const encryptionKeyIndex = key.index;

            if (
                !encryptionKey ||
                encryptionKeyIndex === undefined ||
                encryptionKeyIndex === null ||
                callId === undefined ||
                callId === null ||
                typeof deviceId !== "string" ||
                typeof callId !== "string" ||
                typeof encryptionKey !== "string" ||
                typeof encryptionKeyIndex !== "number"
            ) {
                logger.warn(
                    `Malformed call encryption_key: userId=${userId}, deviceId=${deviceId}, encryptionKeyIndex=${encryptionKeyIndex} callId=${callId}`,
                );
            } else {
                logger.debug(
                    `Embedded-E2EE-LOG onCallEncryption userId=${userId}:${deviceId} encryptionKeyIndex=${encryptionKeyIndex} age=${age}ms`,
                    this.encryptionKeys,
                );
                this.setEncryptionKey(userId, deviceId, encryptionKeyIndex, encryptionKey, event.getTs());
            }
        }
    };
    private storeLastMembershipFingerprints(): void {
        this.lastMembershipFingerprints = new Set(
            this.getMemberships()
                .filter((m) => !this.isMyMembership(m))
                .map((m) => `${getParticipantIdFromMembership(m)}:${m.createdTs()}`),
        );
    }

    private getNewEncryptionKeyIndex(): number {
        if (this.currentEncryptionKeyIndex === -1) {
            return 0;
        }

        // maximum key index is 255
        return (this.currentEncryptionKeyIndex + 1) % 256;
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
        const keyBin = decodeBase64(encryptionKeyString);

        const participantId = getParticipantId(userId, deviceId);
        if (!this.encryptionKeys.has(participantId)) {
            this.encryptionKeys.set(participantId, []);
        }
        const participantKeys = this.encryptionKeys.get(participantId)!;

        const existingKeyAtIndex = participantKeys[encryptionKeyIndex];

        if (existingKeyAtIndex) {
            if (existingKeyAtIndex.timestamp > timestamp) {
                logger.info(
                    `Ignoring new key at index ${encryptionKeyIndex} for ${participantId} as it is older than existing known key`,
                );
                return;
            }

            if (keysEqual(existingKeyAtIndex.key, keyBin)) {
                existingKeyAtIndex.timestamp = timestamp;
                return;
            }
        }

        participantKeys[encryptionKeyIndex] = {
            key: keyBin,
            timestamp,
        };

        if (delayBeforeUse) {
            const useKeyTimeout = setTimeout(() => {
                this.setNewKeyTimeouts.delete(useKeyTimeout);
                logger.info(`Delayed-emitting key changed event for ${participantId} idx ${encryptionKeyIndex}`);
                if (userId === this.client.getUserId() && deviceId === this.client.getDeviceId()) {
                    this.currentEncryptionKeyIndex = encryptionKeyIndex;
                }
                this.onEncryptionKeysChanged(keyBin, encryptionKeyIndex, participantId);
            }, this.useKeyDelay);
            this.setNewKeyTimeouts.add(useKeyTimeout);
        } else {
            if (userId === this.client.getUserId() && deviceId === this.client.getDeviceId()) {
                this.currentEncryptionKeyIndex = encryptionKeyIndex;
            }
            this.onEncryptionKeysChanged(keyBin, encryptionKeyIndex, participantId);
        }
    }

    private onRotateKeyTimeout = (): void => {
        if (!this.manageMediaKeys) return;

        this.makeNewKeyTimeout = undefined;
        logger.info("Making new sender key for key rotation");
        const newKeyIndex = this.makeNewSenderKey(true);
        // send immediately: if we're about to start sending with a new key, it's
        // important we get it out to others as soon as we can.
        void this.sendEncryptionKeysEvent(newKeyIndex);
    };
}

const getParticipantId = (userId: string, deviceId: string): string => `${userId}:${deviceId}`;
function keysEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (a === b) return true;
    return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}
const getParticipantIdFromMembership = (m: CallMembership): string => getParticipantId(m.sender!, m.deviceId);
