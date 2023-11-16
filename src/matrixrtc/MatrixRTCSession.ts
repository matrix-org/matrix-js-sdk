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
import { CallMembership, CallMembershipData } from "./CallMembership";
import { Focus } from "./focus";
import { MatrixError, MatrixEvent } from "../matrix";
import { randomString, secureRandomBase64Url } from "../randomstring";
import { EncryptionKeysEventContent } from "./types";
import { decodeBase64, encodeUnpaddedBase64 } from "../base64";

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

function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a === b) return true;
    return a && b && a.length === b.length && a.every((x, i) => x === b[i]);
}

export enum MatrixRTCSessionEvent {
    // A member joined, left, or updated a property of their membership.
    MembershipsChanged = "memberships_changed",
    // We joined or left the session: our own local idea of whether we are joined,
    // separate from MembershipsChanged, ie. independent of whether our member event
    // has succesfully gone through.
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

    private activeFoci: Focus[] | undefined;

    private updateCallMembershipRunning = false;
    private needCallMembershipUpdate = false;

    private manageMediaKeys = false;
    // userId:deviceId => array of keys
    private encryptionKeys = new Map<string, Array<Uint8Array>>();
    private lastEncryptionKeyUpdateRequest?: number;

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
            const eventMemberships: CallMembershipData[] = memberEvent.getContent()["memberships"];
            if (eventMemberships === undefined) {
                logger.warn(`Ignoring malformed member event from ${memberEvent.getSender()}: no memberships section`);
                continue;
            }
            if (!Array.isArray(eventMemberships)) {
                logger.warn(`Malformed member event from ${memberEvent.getSender()}: memberships is not an array`);
                continue;
            }

            for (const membershipData of eventMemberships) {
                try {
                    const membership = new CallMembership(memberEvent, membershipData);

                    if (membership.callId !== "" || membership.scope !== "m.room") {
                        // for now, just ignore anything that isn't the a room scope call
                        logger.info(`Ignoring user-scoped call`);
                        continue;
                    }

                    if (membership.isExpired()) {
                        logger.info(
                            `Ignoring expired device membership ${memberEvent.getSender()}/${membership.deviceId}`,
                        );
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
     * Return a the MatrixRTC for the room, whether there are currently active members or not
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
        this.setExpiryTimer();
    }

    /*
     * Returns true if we intend to be participating in the MatrixRTC session.
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
    }

    /**
     * Announces this user and device as joined to the MatrixRTC session,
     * and continues to update the membership event to keep it valid until
     * leaveRoomSession() is called
     * This will not subscribe to updates: remember to call subscribe() separately if
     * desired.
     * This method will return immediately and the session will be joined in the background.
     *
     * @param activeFoci - The list of foci to set as currently active in the call member event
     * @param manageMediaKeys - If true, generate and share a a media key for this participant,
     *                          and emit MatrixRTCSessionEvent.EncryptionKeyChanged when
     *                          media keys for other participants become available.
     */
    public joinRoomSession(activeFoci: Focus[], manageMediaKeys?: boolean): void {
        if (this.isJoined()) {
            logger.info(`Already joined to session in room ${this.room.roomId}: ignoring join call`);
            return;
        }

        logger.info(`Joining call session in room ${this.room.roomId} with manageMediaKeys=${manageMediaKeys}`);
        this.activeFoci = activeFoci;
        this.relativeExpiry = MEMBERSHIP_EXPIRY_TIME;
        this.manageMediaKeys = manageMediaKeys ?? false;
        this.membershipId = randomString(5);
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, true);
        if (manageMediaKeys) {
            this.makeNewSenderKey();
            this.requestKeyEventSend();
        }
        // We don't wait for this, mostly because it may fail and schedule a retry, so this
        // function returning doesn't really mean anything at all.
        this.triggerCallMembershipEventUpdate();
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
        this.activeFoci = undefined;
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

    public getKeysForParticipant(userId: string, deviceId: string): Array<Uint8Array> | undefined {
        return this.encryptionKeys.get(getParticipantId(userId, deviceId));
    }

    /**
     * A map of keys used to encrypt and decrypt (we are using a symmetric
     * cipher) given participant's media. This also includes our own key
     */
    public getEncryptionKeys(): IterableIterator<[string, Array<Uint8Array>]> {
        return this.encryptionKeys.entries();
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
     * The encryption keys for the local participanmt are also stored here under the
     * user and device ID of the local participant.
     * @param userId - The user ID of the participant
     * @param deviceId - Device ID of the participant
     * @param encryptionKeyIndex - The index of the key to set
     * @param encryptionKeyString - The string represenation of the key to set in base64
     * @param delayBeforeuse - If true, delay before emitting a key changed event. Useful when setting
     *                         encryption keys for the local participant to allow time for the key to
     *                         be distributed.
     */
    private setEncryptionKey(
        userId: string,
        deviceId: string,
        encryptionKeyIndex: number,
        encryptionKeyString: string,
        delayBeforeuse = false,
    ): void {
        const keyBin = decodeBase64(encryptionKeyString);

        const participantId = getParticipantId(userId, deviceId);
        const encryptionKeys = this.encryptionKeys.get(participantId) ?? [];

        if (keysEqual(encryptionKeys[encryptionKeyIndex], keyBin)) return;

        encryptionKeys[encryptionKeyIndex] = keyBin;
        this.encryptionKeys.set(participantId, encryptionKeys);
        if (delayBeforeuse) {
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
     * @param delayBeforeUse - If true, wait for a short period before settign the key for the
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
        this.setEncryptionKey(userId, deviceId, encryptionKeyIndex, encryptionKey, delayBeforeUse);
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
            if (soonestExpiry === undefined || thisExpiry < soonestExpiry) {
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

    public onCallEncryption = (event: MatrixEvent): void => {
        const userId = event.getSender();
        const content = event.getContent<EncryptionKeysEventContent>();

        const deviceId = content["device_id"];
        const callId = content["call_id"];

        if (!userId) {
            logger.warn(`Received m.call.encryption_keys with no userId: callId=${callId}`);
            return;
        }

        // We currently only handle callId = ""
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
                this.setEncryptionKey(userId, deviceId, encryptionKeyIndex, encryptionKey);
            }
        }
    };

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

        const isMyMembership = (m: CallMembership): boolean =>
            m.sender === this.client.getUserId() && m.deviceId === this.client.getDeviceId();

        if (this.manageMediaKeys && this.isJoined() && this.makeNewKeyTimeout === undefined) {
            const oldMebershipIds = new Set(
                oldMemberships.filter((m) => !isMyMembership(m)).map(getParticipantIdFromMembership),
            );
            const newMebershipIds = new Set(
                this.memberships.filter((m) => !isMyMembership(m)).map(getParticipantIdFromMembership),
            );

            const anyLeft = Array.from(oldMebershipIds).some((x) => !newMebershipIds.has(x));
            const anyJoined = Array.from(newMebershipIds).some((x) => !oldMebershipIds.has(x));

            if (anyLeft) {
                logger.debug(`Member(s) have left: queueing sender key rotation`);
                this.makeNewKeyTimeout = setTimeout(this.onRotateKeyTimeout, MAKE_KEY_DELAY);
            } else if (anyJoined) {
                logger.debug(`New member(s) have joined: re-sending keys`);
                this.requestKeyEventSend();
            }
        }

        this.setExpiryTimer();
    };

    /**
     * Constructs our own membership
     * @param prevEvent - The previous version of our call membership, if any
     */
    private makeMyMembership(prevMembership?: CallMembership): CallMembershipData {
        if (this.relativeExpiry === undefined) {
            throw new Error("Tried to create our own membership event when we're not joined!");
        }
        if (this.membershipId === undefined) {
            throw new Error("Tried to create our own membership event when we have no membership ID!");
        }

        const m: CallMembershipData = {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: this.client.getDeviceId()!,
            expires: this.relativeExpiry,
            foci_active: this.activeFoci,
            membershipID: this.membershipId,
        };

        if (prevMembership) m.created_ts = prevMembership.createdTs();

        return m;
    }

    /**
     * Returns true if our membership event needs to be updated
     */
    private membershipEventNeedsUpdate(
        myPrevMembershipData?: CallMembershipData,
        myPrevMembership?: CallMembership,
    ): boolean {
        // work out if we need to update our membership event
        let needsUpdate = false;
        // Need to update if there's a membership for us but we're not joined (valid or otherwise)
        if (!this.isJoined() && myPrevMembershipData) needsUpdate = true;
        if (this.isJoined()) {
            // ...or if we are joined, but there's no valid membership event
            if (!myPrevMembership) {
                needsUpdate = true;
            } else if (myPrevMembership.getMsUntilExpiry() < MEMBERSHIP_EXPIRY_TIME / 2) {
                // ...or if the expiry time needs bumping
                needsUpdate = true;
                this.relativeExpiry! += MEMBERSHIP_EXPIRY_TIME;
            }
        }

        return needsUpdate;
    }

    /**
     * Makes a new membership list given the old list alonng with this user's previous membership event
     * (if any) and this device's previous membership (if any)
     */
    private makeNewMemberships(
        oldMemberships: CallMembershipData[],
        myCallMemberEvent?: MatrixEvent,
        myPrevMembership?: CallMembership,
    ): CallMembershipData[] {
        const localDeviceId = this.client.getDeviceId();
        if (!localDeviceId) throw new Error("Local device ID is null!");

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
            newMemberships.push(this.makeMyMembership(myPrevMembership));
        }

        return newMemberships;
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

        const myCallMemberEvent = roomState.getStateEvents(EventType.GroupCallMemberPrefix, localUserId) ?? undefined;
        const content = myCallMemberEvent?.getContent<Record<any, unknown>>() ?? {};
        const memberships: CallMembershipData[] = Array.isArray(content["memberships"]) ? content["memberships"] : [];

        const myPrevMembershipData = memberships.find((m) => m.device_id === localDeviceId);
        let myPrevMembership;
        try {
            if (myCallMemberEvent && myPrevMembershipData && myPrevMembershipData.membershipID === this.membershipId) {
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

        const newContent = {
            memberships: this.makeNewMemberships(memberships, myCallMemberEvent, myPrevMembership),
        };

        try {
            await this.client.sendStateEvent(
                this.room.roomId,
                EventType.GroupCallMemberPrefix,
                newContent,
                localUserId,
            );
            logger.info(`Sent updated call member event.`);

            // check periodically to see if we need to refresh our member event
            if (this.isJoined()) {
                this.memberEventTimeout = setTimeout(this.triggerCallMembershipEventUpdate, MEMBER_EVENT_CHECK_PERIOD);
            }
        } catch (e) {
            const resendDelay = CALL_MEMBER_EVENT_RETRY_DELAY_MIN + Math.random() * 2000;
            logger.warn(`Failed to send call member event: retrying in ${resendDelay}`);
            await new Promise((resolve) => setTimeout(resolve, resendDelay));
            await this.triggerCallMembershipEventUpdate();
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
