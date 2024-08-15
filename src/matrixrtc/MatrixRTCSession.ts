/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { logger } from "../logger";
import { TypedEventEmitter } from "../models/typed-event-emitter";
import { EventTimeline } from "../models/event-timeline";
import { Room } from "../models/room";
import { MatrixClient } from "../client";
import { EventType } from "../@types/event";
import { UpdateDelayedEventAction } from "../@types/requests";
import {
    CallMembership,
    CallMembershipData,
    CallMembershipDataLegacy,
    SessionMembershipData,
    isLegacyCallMembershipData,
} from "./CallMembership";
import { RoomStateEvent } from "../models/room-state";
import { Focus } from "./focus";
import { randomString, secureRandomBase64Url } from "../randomstring";
import { EncryptionKeysEventContent } from "./types";
import { decodeBase64, encodeUnpaddedBase64 } from "../base64";
import { KnownMembership } from "../@types/membership";
import { MatrixError } from "../http-api/errors";
import { MatrixEvent } from "../models/event";
import { isLivekitFocusActive } from "./LivekitFocus";
import { ExperimentalGroupCallRoomMemberState } from "../webrtc/groupCall";

const MEMBERSHIP_EXPIRY_TIME = 60 * 60 * 1000;
const MEMBER_EVENT_CHECK_PERIOD = 2 * 60 * 1000; // How often we check to see if we need to re-send our member event
const CALL_MEMBER_EVENT_RETRY_DELAY_MIN = 3000;
const UPDATE_ENCRYPTION_KEY_THROTTLE = 3000;

// A delay after a member leaves before we create and publish a new key, because people
// tend to leave calls at the same time
const MAKE_KEY_DELAY = 3000;
// The delay between creating and sending a new key and starting to encrypt with it. This gives others
// a chance to receive the new key to minimise the chance they don't get media they can't decrypt.
// The total time between a member leaving and the call switching to new keys is therefore
// MAKE_KEY_DELAY + SEND_KEY_DELAY
const USE_KEY_DELAY = 5000;

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
    /** If true, generate and share a media key for this participant,
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
}
/**
 * A MatrixRTCSession manages the membership & properties of a MatrixRTC session.
 * This class doesn't deal with media at all, just membership & properties of a session.
 */
export class MatrixRTCSession extends TypedEventEmitter<MatrixRTCSessionEvent, MatrixRTCSessionEventHandlerMap> {
    // The session Id of the call, this is the call_id of the call Member event.
    private _callId: string | undefined;

    // How many ms after we joined the call, that our membership should expire, or undefined
    // if we're not yet joined
    private relativeExpiry: number | undefined;

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

    // We use this to store the last membership fingerprints we saw, so we can proactively re-send encryption keys
    // if it looks like a membership has been updated.
    private lastMembershipFingerprints: Set<string> | undefined;

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
        this.relativeExpiry = MEMBERSHIP_EXPIRY_TIME;
        this.manageMediaKeys = joinConfig?.manageMediaKeys ?? this.manageMediaKeys;
        this.useLegacyMemberEvents = joinConfig?.useLegacyMemberEvents ?? this.useLegacyMemberEvents;
        this.membershipId = randomString(5);

        logger.info(`Joining call session in room ${this.room.roomId} with manageMediaKeys=${this.manageMediaKeys}`);
        if (joinConfig?.manageMediaKeys) {
            this.makeNewSenderKey();
            this.requestKeyEventSend();
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
     */
    public async leaveRoomSession(timeout: number | undefined = undefined): Promise<boolean> {
        if (!this.isJoined()) {
            logger.info(`Not joined to session in room ${this.room.roomId}: ignoring leave call`);
            return new Promise((resolve) => resolve(false));
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
        this.relativeExpiry = undefined;
        this.ownFocusActive = undefined;
        this.manageMediaKeys = false;
        this.membershipId = undefined;
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, false);

        const timeoutPromise = new Promise((r) => {
            if (timeout) {
                // will never resolve if timeout is not set
                setTimeout(r, timeout, "timeout");
            }
        });
        return new Promise((resolve) => {
            Promise.race([this.triggerCallMembershipEventUpdate(), timeoutPromise]).then((value) => {
                // The timeoutPromise returns the string 'timeout' and the membership update void
                // A success implies that the membership update was quicker then the timeout.
                resolve(value != "timeout");
            });
        });
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
     * Get the known encryption keys for a given participant device.
     *
     * @param userId the user ID of the participant
     * @param deviceId the device ID of the participant
     * @returns The encryption keys for the given participant, or undefined if they are not known.
     */
    public getKeysForParticipant(userId: string, deviceId: string): Array<Uint8Array> | undefined {
        return this.encryptionKeys.get(getParticipantId(userId, deviceId))?.map((entry) => entry.key);
    }

    /**
     * A map of keys used to encrypt and decrypt (we are using a symmetric
     * cipher) given participant's media. This also includes our own key
     */
    public getEncryptionKeys(): IterableIterator<[string, Array<Uint8Array>]> {
        // the returned array doesn't contain the timestamps
        return Array.from(this.encryptionKeys.entries())
            .map(([participantId, keys]): [string, Uint8Array[]] => [participantId, keys.map((k) => k.key)])
            .values();
    }

    private getNewEncryptionKeyIndex(): number {
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();

        if (!userId) throw new Error("No userId!");
        if (!deviceId) throw new Error("No deviceId!");

        return (this.getKeysForParticipant(userId, deviceId)?.length ?? 0) % 16;
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
                this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, keyBin, encryptionKeyIndex, participantId);
            }, USE_KEY_DELAY);
            this.setNewKeyTimeouts.add(useKeyTimeout);
        } else {
            this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, keyBin, encryptionKeyIndex, participantId);
        }
    }

    /**
     * Generate a new sender key and add it at the next available index
     * @param delayBeforeUse - If true, wait for a short period before setting the key for the
     *                         media encryptor to use. If false, set the key immediately.
     */
    private makeNewSenderKey(delayBeforeUse = false): void {
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();

        if (!userId) throw new Error("No userId");
        if (!deviceId) throw new Error("No deviceId");

        const encryptionKey = secureRandomBase64Url(16);
        const encryptionKeyIndex = this.getNewEncryptionKeyIndex();
        logger.info("Generated new key at index " + encryptionKeyIndex);
        this.setEncryptionKey(userId, deviceId, encryptionKeyIndex, encryptionKey, Date.now(), delayBeforeUse);
    }

    /**
     * Requests that we resend our keys to the room. May send a keys event immediately
     * or queue for alter if one has already been sent recently.
     */
    private requestKeyEventSend(): void {
        if (!this.manageMediaKeys) return;

        if (
            this.lastEncryptionKeyUpdateRequest &&
            this.lastEncryptionKeyUpdateRequest + UPDATE_ENCRYPTION_KEY_THROTTLE > Date.now()
        ) {
            logger.info("Last encryption key event sent too recently: postponing");
            if (this.keysEventUpdateTimeout === undefined) {
                this.keysEventUpdateTimeout = setTimeout(this.sendEncryptionKeysEvent, UPDATE_ENCRYPTION_KEY_THROTTLE);
            }
            return;
        }

        this.sendEncryptionKeysEvent();
    }

    /**
     * Re-sends the encryption keys room event
     */
    private sendEncryptionKeysEvent = async (): Promise<void> => {
        if (this.keysEventUpdateTimeout !== undefined) {
            clearTimeout(this.keysEventUpdateTimeout);
            this.keysEventUpdateTimeout = undefined;
        }
        this.lastEncryptionKeyUpdateRequest = Date.now();

        logger.info("Sending encryption keys event");

        if (!this.isJoined()) return;

        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();

        if (!userId) throw new Error("No userId");
        if (!deviceId) throw new Error("No deviceId");

        const myKeys = this.getKeysForParticipant(userId, deviceId);

        if (!myKeys) {
            logger.warn("Tried to send encryption keys event but no keys found!");
            return;
        }

        try {
            await this.client.sendEvent(this.room.roomId, EventType.CallEncryptionKeysPrefix, {
                keys: myKeys.map((key, index) => {
                    return {
                        index,
                        key: encodeUnpaddedBase64(key),
                    };
                }),
                device_id: deviceId,
                call_id: "",
            } as EncryptionKeysEventContent);

            logger.debug(
                `Embedded-E2EE-LOG updateEncryptionKeyEvent participantId=${userId}:${deviceId} numSent=${myKeys.length}`,
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
                const resendDelay = matrixError.data?.retry_after_ms ?? 5000;
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
                    `Embedded-E2EE-LOG onCallEncryption userId=${userId}:${deviceId} encryptionKeyIndex=${encryptionKeyIndex}`,
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
                this.makeNewKeyTimeout = setTimeout(this.onRotateKeyTimeout, MAKE_KEY_DELAY);
            } else if (anyJoined) {
                logger.debug(`New member(s) have joined: re-sending keys`);
                this.requestKeyEventSend();
            } else if (oldFingerprints) {
                // does it look like any of the members have updated their memberships?
                const newFingerprints = this.lastMembershipFingerprints!;

                // We can use https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set/symmetricDifference
                // for this once available
                const candidateUpdates =
                    Array.from(oldFingerprints).some((x) => !newFingerprints.has(x)) ||
                    Array.from(newFingerprints).some((x) => !oldFingerprints.has(x));
                if (candidateUpdates) {
                    logger.debug(`Member(s) have updated/reconnected: re-sending keys`);
                    this.requestKeyEventSend();
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
        if (expiryTime !== undefined && expiryTime < MEMBERSHIP_EXPIRY_TIME / 2) {
            // ...or if the expiry time needs bumping
            this.relativeExpiry! += MEMBERSHIP_EXPIRY_TIME;
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
     * Makes a new membership list given the old list alonng with this user's previous membership event
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
            } catch (e) {
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
                this.memberEventTimeout = setTimeout(this.triggerCallMembershipEventUpdate, MEMBER_EVENT_CHECK_PERIOD);
                return;
            }
            newContent = this.makeNewLegacyMemberships(memberships, localDeviceId, myCallMemberEvent, myPrevMembership);
        } else {
            newContent = this.makeNewMembership(localDeviceId);
        }

        const stateKey = legacy ? localUserId : this.makeMembershipStateKey(localUserId, localDeviceId);
        try {
            await this.client.sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, newContent, stateKey);
            logger.info(`Sent updated call member event.`);

            // check periodically to see if we need to refresh our member event
            if (this.isJoined()) {
                if (legacy) {
                    this.memberEventTimeout = setTimeout(
                        this.triggerCallMembershipEventUpdate,
                        MEMBER_EVENT_CHECK_PERIOD,
                    );
                } else {
                    try {
                        // TODO: If delayed event times out, re-join!
                        const res = await this.client._unstable_sendDelayedStateEvent(
                            this.room.roomId,
                            {
                                delay: 8000,
                            },
                            EventType.GroupCallMemberPrefix,
                            {}, // leave event
                            stateKey,
                        );
                        this.scheduleDelayDisconnection(res.delay_id);
                    } catch (e) {
                        logger.error("Failed to send delayed event:", e);
                    }
                }
            }
        } catch (e) {
            const resendDelay = CALL_MEMBER_EVENT_RETRY_DELAY_MIN + Math.random() * 2000;
            logger.warn(`Failed to send call member event (retrying in ${resendDelay}): ${e}`);
            await new Promise((resolve) => setTimeout(resolve, resendDelay));
            await this.triggerCallMembershipEventUpdate();
        }
    }

    private scheduleDelayDisconnection(delayId: string): void {
        this.memberEventTimeout = setTimeout(() => this.delayDisconnection(delayId), 5000);
    }

    private async delayDisconnection(delayId: string): Promise<void> {
        try {
            await this.client._unstable_updateDelayedEvent(delayId, UpdateDelayedEventAction.Restart);
            this.scheduleDelayDisconnection(delayId);
        } catch (e) {
            logger.error("Failed to delay our disconnection event", e);
        }
    }

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
        this.makeNewSenderKey(true);
        // send immediately: if we're about to start sending with a new key, it's
        // important we get it out to others as soon as we can.
        this.sendEncryptionKeysEvent();
    };
}
