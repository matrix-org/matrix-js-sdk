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

import { type Logger, logger as rootLogger } from "../logger.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { EventTimeline } from "../models/event-timeline.ts";
import { type Room } from "../models/room.ts";
import { type MatrixClient } from "../client.ts";
import { EventType } from "../@types/event.ts";
import { CallMembership } from "./CallMembership.ts";
import { RoomStateEvent } from "../models/room-state.ts";
import { type Focus } from "./focus.ts";
import { KnownMembership } from "../@types/membership.ts";
import { MembershipManager } from "./NewMembershipManager.ts";
import { EncryptionManager, type IEncryptionManager } from "./EncryptionManager.ts";
import { LegacyMembershipManager } from "./LegacyMembershipManager.ts";
import { logDurationSync } from "../utils.ts";
import { type Statistics } from "./types.ts";
import { RoomKeyTransport } from "./RoomKeyTransport.ts";
import type { IMembershipManager } from "./IMembershipManager.ts";
import {
    RoomAndToDeviceEvents,
    type RoomAndToDeviceEventsHandlerMap,
    RoomAndToDeviceTransport,
} from "./RoomAndToDeviceKeyTransport.ts";
import { TypedReEmitter } from "../ReEmitter.ts";
import { ToDeviceKeyTransport } from "./ToDeviceKeyTransport.ts";

export enum MatrixRTCSessionEvent {
    // A member joined, left, or updated a property of their membership.
    MembershipsChanged = "memberships_changed",
    // We joined or left the session: our own local idea of whether we are joined,
    // separate from MembershipsChanged, ie. independent of whether our member event
    // has successfully gone through.
    JoinStateChanged = "join_state_changed",
    // The key used to encrypt media has changed
    EncryptionKeyChanged = "encryption_key_changed",
    /** The membership manager had to shut down caused by an unrecoverable error */
    MembershipManagerError = "membership_manager_error",
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
    [MatrixRTCSessionEvent.MembershipManagerError]: (error: unknown) => void;
};
// The names follow these principles:
// - we use the technical term delay if the option is related to delayed events.
// - we use delayedLeaveEvent if the option is related to the delayed leave event.
// - we use membershipEvent if the option is related to the rtc member state event.
// - we use the technical term expiry if the option is related to the expiry field of the membership state event.
// - we use a `MS` postfix if the option is a duration to avoid using words like:
//   `time`, `duration`, `delay`, `timeout`... that might be mistaken/confused with technical terms.
export interface MembershipConfig {
    /**
     * Use the new Manager.
     *
     * Default: `false`.
     */
    useNewMembershipManager?: boolean;

    /**
     * The timeout (in milliseconds) after we joined the call, that our membership should expire
     * unless we have explicitly updated it.
     *
     * This is what goes into the m.rtc.member event expiry field and is typically set to a number of hours.
     */
    membershipEventExpiryMs?: number;
    /** @deprecated renamed to `membershipEventExpiryMs`*/
    membershipExpiryTimeout?: number;

    /**
     * The time in (in milliseconds) which the manager will prematurely send the updated state event before the membership `expires` time to make sure it
     * sends the updated state event early enough.
     *
     * A headroom of 1000ms and a `membershipExpiryTimeout` of 10000ms would result in the first membership event update after 9s and
     * a membership event that would be considered expired after 10s.
     *
     * This value does not have an effect on the value of `SessionMembershipData.expires`.
     */
    membershipEventExpiryHeadroomMs?: number;
    /** @deprecated  renamed to `membershipEventExpiryHeadroomMs`*/
    membershipExpiryTimeoutHeadroom?: number;

    /**
     * The timeout (in milliseconds) with which the deleayed leave event on the server is configured.
     * After this time the server will set the event to the disconnected stat if it has not received a keep-alive from the client.
     */
    delayedLeaveEventDelayMs?: number;
    /** @deprecated renamed to `delayedLeaveEventDelayMs`*/
    membershipServerSideExpiryTimeout?: number;

    /**
     * The interval (in milliseconds) in which the client will send membership keep-alives to the server.
     */
    delayedLeaveEventRestartMs?: number;
    /** @deprecated renamed to `delayedLeaveEventRestartMs`*/
    membershipKeepAlivePeriod?: number;

    /**
     * The maximum number of retries that the manager will do for delayed event sending/updating and state event sending when a server rate limit has been hit.
     */
    maximumRateLimitRetryCount?: number;

    /**
     * The maximum number of retries that the manager will do for delayed event sending/updating and state event sending when a network error occurs.
     */
    maximumNetworkErrorRetryCount?: number;

    /**
     * The time (in milliseconds) after which we will retry a http request if it
     * failed to send due to a network error. (send membership event, send delayed event, restart delayed event...)
     */
    networkErrorRetryMs?: number;
    /** @deprecated renamed to `networkErrorRetryMs`*/
    callMemberEventRetryDelayMinimum?: number;

    /**
     * If true, use the new to-device transport for sending encryption keys.
     */
    useExperimentalToDeviceTransport?: boolean;
}

export interface EncryptionConfig {
    /**
     *  If true, generate and share a media key for this participant,
     *  and emit MatrixRTCSessionEvent.EncryptionKeyChanged when
     *  media keys for other participants become available.
     */
    manageMediaKeys?: boolean;
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
}
export type JoinSessionConfig = MembershipConfig & EncryptionConfig;

/**
 * A MatrixRTCSession manages the membership & properties of a MatrixRTC session.
 * This class doesn't deal with media at all, just membership & properties of a session.
 */
export class MatrixRTCSession extends TypedEventEmitter<
    MatrixRTCSessionEvent | RoomAndToDeviceEvents,
    MatrixRTCSessionEventHandlerMap & RoomAndToDeviceEventsHandlerMap
> {
    private membershipManager?: IMembershipManager;
    private encryptionManager?: IEncryptionManager;
    // The session Id of the call, this is the call_id of the call Member event.
    private _callId: string | undefined;
    private logger: Logger;
    /**
     * This timeout is responsible to track any expiration. We need to know when we have to start
     * to ignore other call members. There is no callback for this. This timeout will always be configured to
     * emit when the next membership expires.
     */
    private expiryTimeout?: ReturnType<typeof setTimeout>;

    /**
     * The statistics for this session.
     */
    public statistics: Statistics = {
        counters: {
            roomEventEncryptionKeysSent: 0,
            roomEventEncryptionKeysReceived: 0,
        },
        totals: {
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
    public static callMembershipsForRoom(
        room: Pick<Room, "getLiveTimeline" | "roomId" | "hasMembershipState">,
    ): CallMembership[] {
        const logger = rootLogger.getChild(`[MatrixRTCSession ${room.roomId}]`);
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

            const membershipContents: any[] = [];

            // We first decide if its a MSC4143 event (per device state key)
            if (eventKeysCount > 1 && "focus_active" in content) {
                // We have a MSC4143 event membership event
                membershipContents.push(content);
            } else if (eventKeysCount === 1 && "memberships" in content) {
                logger.warn(`Legacy event found. Those are ignored, they do not contribute to the MatrixRTC session`);
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

    /**
     * WARN: this can in theory only be a subset of the room with the properties required by
     * this class.
     * Outside of tests this most likely will be a full room, however.
     * @deprecated Relying on a full Room object being available here is an anti-pattern. You should be tracking
     * the room object in your own code and passing it in when needed.
     */
    public get room(): Room {
        return this.roomSubset as Room;
    }

    /**
     * This constructs a room session. When using MatrixRTC inside the js-sdk this is expected
     * to be used with the MatrixRTCSessionManager exclusively.
     *
     * In cases where you don't use the js-sdk but build on top of another Matrix stack this class can be used standalone
     * to manage a joined MatrixRTC session.
     *
     * @param client A subset of the {@link MatrixClient} that lets the session interact with the Matrix room.
     * @param roomSubset The room this session is attached to. A subset of a js-sdk Room that the session needs.
     * @param memberships The list of memberships this session currently has.
     */
    public constructor(
        private readonly client: Pick<
            MatrixClient,
            | "getUserId"
            | "getDeviceId"
            | "sendStateEvent"
            | "_unstable_sendDelayedStateEvent"
            | "_unstable_updateDelayedEvent"
            | "sendEvent"
            | "cancelPendingEvent"
            | "encryptAndSendToDevice"
            | "off"
            | "on"
            | "decryptEventIfNeeded"
        >,
        private roomSubset: Pick<
            Room,
            "getLiveTimeline" | "roomId" | "getVersion" | "hasMembershipState" | "on" | "off"
        >,
        public memberships: CallMembership[],
    ) {
        super();
        this.logger = rootLogger.getChild(`[MatrixRTCSession ${roomSubset.roomId}]`);
        this._callId = memberships[0]?.callId;
        const roomState = this.roomSubset.getLiveTimeline().getState(EventTimeline.FORWARDS);
        // TODO: double check if this is actually needed. Should be covered by refreshRoom in MatrixRTCSessionManager
        roomState?.on(RoomStateEvent.Members, this.onRoomMemberUpdate);
        this.setExpiryTimer();
    }

    /*
     * Returns true if we intend to be participating in the MatrixRTC session.
     * This is determined by checking if the relativeExpiry has been set.
     */
    public isJoined(): boolean {
        return this.membershipManager?.isJoined() ?? false;
    }

    /**
     * Performs cleanup & removes timers for client shutdown
     */
    public async stop(): Promise<void> {
        await this.membershipManager?.leave(1000);
        if (this.expiryTimeout) {
            clearTimeout(this.expiryTimeout);
            this.expiryTimeout = undefined;
        }
        const roomState = this.roomSubset.getLiveTimeline().getState(EventTimeline.FORWARDS);
        roomState?.off(RoomStateEvent.Members, this.onRoomMemberUpdate);
    }
    private reEmitter = new TypedReEmitter<
        MatrixRTCSessionEvent | RoomAndToDeviceEvents,
        MatrixRTCSessionEventHandlerMap & RoomAndToDeviceEventsHandlerMap
    >(this);

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
            this.logger.info(`Already joined to session in room ${this.roomSubset.roomId}: ignoring join call`);
            return;
        } else {
            // Create MembershipManager and pass the RTCSession logger (with room id info)
            if (joinConfig?.useNewMembershipManager ?? false) {
                this.membershipManager = new MembershipManager(
                    joinConfig,
                    this.roomSubset,
                    this.client,
                    () => this.getOldestMembership(),
                    this.logger,
                );
            } else {
                this.membershipManager = new LegacyMembershipManager(joinConfig, this.roomSubset, this.client, () =>
                    this.getOldestMembership(),
                );
            }
            // Create Encryption manager
            let transport;
            if (joinConfig?.useExperimentalToDeviceTransport) {
                this.logger.info("Using to-device with room fallback transport for encryption keys");
                const [uId, dId] = [this.client.getUserId()!, this.client.getDeviceId()!];
                const [room, client, statistics] = [this.roomSubset, this.client, this.statistics];
                // Deprecate RoomKeyTransport: only ToDeviceKeyTransport is needed once deprecated
                const roomKeyTransport = new RoomKeyTransport(room, client, statistics);
                const toDeviceTransport = new ToDeviceKeyTransport(uId, dId, room.roomId, client, statistics);
                transport = new RoomAndToDeviceTransport(toDeviceTransport, roomKeyTransport, this.logger);

                // Expose the changes so the ui can display the currently used transport.
                this.reEmitter.reEmit(transport, [RoomAndToDeviceEvents.EnabledTransportsChanged]);
            } else {
                transport = new RoomKeyTransport(this.roomSubset, this.client, this.statistics);
            }
            this.encryptionManager = new EncryptionManager(
                this.client.getUserId()!,
                this.client.getDeviceId()!,
                () => this.memberships,
                transport,
                this.statistics,
                (keyBin: Uint8Array, encryptionKeyIndex: number, participantId: string) => {
                    this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, keyBin, encryptionKeyIndex, participantId);
                },
                this.logger,
            );
        }

        // Join!
        this.membershipManager!.join(fociPreferred, fociActive, (e) => {
            this.logger.error("MembershipManager encountered an unrecoverable error: ", e);
            this.emit(MatrixRTCSessionEvent.MembershipManagerError, e);
            this.emit(MatrixRTCSessionEvent.JoinStateChanged, this.isJoined());
        });
        this.encryptionManager!.join(joinConfig);

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
            this.logger.info(`Not joined to session in room ${this.roomSubset.roomId}: ignoring leave call`);
            return false;
        }

        this.logger.info(`Leaving call session in room ${this.roomSubset.roomId}`);

        this.encryptionManager!.leave();

        const leavePromise = this.membershipManager!.leave(timeout);
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, false);

        return await leavePromise;
    }

    /**
     * Get the active focus from the current CallMemberState event
     * @returns The focus that is currently in use to connect to this session. This is undefined
     * if the client is not connected to this session.
     */
    public getActiveFocus(): Focus | undefined {
        return this.membershipManager?.getActiveFocus();
    }

    public getOldestMembership(): CallMembership | undefined {
        return this.memberships[0];
    }

    /**
     * This method is used when the user is not yet connected to the Session but wants to know what focus
     * the users in the session are using to make a decision how it wants/should connect.
     *
     * See also `getActiveFocus`
     * @returns The focus which should be used when joining this session.
     */
    public getFocusInUse(): Focus | undefined {
        const oldestMembership = this.getOldestMembership();
        if (oldestMembership?.getFocusSelection() === "oldest_membership") {
            return oldestMembership.getPreferredFoci()[0];
        }
    }

    /**
     * Re-emit an EncryptionKeyChanged event for each tracked encryption key. This can be used to export
     * the keys.
     */
    public reemitEncryptionKeys(): void {
        this.encryptionManager?.getEncryptionKeys().forEach((keys, participantId) => {
            keys.forEach((key, index) => {
                this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, key.key, index, participantId);
            });
        });
    }

    /**
     * A map of keys used to encrypt and decrypt (we are using a symmetric
     * cipher) given participant's media. This also includes our own key
     *
     * @deprecated This will be made private in a future release.
     */
    public getEncryptionKeys(): IterableIterator<[string, Array<Uint8Array>]> {
        const keys =
            this.encryptionManager?.getEncryptionKeys() ??
            new Map<string, Array<{ key: Uint8Array; timestamp: number }>>();
        // the returned array doesn't contain the timestamps
        return Array.from(keys.entries())
            .map(([participantId, keys]): [string, Uint8Array[]] => [participantId, keys.map((k) => k.key)])
            .values();
    }

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
            this.expiryTimeout = setTimeout(this.onRTCSessionMemberUpdate, soonestExpiry);
        }
    }

    /**
     * Call this when the Matrix room members have changed.
     */
    public onRoomMemberUpdate = (): void => {
        this.recalculateSessionMembers();
    };

    /**
     * Call this when something changed that may impacts the current MatrixRTC members in this session.
     */
    public onRTCSessionMemberUpdate = (): void => {
        this.recalculateSessionMembers();
    };

    /**
     * Call this when anything that could impact rtc memberships has changed: Room Members or RTC members.
     *
     * Examines the latest call memberships and handles any encryption key sending or rotation that is needed.
     *
     * This function should be called when the room members or call memberships might have changed.
     */
    private recalculateSessionMembers = (): void => {
        const oldMemberships = this.memberships;
        this.memberships = MatrixRTCSession.callMembershipsForRoom(this.room);

        this._callId = this._callId ?? this.memberships[0]?.callId;

        const changed =
            oldMemberships.length != this.memberships.length ||
            oldMemberships.some((m, i) => !CallMembership.equal(m, this.memberships[i]));

        if (changed) {
            this.logger.info(
                `Memberships for call in room ${this.roomSubset.roomId} have changed: emitting (${this.memberships.length} members)`,
            );
            logDurationSync(this.logger, "emit MatrixRTCSessionEvent.MembershipsChanged", () => {
                this.emit(MatrixRTCSessionEvent.MembershipsChanged, oldMemberships, this.memberships);
            });

            void this.membershipManager?.onRTCSessionMemberUpdate(this.memberships);
        }
        // This also needs to be done if `changed` = false
        // A member might have updated their fingerprint (created_ts)
        void this.encryptionManager?.onMembershipsUpdate(oldMemberships);

        this.setExpiryTimer();
    };
}
