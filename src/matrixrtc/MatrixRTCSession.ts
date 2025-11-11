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
import { EventType, RelationType } from "../@types/event.ts";
import { KnownMembership } from "../@types/membership.ts";
import { type ISendEventResponse } from "../@types/requests.ts";
import { CallMembership } from "./CallMembership.ts";
import { RoomStateEvent } from "../models/room-state.ts";
import { MembershipManager, StickyEventMembershipManager } from "./MembershipManager.ts";
import { EncryptionManager, type IEncryptionManager } from "./EncryptionManager.ts";
import { deepCompare, logDurationSync } from "../utils.ts";
import type {
    Statistics,
    RTCNotificationType,
    Status,
    IRTCNotificationContent,
    ICallNotifyContent,
    RTCCallIntent,
    Transport,
} from "./types.ts";
import {
    MembershipManagerEvent,
    type MembershipManagerEventHandlerMap,
    type IMembershipManager,
} from "./IMembershipManager.ts";
import { RTCEncryptionManager } from "./RTCEncryptionManager.ts";
import { ToDeviceKeyTransport } from "./ToDeviceKeyTransport.ts";
import { TypedReEmitter } from "../ReEmitter.ts";
import { type MatrixEvent } from "../models/event.ts";
import { RoomStickyEventsEvent, type RoomStickyEventsMap } from "../models/room-sticky-events.ts";
import { RoomKeyTransport } from "./RoomKeyTransport.ts";

/**
 * Events emitted by MatrixRTCSession
 */
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
    /** The RTCSession did send a call notification caused by joining the call as the first member */
    DidSendCallNotification = "did_send_call_notification",
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
    [MatrixRTCSessionEvent.DidSendCallNotification]: (
        notificationContentNew: { event_id: string } & IRTCNotificationContent,
        notificationContentLegacy: { event_id: string } & ICallNotifyContent,
    ) => void;
};

export interface SessionConfig {
    /**
     * What kind of notification to send when starting the session.
     * @default `undefined` (no notification)
     */
    notificationType?: RTCNotificationType;

    /**
     * Determines the kind of call this will be.
     */
    callIntent?: RTCCallIntent;
}

/**
 * The session description is used to identify a session. Used in the state event.
 */
export interface SlotDescription {
    id: string;
    application: string;
}
export function slotIdToDescription(slotId: string): SlotDescription {
    const [application, id] = slotId.split("#");
    return { application, id };
}
export function slotDescriptionToId(slotDescription: SlotDescription): string {
    return `${slotDescription.application}#${slotDescription.id}`;
}

// The names follow these principles:
// - we use the technical term delay if the option is related to delayed events.
// - we use delayedLeaveEvent if the option is related to the delayed leave event.
// - we use membershipEvent if the option is related to the rtc member state event.
// - we use the technical term expiry if the option is related to the expiry field of the membership state event.
// - we use a `Ms` postfix if the option is a duration to avoid using words like:
//   `time`, `duration`, `delay`, `timeout`... that might be mistaken/confused with technical terms.
export interface MembershipConfig {
    /**
     * The timeout (in milliseconds) after we joined the call, that our membership should expire
     * unless we have explicitly updated it.
     *
     * This is what goes into the m.rtc.member event expiry field and is typically set to a number of hours.
     */
    membershipEventExpiryMs?: number;

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

    /**
     * The timeout (in milliseconds) with which the deleayed leave event on the server is configured.
     * After this time the server will set the event to the disconnected stat if it has not received a keep-alive from the client.
     */
    delayedLeaveEventDelayMs?: number;

    /**
     * The interval (in milliseconds) in which the client will send membership keep-alives to the server.
     */
    delayedLeaveEventRestartMs?: number;

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

    /**
     * If true, use the new to-device transport for sending encryption keys.
     */
    useExperimentalToDeviceTransport?: boolean;

    /**
     * The time (in milliseconds) after which a we consider a delayed event restart http request to have failed.
     * Setting this to a lower value will result in more frequent retries but also a higher chance of failiour.
     *
     * In the presence of network packet loss (hurting TCP connections), the custom delayedEventRestartLocalTimeoutMs
     * helps by keeping more delayed event reset candidates in flight,
     * improving the chances of a successful reset. (its is equivalent to the js-sdk `localTimeout` configuration,
     * but only applies to calls to the `_unstable_restartScheduledDelayedEvent` endpoint
     * or the `_unstable_updateDelayedEvent` endpoint with a body of `{action:"restart"}`.)
     */
    delayedLeaveEventRestartLocalTimeoutMs?: number;

    /**
     * Send membership using sticky events rather than state events.
     * This also make the client use the new m.rtc.member MSC4354 event format. (instead of m.call.member)
     *
     * **WARNING**: This is an unstable feature and not all clients will support it.
     */
    unstableSendStickyEvents?: boolean;
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
     * @deprecated - Not used by the new encryption manager.
     */
    updateEncryptionKeyThrottle?: number;

    /**
     * Sometimes it is necessary to rotate the encryption key after a membership update.
     * For performance reasons we might not want to rotate the key immediately but allow future memberships to use the same key.
     * If 5 people join in a row in less than 5 seconds, we don't want to rotate the key for each of them.
     * If 5 people leave in a row in less than 5 seconds, we don't want to rotate the key for each of them.
     * So we do share the key which was already used live for <5s to new joiners.
     * This does result in a potential leak up to the configured time of call media.
     * This has to be considered when choosing a value for this property.
     */
    keyRotationGracePeriodMs?: number;

    /**
     * The delay (in milliseconds) after a member leaves before we create and publish a new key, because people
     * tend to leave calls at the same time.
     * @deprecated - Not used by the new encryption manager.
     */
    makeKeyDelay?: number;
    /**
     * The delay (in milliseconds) between sending a new key and starting to encrypt with it. This
     * gives others a chance to receive the new key to minimize the chance they get media they can't decrypt.
     *
     * The higher this value is, the better it is for existing members as they will have a smoother experience.
     * But it impacts new joiners: They will always have to wait `useKeyDelay` before being able to decrypt the media
     * (as it will be encrypted with the new key after the delay only), even if the key has already arrived before the delay.
     */
    useKeyDelay?: number;
}
export type JoinSessionConfig = SessionConfig & MembershipConfig & EncryptionConfig;

interface SessionMembershipsForRoomOpts {
    /**
     * Listen for incoming sticky member events. If disabled, this session will
     * ignore any incoming sticky events.
     */
    listenForStickyEvents: boolean;
    /**
     * Listen for incoming  member state events (legacy). If disabled, this session will
     * ignore any incoming state events.
     */
    listenForMemberStateEvents: boolean;
}

/**
 * A MatrixRTCSession manages the membership & properties of a MatrixRTC session.
 * This class doesn't deal with media at all, just membership & properties of a session.
 */
export class MatrixRTCSession extends TypedEventEmitter<
    MatrixRTCSessionEvent | MembershipManagerEvent,
    MatrixRTCSessionEventHandlerMap & MembershipManagerEventHandlerMap
> {
    private membershipManager?: IMembershipManager;
    private encryptionManager?: IEncryptionManager;
    private joinConfig?: SessionConfig;
    private logger: Logger;

    private pendingNotificationToSend: undefined | RTCNotificationType;
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

    public get membershipStatus(): Status | undefined {
        return this.membershipManager?.status;
    }

    public get probablyLeft(): boolean | undefined {
        return this.membershipManager?.probablyLeft;
    }

    /**
     * The callId (sessionId) of the call.
     *
     * It can be undefined since the callId is only known once the first membership joins.
     * The callId is the property that, per definition, groups memberships into one call.
     * @deprecated use `slotId` instead.
     */
    public get callId(): string | undefined {
        return this.slotDescription?.id;
    }
    /**
     * The slotId of the call.
     * `{application}#{appSpecificId}`
     * It can be undefined since the slotId is only known once the first membership joins.
     * The slotId is the property that, per definition, groups memberships into one call.
     */
    public get slotId(): string | undefined {
        return slotDescriptionToId(this.slotDescription);
    }

    /**
     * Returns all the call memberships for a room that match the provided `sessionDescription`,
     * oldest first.
     *
     * @deprecated Use `MatrixRTCSession.sessionMembershipsForSlot` instead.
     */
    public static callMembershipsForRoom(
        room: Pick<Room, "getLiveTimeline" | "roomId" | "hasMembershipState" | "_unstable_getStickyEvents">,
    ): CallMembership[] {
        return MatrixRTCSession.sessionMembershipsForSlot(room, {
            id: "",
            application: "m.call",
        });
    }

    /**
     * @deprecated use `MatrixRTCSession.slotMembershipsForRoom` instead.
     */
    public static sessionMembershipsForRoom(
        room: Pick<Room, "getLiveTimeline" | "roomId" | "hasMembershipState" | "_unstable_getStickyEvents">,
        sessionDescription: SlotDescription,
    ): CallMembership[] {
        return this.sessionMembershipsForSlot(room, sessionDescription);
    }

    /**
     * Returns all the call memberships for a room that match the provided `sessionDescription`,
     * oldest first.
     *
     * By default, this will return *both* sticky and member state events.
     */
    public static sessionMembershipsForSlot(
        room: Pick<Room, "getLiveTimeline" | "roomId" | "hasMembershipState" | "_unstable_getStickyEvents">,
        slotDescription: SlotDescription,
        // default both true this implied we combine sticky and state events for the final call state
        // (prefer sticky events in case of a duplicate)
        { listenForStickyEvents, listenForMemberStateEvents }: SessionMembershipsForRoomOpts = {
            listenForStickyEvents: true,
            listenForMemberStateEvents: true,
        },
    ): CallMembership[] {
        const logger = rootLogger.getChild(`[MatrixRTCSession ${room.roomId}]`);
        let callMemberEvents = [] as MatrixEvent[];
        if (listenForStickyEvents) {
            // prefill with sticky events
            callMemberEvents = [...room._unstable_getStickyEvents()].filter(
                (e) => e.getType() === EventType.RTCMembership,
            );
        }
        if (listenForMemberStateEvents) {
            const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
            if (!roomState) {
                logger.warn("Couldn't get state for room " + room.roomId);
                throw new Error("Could't get state for room " + room.roomId);
            }
            const callMemberStateEvents = roomState.getStateEvents(EventType.GroupCallMemberPrefix);
            callMemberEvents = callMemberEvents.concat(
                callMemberStateEvents.filter(
                    (callMemberStateEvent) =>
                        !callMemberEvents.some(
                            // only care about state events which have keys which we have not yet seen in the sticky events.
                            (stickyEvent) =>
                                stickyEvent.getContent().msc4354_sticky_key === callMemberStateEvent.getStateKey(),
                        ),
                ),
            );
        }

        const callMemberships: CallMembership[] = [];
        for (const memberEvent of callMemberEvents) {
            const content = memberEvent.getContent();
            // Ignore sticky keys for the count
            const eventKeysCount = Object.keys(content).filter((k) => k !== "msc4354_sticky_key").length;
            // Dont even bother about empty events (saves us from costly type/"key in" checks in bigger rooms)
            if (eventKeysCount === 0) continue;

            const membershipContents: any[] = [];

            // We first decide if its a MSC4143 event (per device state key)
            if (eventKeysCount > 1 && "application" in content) {
                // We have a MSC4143 event membership event
                membershipContents.push(content);
            } else if (eventKeysCount === 1 && "memberships" in content) {
                logger.warn(`Legacy event found. Those are ignored, they do not contribute to the MatrixRTC session`);
            }

            if (membershipContents.length === 0) continue;

            for (const membershipData of membershipContents) {
                if (!("application" in membershipData)) {
                    // This is a left membership event, ignore it here to not log warnings.
                    continue;
                }
                try {
                    const membership = new CallMembership(memberEvent, membershipData);

                    if (!deepCompare(membership.slotDescription, slotDescription)) {
                        logger.info(
                            `Ignoring membership of user ${membership.sender} for a different slot:  ${JSON.stringify(membership.slotDescription)}`,
                        );
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
     * Return the MatrixRTC session for the room.
     * This returned session can be used to find out if there are active room call sessions
     * for the requested room.
     *
     * This method is an alias for `MatrixRTCSession.sessionForRoom` with
     * sessionDescription `{ id: "", application: "m.call" }`.
     *
     * @deprecated Use `MatrixRTCSession.sessionForSlot` with sessionDescription `{ id: "", application: "m.call" }` instead.
     */
    public static roomSessionForRoom(
        client: MatrixClient,
        room: Room,
        opts?: SessionMembershipsForRoomOpts,
    ): MatrixRTCSession {
        const callMemberships = MatrixRTCSession.sessionMembershipsForSlot(
            room,
            { id: "", application: "m.call" },
            opts,
        );
        return new MatrixRTCSession(client, room, callMemberships, { id: "", application: "m.call" });
    }

    /**
     * @deprecated Use `MatrixRTCSession.sessionForSlot` instead.
     */
    public static sessionForRoom(client: MatrixClient, room: Room, slotDescription: SlotDescription): MatrixRTCSession {
        return this.sessionForSlot(client, room, slotDescription);
    }

    /**
     * Return the MatrixRTC session for the room.
     * This returned session can be used to find out if there are active sessions
     * for the requested room and `slotDescription`.
     */
    public static sessionForSlot(
        client: MatrixClient,
        room: Room,
        slotDescription: SlotDescription,
        opts?: SessionMembershipsForRoomOpts,
    ): MatrixRTCSession {
        const callMemberships = MatrixRTCSession.sessionMembershipsForSlot(room, slotDescription, opts);
        return new MatrixRTCSession(client, room, callMemberships, slotDescription);
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
            | "sendEvent"
            | "sendStateEvent"
            | "_unstable_sendDelayedStateEvent"
            | "_unstable_updateDelayedEvent"
            | "_unstable_cancelScheduledDelayedEvent"
            | "_unstable_restartScheduledDelayedEvent"
            | "_unstable_sendScheduledDelayedEvent"
            | "_unstable_sendStickyEvent"
            | "_unstable_sendStickyDelayedEvent"
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
        /**
         * The slot description is a virtual address where participants are allowed to meet.
         * This session will only manage memberships that match this slot description.
         * Sessions are distinct if any of those properties are distinct: `roomSubset.roomId`, `slotDescription.application`, `slotDescription.id`.
         */
        public readonly slotDescription: SlotDescription,
    ) {
        super();
        this.logger = rootLogger.getChild(`[MatrixRTCSession ${roomSubset.roomId}]`);
        const roomState = this.roomSubset.getLiveTimeline().getState(EventTimeline.FORWARDS);
        // TODO: double check if this is actually needed. Should be covered by refreshRoom in MatrixRTCSessionManager
        roomState?.on(RoomStateEvent.Members, this.onRoomMemberUpdate);
        this.roomSubset.on(RoomStickyEventsEvent.Update, this.onStickyEventUpdate);

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
        this.roomSubset.off(RoomStickyEventsEvent.Update, this.onStickyEventUpdate);
    }

    private reEmitter = new TypedReEmitter<
        MatrixRTCSessionEvent | MembershipManagerEvent,
        MatrixRTCSessionEventHandlerMap & MembershipManagerEventHandlerMap
    >(this);

    /**
     * Announces this user and device as joined to the MatrixRTC session,
     * and continues to update the membership event to keep it valid until
     * leaveRoomSession() is called
     * This will not subscribe to updates: remember to call subscribe() separately if
     * desired.
     * This method will return immediately and the session will be joined in the background.
     * @param fociPreferred the list of preferred foci to use in the joined RTC membership event.
     * If multiSfuFocus is set, this is only needed if this client wants to publish to multiple transports simultaneously.
     * @param multiSfuFocus the active focus to use in the joined RTC membership event. Setting this implies the
     * membership manager will operate in a multi-SFU connection mode. If `undefined`, an `oldest_membership`
     * transport selection will be used instead.
     * @param joinConfig - Additional configuration for the joined session.
     */
    public joinRoomSession(
        fociPreferred: Transport[],
        multiSfuFocus?: Transport,
        joinConfig?: JoinSessionConfig,
    ): void {
        if (this.isJoined()) {
            this.logger.info(`Already joined to session in room ${this.roomSubset.roomId}: ignoring join call`);
            return;
        } else {
            // Create MembershipManager and pass the RTCSession logger (with room id info)
            this.membershipManager = joinConfig?.unstableSendStickyEvents
                ? new StickyEventMembershipManager(
                      joinConfig,
                      this.roomSubset,
                      this.client,
                      this.slotDescription,
                      this.logger,
                  )
                : new MembershipManager(joinConfig, this.roomSubset, this.client, this.slotDescription, this.logger);

            this.reEmitter.reEmit(this.membershipManager!, [
                MembershipManagerEvent.ProbablyLeft,
                MembershipManagerEvent.StatusChanged,
            ]);
            // Create Encryption manager
            let transport;
            if (joinConfig?.useExperimentalToDeviceTransport) {
                this.logger.info("Using experimental to-device transport for encryption keys");
                this.logger.info("Using to-device with room fallback transport for encryption keys");
                const [uId, dId] = [this.client.getUserId()!, this.client.getDeviceId()!];
                const [room, client, statistics] = [this.roomSubset, this.client, this.statistics];
                const transport = new ToDeviceKeyTransport(uId, dId, room.roomId, client, statistics);
                this.encryptionManager = new RTCEncryptionManager(
                    this.client.getUserId()!,
                    this.client.getDeviceId()!,
                    () => this.memberships,
                    transport,
                    this.statistics,
                    (keyBin: Uint8Array, encryptionKeyIndex: number, participantId: string) => {
                        this.emit(
                            MatrixRTCSessionEvent.EncryptionKeyChanged,
                            keyBin,
                            encryptionKeyIndex,
                            participantId,
                        );
                    },
                    this.logger,
                );
            } else {
                transport = new RoomKeyTransport(this.roomSubset, this.client, this.statistics);
                this.encryptionManager = new EncryptionManager(
                    this.client.getUserId()!,
                    this.client.getDeviceId()!,
                    () => this.memberships,
                    transport,
                    this.statistics,
                    (keyBin: Uint8Array, encryptionKeyIndex: number, participantId: string) => {
                        this.emit(
                            MatrixRTCSessionEvent.EncryptionKeyChanged,
                            keyBin,
                            encryptionKeyIndex,
                            participantId,
                        );
                    },
                );
            }
        }

        this.joinConfig = joinConfig;
        this.pendingNotificationToSend = this.joinConfig?.notificationType;

        // Join!
        this.membershipManager!.join(fociPreferred, multiSfuFocus, (e) => {
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
     * This returns the focus in use by the oldest membership.
     * Do not use since this might be just the focus for the oldest membership. others might use a different focus.
     * @deprecated use `member.getTransport(session.getOldestMembership())` instead for the specific member you want to get the focus for.
     */
    public getFocusInUse(): Transport | undefined {
        const oldestMembership = this.getOldestMembership();
        return oldestMembership?.getTransport(oldestMembership);
    }

    /**
     * The used focusActive of the oldest membership (to find out the selection type multi-sfu or oldest membership active focus)
     * @deprecated does not work with m.rtc.member. Do not rely on it.
     */
    public getActiveFocus(): Transport | undefined {
        return this.getOldestMembership()?.getFocusActive();
    }
    public getOldestMembership(): CallMembership | undefined {
        return this.memberships[0];
    }

    /**
     * Get the call intent for the current call, based on what members are advertising. If one or more
     * members disagree on the current call intent, or nobody specifies one then `undefined` is returned.
     *
     * If all members that specify a call intent agree, that value is returned.
     * @returns A call intent, or `undefined` if no consensus or not given.
     */
    public getConsensusCallIntent(): RTCCallIntent | undefined {
        const getFirstCallIntent = this.memberships.find((m) => !!m.callIntent)?.callIntent;
        if (!getFirstCallIntent) {
            return undefined;
        }
        if (this.memberships.every((m) => !m.callIntent || m.callIntent === getFirstCallIntent)) {
            return getFirstCallIntent;
        }
        return undefined;
    }

    public async updateCallIntent(callIntent: RTCCallIntent): Promise<void> {
        const myMembership = this.membershipManager?.ownMembership;
        if (!myMembership) {
            throw Error("Not connected yet");
        }
        await this.membershipManager?.updateCallIntent(callIntent);
    }

    /**
     * Re-emit an EncryptionKeyChanged event for each tracked encryption key. This can be used to export
     * the keys.
     */
    public reemitEncryptionKeys(): void {
        this.encryptionManager?.getEncryptionKeys().forEach((keyRing, participantId) => {
            keyRing.forEach((keyInfo) => {
                this.emit(MatrixRTCSessionEvent.EncryptionKeyChanged, keyInfo.key, keyInfo.keyIndex, participantId);
            });
        });
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
     * Sends notification events to indiciate the call has started.
     * Note: This does not return a promise, instead scheduling the notification events to be sent.
     * @param parentEventId Event id linking to your RTC call membership event.
     * @param notificationType The type of notification to send
     * @param callIntent The type of call this is (e.g. "audio").
     */
    private sendCallNotify(
        parentEventId: string,
        notificationType: RTCNotificationType,
        callIntent?: RTCCallIntent,
    ): void {
        const sendLegacyNotificationEvent = async (): Promise<{
            response: ISendEventResponse;
            content: ICallNotifyContent;
        }> => {
            const content: ICallNotifyContent = {
                "application": "m.call",
                "m.mentions": { user_ids: [], room: true },
                "notify_type": notificationType === "notification" ? "notify" : notificationType,
                "call_id": this.callId!,
            };
            const response = await this.client.sendEvent(this.roomSubset.roomId, EventType.CallNotify, content);
            return { response, content };
        };
        const sendNewNotificationEvent = async (): Promise<{
            response: ISendEventResponse;
            content: IRTCNotificationContent;
        }> => {
            const content: IRTCNotificationContent = {
                "m.mentions": { user_ids: [], room: true },
                "notification_type": notificationType,
                "m.relates_to": {
                    event_id: parentEventId,
                    rel_type: RelationType.Reference,
                },
                "sender_ts": Date.now(),
                "lifetime": 30_000, // 30 seconds
            };
            if (callIntent) {
                content["m.call.intent"] = callIntent;
            }
            const response = await this.client.sendEvent(this.roomSubset.roomId, EventType.RTCNotification, content);
            return { response, content };
        };

        void Promise.all([sendLegacyNotificationEvent(), sendNewNotificationEvent()])
            .then(([legacy, newNotification]) => {
                // Join event_id and origin event content
                const legacyResult = { ...legacy.response, ...legacy.content };
                const newResult = { ...newNotification.response, ...newNotification.content };
                this.emit(MatrixRTCSessionEvent.DidSendCallNotification, newResult, legacyResult);
            })
            .catch(([errorLegacy, errorNew]) =>
                this.logger.error("Failed to send call notification", errorLegacy, errorNew),
            );
    }

    /**
     * Call this when the Matrix room members have changed.
     */
    private readonly onRoomMemberUpdate = (): void => {
        this.recalculateSessionMembers();
    };

    /**
     * Call this when a sticky event update has occured.
     */
    private readonly onStickyEventUpdate: RoomStickyEventsMap[RoomStickyEventsEvent.Update] = (
        added,
        updated,
        removed,
    ): void => {
        if (
            [...added, ...removed, ...updated.flatMap((v) => [v.current, v.previous])].some(
                (e) => e.getType() === EventType.RTCMembership,
            )
        ) {
            this.recalculateSessionMembers();
        }
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
        this.memberships = MatrixRTCSession.sessionMembershipsForSlot(this.room, this.slotDescription);

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
            // The `ownMembership` will be set when calling `onRTCSessionMemberUpdate`.
            const ownMembership = this.membershipManager?.ownMembership;
            if (this.pendingNotificationToSend && ownMembership && oldMemberships.length === 0) {
                // If we're the first member in the call, we're responsible for
                // sending the notification event
                if (ownMembership.eventId && this.joinConfig?.notificationType) {
                    this.sendCallNotify(
                        ownMembership.eventId,
                        this.joinConfig.notificationType,
                        ownMembership.callIntent,
                    );
                } else {
                    this.logger.warn("Own membership eventId is undefined, cannot send call notification");
                }
            }
            // If anyone else joins the session it is no longer our responsibility to send the notification.
            // (If we were the joiner we already did sent the notification in the block above.)
            if (this.memberships.length > 0) this.pendingNotificationToSend = undefined;
        } else {
            this.logger.debug(`No membership changes detected for room ${this.roomSubset.roomId}`);
        }
        // This also needs to be done if `changed` = false
        // A member might have updated their fingerprint (created_ts)
        void this.encryptionManager?.onMembershipsUpdate(oldMemberships);

        this.setExpiryTimer();
    };
}
