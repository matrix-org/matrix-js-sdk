/*
Copyright 2023 - 2024 The Matrix.org Foundation C.I.C.

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

import { logger as rootLogger } from "../logger.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { EventTimeline } from "../models/event-timeline.ts";
import { Room } from "../models/room.ts";
import { MatrixClient } from "../client.ts";
import { EventType } from "../@types/event.ts";
import { UpdateDelayedEventAction } from "../@types/requests.ts";
import {
    CallMembership,
    CallMembershipData,
    CallMembershipDataLegacy,
    SessionMembershipData,
    isLegacyCallMembershipData,
} from "./CallMembership.ts";
import { RoomStateEvent } from "../models/room-state.ts";
import { Focus } from "./focus.ts";
import { randomString, secureRandomBase64Url } from "../randomstring.ts";
import { EncryptionKeysEventContent } from "./types.ts";
import { decodeBase64, encodeUnpaddedBase64 } from "../base64.ts";
import { KnownMembership } from "../@types/membership.ts";
import { HTTPError, MatrixError, safeGetRetryAfterMs } from "../http-api/errors.ts";
import { MatrixEvent } from "../models/event.ts";
import { isLivekitFocusActive } from "./LivekitFocus.ts";
import { ExperimentalGroupCallRoomMemberState } from "../webrtc/groupCall.ts";
import { sleep } from "../utils.ts";

const logger = rootLogger.getChild("MatrixRTCSession");

const getParticipantId = (userId: string, deviceId: string): string => `${userId}:${deviceId}`;
const getParticipantIdFromMembership = (m: CallMembership): string => getParticipantId(m.sender!, m.deviceId);

function keysEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (a === b) return true;
    return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

export enum MatrixRTCSessionEvent {
    // A member joined, left, or updated a property of their membership.
    MembershipsChanged = "memberships_changed",
    // We joined or left the session: our own local idea of whether we are joined,
    // separate from MembershipsChanged, ie. independent of whether our member event
    // has successfully gone through.
    JoinStateChanged = "join_state_changed",
    // The key used to encrypt media has changed
    EncryptionKeyChanged = "encryption_key_changed",
}

export type MatrixRTCSessionEventHandlerMap = {
    [MatrixRTCSessionEvent.MembershipsChanged]: (
        oldMemberships: CallMembership[],
        newMemberships: CallMembership[],
    ) => void;
    [MatrixRTCSessionEvent.JoinStateChanged]: (isJoined: boolean) => void;
    [MatrixRTCSessionEvent.EncryptionKeyChanged]: (
        key: Uint8Array,
        encryptionKeyIndex: number,
        participantId: string,
    ) => void;
};

export interface JoinSessionConfig {
    /**
     *  If true, generate and share a media key for this participant,
     *  and emit MatrixRTCSessionEvent.EncryptionKeyChanged when
     *  media keys for other participants become available.
     */
    manageMediaKeys?: boolean;

    /** Lets you configure how the events for the session are formatted.
     *   - legacy: use one event with a membership array.
     *   - MSC4143: use one event per membership (with only one membership per event)
     * More details can be found in MSC4143 and by checking the types:
     * `CallMembershipDataLegacy` and `SessionMembershipData`
     */
    useLegacyMemberEvents?: boolean;

    /**
     * The timeout (in milliseconds) after we joined the call, that our membership should expire
     * unless we have explicitly updated it.
     */
    membershipExpiryTimeout?: number;

    /**
     * The period (in milliseconds) with which we check that our membership event still exists on the
     * server. If it is not found we create it again.
     */
    memberEventCheckPeriod?: number;

    /**
     * The minimum delay (in milliseconds) after which we will retry sending the membership event if it
     * failed to send.
     */
    callMemberEventRetryDelayMinimum?: number;

    /**
     * The jitter (in milliseconds) which is added to callMemberEventRetryDelayMinimum before retrying
     * sending the membership event. e.g. if this is set to 1000, then a random delay of between 0 and 1000
     * milliseconds will be added.
     */
    callMemberEventRetryJitter?: number;

    /**
     * The minimum time (in milliseconds) between each attempt to send encryption key(s).
     * e.g. if this is set to 1000, then we will send at most one key event every second.
     */
    updateEncryptionKeyThrottle?: number;

    /**
     * The delay (in milliseconds) after a member leaves before we create and publish a new key, because people
     * tend to leave calls at the same time.
     */
    makeKeyDelay?: number;

    /**
     * The delay (in milliseconds) between creating and sending a new key and starting to encrypt with it. This
     * gives other a chance to receive the new key to minimise the chance they don't get media they can't decrypt.
     * The total time between a member leaving and the call switching to new keys is therefore:
     * makeKeyDelay + useKeyDelay
     */
    useKeyDelay?: number;

    /**
     * The timeout (in milliseconds) after which the server will consider the membership to have expired if it
     * has not received a keep-alive from the client.
     */
    membershipServerSideExpiryTimeout?: number;

    /**
     * The period (in milliseconds) that the client will send membership keep-alives to the server.
     */
    membershipKeepAlivePeriod?: number;
}

/**
 * A MatrixRTCSession manages the membership & properties of a MatrixRTC session.
 * This class doesn't deal with media at all, just membership & properties of a session.
 */
export class MatrixRTCSession extends TypedEventEmitter<MatrixRTCSessionEvent, MatrixRTCSessionEventHandlerMap> {
    // The session Id of the call, this is the call_id of the call Member event.
    private _callId: string | undefined;

    private relativeExpiry: number | undefined;

    // undefined means not yet joined
    private joinConfig?: JoinSessionConfig;

    private get membershipExpiryTimeout(): number {
        return this.joinConfig?.membershipExpiryTimeout ?? 60 * 60 * 1000;
    }

    private get memberEventCheckPeriod(): number {
        return this.joinConfig?.memberEventCheckPeriod ?? 2 * 60 * 1000;
    }

    private get callMemberEventRetryDelayMinimum(): number {
        return this.joinConfig?.callMemberEventRetryDelayMinimum ?? 3_000;
    }

    private get updateEncryptionKeyThrottle(): number {
        return this.joinConfig?.updateEncryptionKeyThrottle ?? 3_000;
    }

    private get makeKeyDelay(): number {
        return this.joinConfig?.makeKeyDelay ?? 3_000;
    }

    private get useKeyDelay(): number {
        return this.joinConfig?.useKeyDelay ?? 5_000;
    }

    /**
     * If the server disallows the configured {@link membershipServerSideExpiryTimeout},
     * this stores a delay that the server does allow.
     */
    private membershipServerSideExpiryTimeoutOverride?: number;

    private get membershipServerSideExpiryTimeout(): number {
        return (
            this.membershipServerSideExpiryTimeoutOverride ??
            this.joinConfig?.membershipServerSideExpiryTimeout ??
            8_000
        );
    }

    private get membershipKeepAlivePeriod(): number {
        return this.joinConfig?.membershipKeepAlivePeriod ?? 5_000;
    }

    private get callMemberEventRetryJitter(): number {
        return this.joinConfig?.callMemberEventRetryJitter ?? 2_000;
    }

    // An identifier for our membership of the call. This will allow us to easily recognise
    // whether a membership was sent by this session or is stale from some other time.
    // It also forces our membership events to be unique, because otherwise we could try
    // to overwrite a membership from a previous session but it would do nothing because the
    // event content would be identical. We need the origin_server_ts to update though, so
    // forcing unique content fixes this.
    private membershipId: string | undefined;

    private memberEventTimeout?: ReturnType<typeof setTimeout>;
    private expiryTimeout?: ReturnType<typeof setTimeout>;
    private keysEventUpdateTimeout?: ReturnType<typeof setTimeout>;
    private makeNewKeyTimeout?: ReturnType<typeof setTimeout>;
    private setNewKeyTimeouts = new Set<ReturnType<typeof setTimeout>>();

    // This is a Focus with the specified fields for an ActiveFocus (e.g. LivekitFocusActive for type="livekit")
    private ownFocusActive?: Focus;
    // This is a Foci array that contains the Focus objects this user is aware of and proposes to use.
    private ownFociPreferred?: Focus[];

    private updateCallMembershipRunning = false;
    private needCallMembershipUpdate = false;

    private manageMediaKeys = false;
    private useLegacyMemberEvents = true;
    // userId:deviceId => array of (key, timestamp)
    private encryptionKeys = new Map<string, Array<{ key: Uint8Array; timestamp: number }>>();
    private lastEncryptionKeyUpdateRequest?: number;

    private disconnectDelayId: string | undefined;

    // We use this to store the last membership fingerprints we saw, so we can proactively re-send encryption keys
    // if it looks like a membership has been updated.
    private lastMembershipFingerprints: Set<string> | undefined;

    private currentEncryptionKeyIndex = -1;

    /**
     * The statistics for this session.
     */
    public statistics = {
        counters: {
            /**
             * The number of times we have sent a room event containing encryption keys.
             */
            roomEventEncryptionKeysSent: 0,
            /**
             * The number of times we have received a room event containing encryption keys.
             */
            roomEventEncryptionKeysReceived: 0,
        },
        totals: {
            /**
             * The total age (in milliseconds) of all room events containing encryption keys that we have received.
             * We track the total age so that we can later calculate the average age of all keys received.
             */
            roomEventEncryptionKeysReceivedTotalAge: 0,
        },
    };

    /**
     * The callId (sessionId) of the call.
     *
     * It can be undefined since the callId is only known once the first membership joins.
     * The callId is the property that, per definition, groups memberships into one call.
     */
    public get callId(): string | undefined {
        return this._callId;
    }
    /**
     * Returns all the call memberships for a room, oldest first
     */
    public static callMembershipsForRoom(room: Room): CallMembership[] {
        const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        if (!roomState) {
            logger.warn("Couldn't get state for room " + room.roomId);
            throw new Error("Could't get state for room " + room.roomId);
        }
        const callMemberEvents = roomState.getStateEvents(EventType.GroupCallMemberPrefix);

        const callMemberships: CallMembership[] = [];
        for (const memberEvent of callMemberEvents) {
            const content = memberEvent.getContent();
            const eventKeysCount = Object.keys(content).length;
            // Dont even bother about empty events (saves us from costly type/"key in" checks in bigger rooms)
            if (eventKeysCount === 0) continue;

            let membershipContents: any[] = [];

            // We first decide if its a MSC4143 event (per device state key)
            if (eventKeysCount > 1 && "focus_active" in content) {
                // We have a MSC4143 event membership event
                membershipContents.push(content);
            } else if (eventKeysCount === 1 && "memberships" in content) {
                // we have a legacy (one event for all devices) event
                if (!Array.isArray(content["memberships"])) {
                    logger.warn(`Malformed member event from ${memberEvent.getSender()}: memberships is not an array`);
                    continue;
                }
                membershipContents = content["memberships"];
            }

            if (membershipContents.length === 0) continue;

            for (const membershipData of membershipContents) {
                try {
                    const membership = new CallMembership(memberEvent, membershipData);

                    if (membership.callId !== "" || membership.scope !== "m.room") {
                        // for now, just ignore anything that isn't a room scope call
                        logger.info(`Ignoring user-scoped call`);
                        continue;
                    }

                    if (membership.isExpired()) {
                        logger.info(`Ignoring expired device membership ${membership.sender}/${membership.deviceId}`);
                        continue;
                    }
                    if (!room.hasMembershipState(membership.sender ?? "", KnownMembership.Join)) {
                        logger.info(`Ignoring membership of user ${membership.sender} who is not in the room.`);
                        continue;
                    }
                    callMemberships.push(membership);
                } catch (e) {
                    logger.warn("Couldn't construct call membership: ", e);
                }
            }
        }

        callMemberships.sort((a, b) => a.createdTs() - b.createdTs());
        if (callMemberships.length > 1) {
            logger.debug(
                `Call memberships in room ${room.roomId}, in order: `,
                callMemberships.map((m) => [m.createdTs(), m.sender]),
            );
        }

        return callMemberships;
    }

    /**
     * Return the MatrixRTC session for the room, whether there are currently active members or not
     */
    public static roomSessionForRoom(client: MatrixClient, room: Room): MatrixRTCSession {
        const callMemberships = MatrixRTCSession.callMembershipsForRoom(room);

        return new MatrixRTCSession(client, room, callMemberships);
    }

    private constructor(
        private readonly client: MatrixClient,
        public readonly room: Room,
        public memberships: CallMembership[],
    ) {
        super();
        this._callId = memberships[0]?.callId;
        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        roomState?.on(RoomStateEvent.Members, this.onMembershipUpdate);
        this.setExpiryTimer();
    }

    /*
     * Returns true if we intend to be participating in the MatrixRTC session.
     * This is determined by checking if the relativeExpiry has been set.
     */
    public isJoined(): boolean {
        return this.relativeExpiry !== undefined;
    }

    /**
     * Performs cleanup & removes timers for client shutdown
     */
    public async stop(): Promise<void> {
        await this.leaveRoomSession(1000);
        if (this.expiryTimeout) {
            clearTimeout(this.expiryTimeout);
            this.expiryTimeout = undefined;
        }
        if (this.memberEventTimeout) {
            clearTimeout(this.memberEventTimeout);
            this.memberEventTimeout = undefined;
        }
        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        roomState?.off(RoomStateEvent.Members, this.onMembershipUpdate);
    }

    /**
     * Announces this user and device as joined to the MatrixRTC session,
     * and continues to update the membership event to keep it valid until
     * leaveRoomSession() is called
     * This will not subscribe to updates: remember to call subscribe() separately if
     * desired.
     * This method will return immediately and the session will be joined in the background.
     *
     * @param fociActive - The object representing the active focus. (This depends on the focus type.)
     * @param fociPreferred - The list of preferred foci this member proposes to use/knows/has access to.
     *                        For the livekit case this is a list of foci generated from the homeserver well-known, the current rtc session,
     *                        or optionally other room members homeserver well known.
     * @param joinConfig - Additional configuration for the joined session.
     */
    public joinRoomSession(fociPreferred: Focus[], fociActive?: Focus, joinConfig?: JoinSessionConfig): void {
        if (this.isJoined()) {
            logger.info(`Already joined to session in room ${this.room.roomId}: ignoring join call`);
            return;
        }

        this.ownFocusActive = fociActive;
        this.ownFociPreferred = fociPreferred;
        this.joinConfig = joinConfig;
        this.relativeExpiry = this.membershipExpiryTimeout;
        this.manageMediaKeys = joinConfig?.manageMediaKeys ?? this.manageMediaKeys;
        this.useLegacyMemberEvents = joinConfig?.useLegacyMemberEvents ?? this.useLegacyMemberEvents;
        this.membershipId = randomString(5);

        logger.info(`Joining call session in room ${this.room.roomId} with manageMediaKeys=${this.manageMediaKeys}`);
        if (joinConfig?.manageMediaKeys) {
            this.makeNewSenderKey();
            this.requestSendCurrentKey();
        }
        // We don't wait for this, mostly because it may fail and schedule a retry, so this
        // function returning doesn't really mean anything at all.
        this.triggerCallMembershipEventUpdate();
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, true);
    }

    /**
     * Announces this user and device as having left the MatrixRTC session
     * and stops scheduled updates.
     * This will not unsubscribe from updates: remember to call unsubscribe() separately if
     * desired.
     * The membership update required to leave the session will retry if it fails.
     * Without network connection the promise will never resolve.
     * A timeout can be provided so that there is a guarantee for the promise to resolve.
     * @returns Whether the membership update was attempted and did not time out.
     */
    public async leaveRoomSession(timeout: number | undefined = undefined): Promise<boolean> {
        if (!this.isJoined()) {
            logger.info(`Not joined to session in room ${this.room.roomId}: ignoring leave call`);
            return false;
        }

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

        logger.info(`Leaving call session in room ${this.room.roomId}`);
        this.joinConfig = undefined;
        this.relativeExpiry = undefined;
        this.ownFocusActive = undefined;
        this.manageMediaKeys = false;
        this.membershipId = undefined;
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, false);

        if (timeout) {
            // The sleep promise returns the string 'timeout' and the membership update void
            // A success implies that the membership update was quicker then the timeout.
            const raceResult = await Promise.race([this.triggerCallMembershipEventUpdate(), sleep(timeout, "timeout")]);
            return raceResult !== "timeout";
        } else {
            await this.triggerCallMembershipEventUpdate();
            return true;
        }
    }

    public getActiveFocus(): Focus | undefined {
        if (this.ownFocusActive && isLivekitFocusActive(this.ownFocusActive)) {
            // A livekit active focus
            if (this.ownFocusActive.focus_selection === "oldest_membership") {
                const oldestMembership = this.getOldestMembership();
                return oldestMembership?.getPreferredFoci()[0];
            }
        }
        if (!this.ownFocusActive) {
            // we use the legacy call.member events so default to oldest member
            const oldestMembership = this.getOldestMembership();
            return oldestMembership?.getPreferredFoci()[0];
        }
    }

    /**
     * Re-emit an EncryptionKeyChanged event for each tracked encryption key. This can be used to export
     * the keys.
     */
    public reemitEncryptionKeys(): void {
        this.encryptionKeys.forEach((keys, participantId) => {
            keys.forEach((key, index) => {
                this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, key.key, index, participantId);
            });
        });
    }

    /**
     * Get the known encryption keys for a given participant device.
     *
     * @param userId the user ID of the participant
     * @param deviceId the device ID of the participant
     * @returns The encryption keys for the given participant, or undefined if they are not known.
     *
     * @deprecated This will be made private in a future release.
     */
    public getKeysForParticipant(userId: string, deviceId: string): Array<Uint8Array> | undefined {
        return this.getKeysForParticipantInternal(userId, deviceId);
    }

    private getKeysForParticipantInternal(userId: string, deviceId: string): Array<Uint8Array> | undefined {
        return this.encryptionKeys.get(getParticipantId(userId, deviceId))?.map((entry) => entry.key);
    }

    /**
     * A map of keys used to encrypt and decrypt (we are using a symmetric
     * cipher) given participant's media. This also includes our own key
     *
     * @deprecated This will be made private in a future release.
     */
    public getEncryptionKeys(): IterableIterator<[string, Array<Uint8Array>]> {
        // the returned array doesn't contain the timestamps
        return Array.from(this.encryptionKeys.entries())
            .map(([participantId, keys]): [string, Uint8Array[]] => [participantId, keys.map((k) => k.key)])
            .values();
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
                this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, keyBin, encryptionKeyIndex, participantId);
            }, this.useKeyDelay);
            this.setNewKeyTimeouts.add(useKeyTimeout);
        } else {
            if (userId === this.client.getUserId() && deviceId === this.client.getDeviceId()) {
                this.currentEncryptionKeyIndex = encryptionKeyIndex;
            }
            this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, keyBin, encryptionKeyIndex, participantId);
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
                    this.sendEncryptionKeysEvent,
                    this.updateEncryptionKeyThrottle,
                );
            }
            return;
        }

        this.sendEncryptionKeysEvent();
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

        if (!this.isJoined()) return;

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
                this.keysEventUpdateTimeout = setTimeout(this.sendEncryptionKeysEvent, resendDelay);
            } else {
                logger.info("Not scheduling key resend as another re-send is already pending");
            }
        }
    };

    /**
     * Sets a timer for the soonest membership expiry
     */
    private setExpiryTimer(): void {
        if (this.expiryTimeout) {
            clearTimeout(this.expiryTimeout);
            this.expiryTimeout = undefined;
        }

        let soonestExpiry;
        for (const membership of this.memberships) {
            const thisExpiry = membership.getMsUntilExpiry();
            // If getMsUntilExpiry is undefined we have a MSC4143 (MatrixRTC) compliant event - it never expires
            // but will be reliably resent on disconnect.
            if (thisExpiry !== undefined && (soonestExpiry === undefined || thisExpiry < soonestExpiry)) {
                soonestExpiry = thisExpiry;
            }
        }

        if (soonestExpiry != undefined) {
            this.expiryTimeout = setTimeout(this.onMembershipUpdate, soonestExpiry);
        }
    }

    public getOldestMembership(): CallMembership | undefined {
        return this.memberships[0];
    }

    public getFocusInUse(): Focus | undefined {
        const oldestMembership = this.getOldestMembership();
        if (oldestMembership?.getFocusSelection() === "oldest_membership") {
            return oldestMembership.getPreferredFoci()[0];
        }
    }

    /**
     * Process `m.call.encryption_keys` events to track the encryption keys for call participants.
     * This should be called each time the relevant event is received from a room timeline.
     * If the event is malformed then it will be logged and ignored.
     *
     * @param event the event to process
     */
    public onCallEncryption = (event: MatrixEvent): void => {
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

    private isMyMembership = (m: CallMembership): boolean =>
        m.sender === this.client.getUserId() && m.deviceId === this.client.getDeviceId();

    /**
     * Examines the latest call memberships and handles any encryption key sending or rotation that is needed.
     *
     * This function should be called when the room members or call memberships might have changed.
     */
    public onMembershipUpdate = (): void => {
        const oldMemberships = this.memberships;
        this.memberships = MatrixRTCSession.callMembershipsForRoom(this.room);

        this._callId = this._callId ?? this.memberships[0]?.callId;

        const changed =
            oldMemberships.length != this.memberships.length ||
            oldMemberships.some((m, i) => !CallMembership.equal(m, this.memberships[i]));

        if (changed) {
            logger.info(`Memberships for call in room ${this.room.roomId} have changed: emitting`);
            this.emit(MatrixRTCSessionEvent.MembershipsChanged, oldMemberships, this.memberships);

            if (this.isJoined() && !this.memberships.some(this.isMyMembership)) {
                logger.warn("Missing own membership: force re-join");
                // TODO: Should this be awaited? And is there anything to tell the focus?
                this.triggerCallMembershipEventUpdate();
            }
        }

        if (this.manageMediaKeys && this.isJoined() && this.makeNewKeyTimeout === undefined) {
            const oldMembershipIds = new Set(
                oldMemberships.filter((m) => !this.isMyMembership(m)).map(getParticipantIdFromMembership),
            );
            const newMembershipIds = new Set(
                this.memberships.filter((m) => !this.isMyMembership(m)).map(getParticipantIdFromMembership),
            );

            // We can use https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set/symmetricDifference
            // for this once available
            const anyLeft = Array.from(oldMembershipIds).some((x) => !newMembershipIds.has(x));
            const anyJoined = Array.from(newMembershipIds).some((x) => !oldMembershipIds.has(x));

            const oldFingerprints = this.lastMembershipFingerprints;
            // always store the fingerprints of these latest memberships
            this.storeLastMembershipFingerprints();

            if (anyLeft) {
                logger.debug(`Member(s) have left: queueing sender key rotation`);
                this.makeNewKeyTimeout = setTimeout(this.onRotateKeyTimeout, this.makeKeyDelay);
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

        this.setExpiryTimer();
    };

    private storeLastMembershipFingerprints(): void {
        this.lastMembershipFingerprints = new Set(
            this.memberships
                .filter((m) => !this.isMyMembership(m))
                .map((m) => `${getParticipantIdFromMembership(m)}:${m.membershipID}:${m.createdTs()}`),
        );
    }

    /**
     * Constructs our own membership
     * @param prevMembership - The previous value of our call membership, if any
     */
    private makeMyMembershipLegacy(deviceId: string, prevMembership?: CallMembership): CallMembershipDataLegacy {
        if (this.relativeExpiry === undefined) {
            throw new Error("Tried to create our own membership event when we're not joined!");
        }
        if (this.membershipId === undefined) {
            throw new Error("Tried to create our own membership event when we have no membership ID!");
        }
        const createdTs = prevMembership?.createdTs();
        return {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: deviceId,
            expires: this.relativeExpiry,
            // TODO: Date.now() should be the origin_server_ts (now).
            expires_ts: this.relativeExpiry + (createdTs ?? Date.now()),
            // we use the fociPreferred since this is the list of foci.
            // it is named wrong in the Legacy events.
            foci_active: this.ownFociPreferred,
            membershipID: this.membershipId,
            ...(createdTs ? { created_ts: createdTs } : {}),
        };
    }
    /**
     * Constructs our own membership
     */
    private makeMyMembership(deviceId: string): SessionMembershipData {
        return {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: deviceId,
            focus_active: { type: "livekit", focus_selection: "oldest_membership" },
            foci_preferred: this.ownFociPreferred ?? [],
        };
    }

    /**
     * Returns true if our membership event needs to be updated
     */
    private membershipEventNeedsUpdate(
        myPrevMembershipData?: CallMembershipData,
        myPrevMembership?: CallMembership,
    ): boolean {
        if (myPrevMembership && myPrevMembership.getMsUntilExpiry() === undefined) return false;

        // Need to update if there's a membership for us but we're not joined (valid or otherwise)
        if (!this.isJoined()) return !!myPrevMembershipData;

        // ...or if we are joined, but there's no valid membership event
        if (!myPrevMembership) return true;

        const expiryTime = myPrevMembership.getMsUntilExpiry();
        if (expiryTime !== undefined && expiryTime < this.membershipExpiryTimeout / 2) {
            // ...or if the expiry time needs bumping
            this.relativeExpiry! += this.membershipExpiryTimeout;
            return true;
        }

        return false;
    }

    private makeNewMembership(deviceId: string): SessionMembershipData | {} {
        // If we're joined, add our own
        if (this.isJoined()) {
            return this.makeMyMembership(deviceId);
        }
        return {};
    }
    /**
     * Makes a new membership list given the old list along with this user's previous membership event
     * (if any) and this device's previous membership (if any)
     */
    private makeNewLegacyMemberships(
        oldMemberships: CallMembershipData[],
        localDeviceId: string,
        myCallMemberEvent?: MatrixEvent,
        myPrevMembership?: CallMembership,
    ): ExperimentalGroupCallRoomMemberState {
        const filterExpired = (m: CallMembershipData): boolean => {
            let membershipObj;
            try {
                membershipObj = new CallMembership(myCallMemberEvent!, m);
            } catch {
                return false;
            }

            return !membershipObj.isExpired();
        };

        const transformMemberships = (m: CallMembershipData): CallMembershipData => {
            if (m.created_ts === undefined) {
                // we need to fill this in with the origin_server_ts from its original event
                m.created_ts = myCallMemberEvent!.getTs();
            }

            return m;
        };

        // Filter our any invalid or expired memberships, and also our own - we'll add that back in next
        let newMemberships = oldMemberships.filter(filterExpired).filter((m) => m.device_id !== localDeviceId);

        // Fix up any memberships that need their created_ts adding
        newMemberships = newMemberships.map(transformMemberships);

        // If we're joined, add our own
        if (this.isJoined()) {
            newMemberships.push(this.makeMyMembershipLegacy(localDeviceId, myPrevMembership));
        }

        return { memberships: newMemberships };
    }

    private triggerCallMembershipEventUpdate = async (): Promise<void> => {
        // TODO: Should this await on a shared promise?
        if (this.updateCallMembershipRunning) {
            this.needCallMembershipUpdate = true;
            return;
        }

        this.updateCallMembershipRunning = true;
        try {
            // if anything triggers an update while the update is running, do another update afterwards
            do {
                this.needCallMembershipUpdate = false;
                await this.updateCallMembershipEvent();
            } while (this.needCallMembershipUpdate);
        } finally {
            this.updateCallMembershipRunning = false;
        }
    };

    private async updateCallMembershipEvent(): Promise<void> {
        if (this.memberEventTimeout) {
            clearTimeout(this.memberEventTimeout);
            this.memberEventTimeout = undefined;
        }

        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        if (!roomState) throw new Error("Couldn't get room state for room " + this.room.roomId);

        const localUserId = this.client.getUserId();
        const localDeviceId = this.client.getDeviceId();
        if (!localUserId || !localDeviceId) throw new Error("User ID or device ID was null!");

        const callMemberEvents = roomState.events.get(EventType.GroupCallMemberPrefix);
        const legacy = this.stateEventsContainOngoingLegacySession(callMemberEvents);
        let newContent: {} | ExperimentalGroupCallRoomMemberState | SessionMembershipData = {};
        if (legacy) {
            const myCallMemberEvent = callMemberEvents?.get(localUserId);
            const content = myCallMemberEvent?.getContent() ?? {};
            let myPrevMembership: CallMembership | undefined;
            // We know its CallMembershipDataLegacy
            const memberships: CallMembershipDataLegacy[] = Array.isArray(content["memberships"])
                ? content["memberships"]
                : [];
            const myPrevMembershipData = memberships.find((m) => m.device_id === localDeviceId);
            try {
                if (
                    myCallMemberEvent &&
                    myPrevMembershipData &&
                    isLegacyCallMembershipData(myPrevMembershipData) &&
                    myPrevMembershipData.membershipID === this.membershipId
                ) {
                    myPrevMembership = new CallMembership(myCallMemberEvent, myPrevMembershipData);
                }
            } catch (e) {
                // This would indicate a bug or something weird if our own call membership
                // wasn't valid
                logger.warn("Our previous call membership was invalid - this shouldn't happen.", e);
            }
            if (myPrevMembership) {
                logger.debug(`${myPrevMembership.getMsUntilExpiry()} until our membership expires`);
            }
            if (!this.membershipEventNeedsUpdate(myPrevMembershipData, myPrevMembership)) {
                // nothing to do - reschedule the check again
                this.memberEventTimeout = setTimeout(
                    this.triggerCallMembershipEventUpdate,
                    this.memberEventCheckPeriod,
                );
                return;
            }
            newContent = this.makeNewLegacyMemberships(memberships, localDeviceId, myCallMemberEvent, myPrevMembership);
        } else {
            newContent = this.makeNewMembership(localDeviceId);
        }

        try {
            if (legacy) {
                await this.client.sendStateEvent(
                    this.room.roomId,
                    EventType.GroupCallMemberPrefix,
                    newContent,
                    localUserId,
                );
                if (this.isJoined()) {
                    // check periodically to see if we need to refresh our member event
                    this.memberEventTimeout = setTimeout(
                        this.triggerCallMembershipEventUpdate,
                        this.memberEventCheckPeriod,
                    );
                }
            } else if (this.isJoined()) {
                const stateKey = this.makeMembershipStateKey(localUserId, localDeviceId);
                const prepareDelayedDisconnection = async (): Promise<void> => {
                    try {
                        const res = await resendIfRateLimited(() =>
                            this.client._unstable_sendDelayedStateEvent(
                                this.room.roomId,
                                {
                                    delay: this.membershipServerSideExpiryTimeout,
                                },
                                EventType.GroupCallMemberPrefix,
                                {}, // leave event
                                stateKey,
                            ),
                        );
                        this.disconnectDelayId = res.delay_id;
                    } catch (e) {
                        if (
                            e instanceof MatrixError &&
                            e.errcode === "M_UNKNOWN" &&
                            e.data["org.matrix.msc4140.errcode"] === "M_MAX_DELAY_EXCEEDED"
                        ) {
                            const maxDelayAllowed = e.data["org.matrix.msc4140.max_delay"];
                            if (
                                typeof maxDelayAllowed === "number" &&
                                this.membershipServerSideExpiryTimeout > maxDelayAllowed
                            ) {
                                this.membershipServerSideExpiryTimeoutOverride = maxDelayAllowed;
                                return prepareDelayedDisconnection();
                            }
                        }
                        logger.error("Failed to prepare delayed disconnection event:", e);
                    }
                };
                await prepareDelayedDisconnection();
                // Send join event _after_ preparing the delayed disconnection event
                await resendIfRateLimited(() =>
                    this.client.sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, newContent, stateKey),
                );
                // If sending state cancels your own delayed state, prepare another delayed state
                // TODO: Remove this once MSC4140 is stable & doesn't cancel own delayed state
                if (this.disconnectDelayId !== undefined) {
                    try {
                        const knownDisconnectDelayId = this.disconnectDelayId;
                        await resendIfRateLimited(() =>
                            this.client._unstable_updateDelayedEvent(
                                knownDisconnectDelayId,
                                UpdateDelayedEventAction.Restart,
                            ),
                        );
                    } catch (e) {
                        logger.warn("Failed to update delayed disconnection event, prepare it again:", e);
                        this.disconnectDelayId = undefined;
                        await prepareDelayedDisconnection();
                    }
                }
                if (this.disconnectDelayId !== undefined) {
                    this.scheduleDelayDisconnection();
                }
            } else {
                let sentDelayedDisconnect = false;
                if (this.disconnectDelayId !== undefined) {
                    try {
                        const knownDisconnectDelayId = this.disconnectDelayId;
                        await resendIfRateLimited(() =>
                            this.client._unstable_updateDelayedEvent(
                                knownDisconnectDelayId,
                                UpdateDelayedEventAction.Send,
                            ),
                        );
                        sentDelayedDisconnect = true;
                    } catch (e) {
                        logger.error("Failed to send our delayed disconnection event:", e);
                    }
                    this.disconnectDelayId = undefined;
                }
                if (!sentDelayedDisconnect) {
                    await resendIfRateLimited(() =>
                        this.client.sendStateEvent(
                            this.room.roomId,
                            EventType.GroupCallMemberPrefix,
                            {},
                            this.makeMembershipStateKey(localUserId, localDeviceId),
                        ),
                    );
                }
            }
            logger.info("Sent updated call member event.");
        } catch (e) {
            const resendDelay = this.callMemberEventRetryDelayMinimum + Math.random() * this.callMemberEventRetryJitter;
            logger.warn(`Failed to send call member event (retrying in ${resendDelay}): ${e}`);
            await sleep(resendDelay);
            await this.triggerCallMembershipEventUpdate();
        }
    }

    private scheduleDelayDisconnection(): void {
        this.memberEventTimeout = setTimeout(this.delayDisconnection, this.membershipKeepAlivePeriod);
    }

    private readonly delayDisconnection = async (): Promise<void> => {
        try {
            const knownDisconnectDelayId = this.disconnectDelayId!;
            await resendIfRateLimited(() =>
                this.client._unstable_updateDelayedEvent(knownDisconnectDelayId, UpdateDelayedEventAction.Restart),
            );
            this.scheduleDelayDisconnection();
        } catch (e) {
            logger.error("Failed to delay our disconnection event:", e);
        }
    };

    private stateEventsContainOngoingLegacySession(callMemberEvents: Map<string, MatrixEvent> | undefined): boolean {
        if (!callMemberEvents?.size) {
            return this.useLegacyMemberEvents;
        }

        let containsAnyOngoingSession = false;
        let containsUnknownOngoingSession = false;
        for (const callMemberEvent of callMemberEvents.values()) {
            const content = callMemberEvent.getContent();
            if (Array.isArray(content["memberships"])) {
                for (const membership of content.memberships) {
                    if (!new CallMembership(callMemberEvent, membership).isExpired()) {
                        return true;
                    }
                }
            } else if (Object.keys(content).length > 0) {
                containsAnyOngoingSession ||= true;
                containsUnknownOngoingSession ||= !("focus_active" in content);
            }
        }
        return containsAnyOngoingSession && !containsUnknownOngoingSession ? false : this.useLegacyMemberEvents;
    }

    private makeMembershipStateKey(localUserId: string, localDeviceId: string): string {
        const stateKey = `${localUserId}_${localDeviceId}`;
        if (/^org\.matrix\.msc(3757|3779)\b/.exec(this.room.getVersion())) {
            return stateKey;
        } else {
            return `_${stateKey}`;
        }
    }

    private onRotateKeyTimeout = (): void => {
        if (!this.manageMediaKeys) return;

        this.makeNewKeyTimeout = undefined;
        logger.info("Making new sender key for key rotation");
        const newKeyIndex = this.makeNewSenderKey(true);
        // send immediately: if we're about to start sending with a new key, it's
        // important we get it out to others as soon as we can.
        this.sendEncryptionKeysEvent(newKeyIndex);
    };
}

async function resendIfRateLimited<T>(func: () => Promise<T>, numRetriesAllowed: number = 1): Promise<T> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await func();
        } catch (e) {
            if (numRetriesAllowed > 0 && e instanceof HTTPError && e.isRateLimitError()) {
                numRetriesAllowed--;
                let resendDelay: number;
                const defaultMs = 5000;
                try {
                    resendDelay = e.getRetryAfterMs() ?? defaultMs;
                    logger.info(`Rate limited by server, retrying in ${resendDelay}ms`);
                } catch (e) {
                    logger.warn(
                        `Error while retrieving a rate-limit retry delay, retrying after default delay of ${defaultMs}`,
                        e,
                    );
                    resendDelay = defaultMs;
                }
                await sleep(resendDelay);
            } else {
                throw e;
            }
        }
    }
}
