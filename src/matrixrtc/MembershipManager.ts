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
import { AbortError } from "p-retry";

import { EventType, RelationType } from "../@types/event.ts";
import { type ISendEventResponse, type SendDelayedEventResponse } from "../@types/requests.ts";
import { type EmptyObject } from "../@types/common.ts";
import type { MatrixClient } from "../client.ts";
import { ConnectionError, HTTPError, MatrixError } from "../http-api/errors.ts";
import { type Logger, logger as rootLogger } from "../logger.ts";
import { type Room } from "../models/room.ts";
import {
    type CallMembership,
    DEFAULT_EXPIRE_DURATION,
    type RtcMembershipData,
    type SessionMembershipData,
} from "./CallMembership.ts";
import { type Transport, isMyMembership, type RTCCallIntent, Status } from "./types.ts";
import {
    type SlotDescription,
    type MembershipConfig,
    type SessionConfig,
    slotDescriptionToId,
} from "./MatrixRTCSession.ts";
import { ActionScheduler, type ActionUpdate } from "./MembershipManagerActionScheduler.ts";
import { TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { UnsupportedDelayedEventsEndpointError } from "../errors.ts";
import {
    MembershipManagerEvent,
    type IMembershipManager,
    type MembershipManagerEventHandlerMap,
} from "./IMembershipManager.ts";

/* MembershipActionTypes:
On Join:  ───────────────┐   ┌───────────────(1)───────────┐
                         ▼   ▼                             │
                   ┌────────────────┐                      │
                   │SendDelayedEvent│ ──────(2)───┐        │
                   └────────────────┘             │        │
                           │(3)                   │        │
                           ▼                      │        │
                    ┌─────────────┐               │        │
       ┌──────(4)───│SendJoinEvent│────(4)─────┐  │        │
       │            └─────────────┘            │  │        │
       │  ┌─────┐                  ┌──────┐    │  │        │
       ▼  ▼     │                  │      ▼    ▼  ▼        │
┌────────────┐  │                  │ ┌───────────────────┐ │
│UpdateExpiry│ (s)                (s)|RestartDelayedEvent│ │
└────────────┘  │                  │ └───────────────────┘ │
          │     │                  │      │        │       │
          └─────┘                  └──────┘        └───────┘

On Leave: ─────────  STOP ALL ABOVE
                           ▼
            ┌────────────────────────────────┐
            │ SendScheduledDelayedLeaveEvent │
            └────────────────────────────────┘
                           │(5)
                           ▼
                    ┌──────────────┐
                    │SendLeaveEvent│
                    └──────────────┘
(1) [Not found error] results in resending the delayed event
(2) [hasMemberEvent = true] Sending the delayed event if we
    already have a call member event results jumping to the
    RestartDelayedEvent loop directly
(3) [hasMemberEvent = false] if there is not call member event
    sending it is the next step
(4) Both (UpdateExpiry and RestartDelayedEvent) actions are
    scheduled when successfully sending the state event
(5) Only if delayed event sending failed (fallback)
(s) Successful restart/resend
*/

/**
 * Call membership should always remain sticky for this amount
 * of time.
 */
const MEMBERSHIP_STICKY_DURATION_MS = 60 * 60 * 1000; // 60 minutes

/**
 * The different types of actions the MembershipManager can take.
 * @internal
 */
export enum MembershipActionType {
    SendDelayedEvent = "SendDelayedEvent",
    //  -> MembershipActionType.SendJoinEvent if successful
    //  -> DelayedLeaveActionType.SendDelayedEvent on error, retry sending the first delayed event.
    //  -> DelayedLeaveActionType.RestartDelayedEvent on success start updating the delayed event

    SendJoinEvent = "SendJoinEvent",
    //  -> MembershipActionType.SendJoinEvent if we run into a rate limit and need to retry
    //  -> MembershipActionType.Update if we successfully send the join event then schedule the expire event update
    //  -> DelayedLeaveActionType.RestartDelayedEvent to recheck the delayed event

    RestartDelayedEvent = "RestartDelayedEvent",
    //  -> DelayedLeaveActionType.SendMainDelayedEvent on missing delay id but there is a rtc state event
    //  -> DelayedLeaveActionType.SendDelayedEvent on missing delay id and there is no state event
    //  -> DelayedLeaveActionType.RestartDelayedEvent on success we schedule the next restart

    UpdateExpiry = "UpdateExpiry",
    //  -> MembershipActionType.Update if the timeout has passed so the next update is required.

    SendScheduledDelayedLeaveEvent = "SendScheduledDelayedLeaveEvent",
    //  -> MembershipActionType.SendLeaveEvent on failure (not found) we need to send the leave manually and cannot use the scheduled delayed event
    //  -> DelayedLeaveActionType.SendScheduledDelayedLeaveEvent on error we try again.

    SendLeaveEvent = "SendLeaveEvent",
    // -> MembershipActionType.SendLeaveEvent
}

/**
 * @internal
 */
export interface MembershipManagerState {
    /** The delayId we got when successfully sending the delayed leave event.
     * Gets set to undefined if the server claims it cannot find the delayed event anymore. */
    delayId?: string;
    /** Stores how often we have update the `expires` field.
     * `expireUpdateIterations` * `membershipEventExpiryTimeout` resolves to the value the expires field should contain next */
    expireUpdateIterations: number;
    /** The time at which we send the first state event. The time the call started from the DAG point of view.
     * This is used to compute the local sleep timestamps when to next update the member event with a new expires value. */
    startTime: number;
    /** The manager is in the state where its actually connected to the session. */
    hasMemberStateEvent: boolean;
    // There can be multiple retries at once so we need to store counters per action
    // e.g. the send update membership and the restart delayed could be rate limited at the same time.
    /** Retry counter for rate limits */
    rateLimitRetries: Map<MembershipActionType, number>;
    /** Retry counter for other errors */
    networkErrorRetries: Map<MembershipActionType, number>;
    /** The time at which we expect the server to send the delayed leave event. */
    expectedServerDelayLeaveTs?: number;
    /** This is used to track if the client expects the scheduled delayed leave event to have
     * been sent because restarting failed during the available time.
     * Once we resend the delayed event or successfully restarted it will get unset. */
    probablyLeft: boolean;
}

function createInsertActionUpdate(type: MembershipActionType, offset?: number): ActionUpdate {
    return {
        insert: [{ ts: Date.now() + (offset ?? 0), type }],
    };
}

function createReplaceActionUpdate(type: MembershipActionType, offset?: number): ActionUpdate {
    return {
        replace: [{ ts: Date.now() + (offset ?? 0), type }],
    };
}

type MembershipManagerClient = Pick<
    MatrixClient,
    | "getUserId"
    | "getDeviceId"
    | "sendStateEvent"
    | "_unstable_sendDelayedStateEvent"
    | "_unstable_updateDelayedEvent"
    | "_unstable_cancelScheduledDelayedEvent"
    | "_unstable_restartScheduledDelayedEvent"
    | "_unstable_sendScheduledDelayedEvent"
>;

/**
 * This class is responsible for sending all events relating to the own membership of a matrixRTC call.
 * It has the following tasks:
 *  - Send the users leave delayed event before sending the membership
 *  - Send the users membership if the state machine is started
 *  - Check if the delayed event was canceled due to sending the membership
 *  - update the delayed event (`restart`)
 *  - Update the state event every ~5h = `DEFAULT_EXPIRE_DURATION` (so it does not get treated as expired)
 *  - When the state machine is stopped:
 *   - Disconnect the member
 *   - Stop the timer for the delay refresh
 *   - Stop the timer for updating the state event
 */
export class MembershipManager
    extends TypedEventEmitter<MembershipManagerEvent, MembershipManagerEventHandlerMap>
    implements IMembershipManager
{
    private activated = false;
    private readonly logger: Logger;
    protected callIntent: RTCCallIntent | undefined;

    public isActivated(): boolean {
        return this.activated;
    }
    // DEPRECATED use isActivated
    public isJoined(): boolean {
        return this.isActivated();
    }

    /**
     * Puts the MembershipManager in a state where it tries to be joined.
     * It will send delayed events and membership events
     * @param fociPreferred the list of preferred foci to use in the joined RTC membership event.
     * If multiSfuFocus is set, this is only needed if this client wants to publish to multiple transports simultaneously.
     * @param multiSfuFocus the active focus to use in the joined RTC membership event. Setting this implies the
     * membership manager will operate in a multi-SFU connection mode. If `undefined`, an `oldest_membership`
     * transport selection will be used instead.
     * @param onError This will be called once the membership manager encounters an unrecoverable error.
     * This should bubble up the the frontend to communicate that the call does not work in the current environment.
     */
    public join(fociPreferred: Transport[], multiSfuFocus?: Transport, onError?: (error: unknown) => void): void {
        if (this.scheduler.running) {
            this.logger.error("MembershipManager is already running. Ignoring join request.");
            return;
        }
        this.fociPreferred = fociPreferred;
        this.rtcTransport = multiSfuFocus;
        this.leavePromiseResolvers = undefined;
        this.activated = true;
        this.oldStatus = this.status;
        this.state = MembershipManager.defaultState;

        this.scheduler
            .startWithJoin()
            .catch((e) => {
                this.logger.error("MembershipManager stopped because: ", e);
                onError?.(e);
            })
            .finally(() => {
                // Should already be set to false when calling `leave` in non error cases.
                this.activated = false;
                // Here the scheduler is not running anymore so we the `membershipLoopHandler` is not called to emit.
                if (this.oldStatus && this.oldStatus !== this.status) {
                    this.emit(MembershipManagerEvent.StatusChanged, this.oldStatus, this.status);
                }
                if (!this.scheduler.running) {
                    this.leavePromiseResolvers?.resolve(true);
                    this.leavePromiseResolvers = undefined;
                }
            });
    }

    /**
     * Leave from the call (Send an rtc session event with content: `{}`)
     * @param timeout the maximum duration this promise will take to resolve
     * @returns true if it managed to leave and false if the timeout condition happened.
     */
    public leave(timeout?: number): Promise<boolean> {
        if (!this.scheduler.running) {
            this.logger.warn("Called MembershipManager.leave() even though the MembershipManager is not running");
            return Promise.resolve(true);
        }

        // We use the promise to track if we already scheduled a leave event
        // So we do not check scheduler.actions/scheduler.insertions
        if (!this.leavePromiseResolvers) {
            // reset scheduled actions so we will not do any new actions.
            this.leavePromiseResolvers = Promise.withResolvers<boolean>();
            this.activated = false;
            this.scheduler.initiateLeave();
            if (timeout) setTimeout(() => this.leavePromiseResolvers?.resolve(false), timeout);
        }
        return this.leavePromiseResolvers.promise;
    }

    private leavePromiseResolvers?: PromiseWithResolvers<boolean>;

    public onRTCSessionMemberUpdate(memberships: CallMembership[]): Promise<void> {
        if (!this.isActivated()) {
            return Promise.resolve();
        }
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();
        if (!userId || !deviceId) {
            this.logger.error("MembershipManager.onRTCSessionMemberUpdate called without user or device id");
            return Promise.resolve();
        }
        this._ownMembership = memberships.find((m) => isMyMembership(m, userId, deviceId));

        if (!this._ownMembership) {
            // If one of these actions are scheduled or are getting inserted in the next iteration, we should already
            // take care of our missing membership.
            const sendingMembershipActions = [
                MembershipActionType.SendDelayedEvent,
                MembershipActionType.SendJoinEvent,
            ];
            this.logger.warn("Missing own membership: force re-join");
            this.state.hasMemberStateEvent = false;

            if (this.scheduler.actions.some((a) => sendingMembershipActions.includes(a.type as MembershipActionType))) {
                this.logger.error(
                    "tried adding another `SendDelayedEvent` actions even though we already have one in the Queue\nActionQueueOnMemberUpdate:",
                    this.scheduler.actions,
                );
            } else {
                // Only react to our own membership missing if we have not already scheduled sending a new membership DirectMembershipManagerAction.Join
                this.scheduler.initiateJoin();
            }
        }
        return Promise.resolve();
    }

    public async updateCallIntent(callIntent: RTCCallIntent): Promise<void> {
        if (!this.activated || !this.ownMembership) {
            throw Error("You cannot update your intent before joining the call");
        }
        if (this.ownMembership.callIntent === callIntent) {
            return; // No-op
        }
        this.callIntent = callIntent;
        // Kick off a new membership event as a result.
        await this.sendJoinEvent();
    }

    /**
     * @throws if the client does not return user or device id.
     * @param joinConfig
     * @param room
     * @param client
     */
    public constructor(
        private readonly joinConfig: (SessionConfig & MembershipConfig) | undefined,
        protected readonly room: Pick<Room, "roomId" | "getVersion">,
        protected readonly client: MembershipManagerClient,
        public readonly slotDescription: SlotDescription,
        parentLogger?: Logger,
    ) {
        super();
        this.logger = (parentLogger ?? rootLogger).getChild(`[MembershipManager]`);
        const [userId, deviceId] = [this.client.getUserId(), this.client.getDeviceId()];
        if (userId === null) throw Error("Missing userId in client");
        if (deviceId === null) throw Error("Missing deviceId in client");
        this.deviceId = deviceId;
        // this needs to become a uuid so that consecutive join/leaves result in a key rotation.
        // we keep it as a string for now for backwards compatibility.
        this.memberId = this.makeMembershipStateKey(userId, deviceId);
        this.state = MembershipManager.defaultState;
        this.callIntent = joinConfig?.callIntent;
        this.scheduler = new ActionScheduler((type): Promise<ActionUpdate> => {
            if (this.oldStatus) {
                // we put this at the beginning of the actions scheduler loop handle callback since it is a loop this
                // is equivalent to running it at the end of the loop. (just after applying the status/action list changes)
                // This order is required because this method needs to return the action updates.
                this.logger.debug(
                    `MembershipManager applied action changes. Status: ${this.oldStatus} -> ${this.status}`,
                );
                if (this.oldStatus !== this.status) {
                    this.emit(MembershipManagerEvent.StatusChanged, this.oldStatus, this.status);
                }
            }
            this.oldStatus = this.status;
            this.logger.debug(`MembershipManager before processing action. status=${this.oldStatus}`);
            return this.membershipLoopHandler(type);
        }, this.logger);
    }

    private _ownMembership?: CallMembership;
    public get ownMembership(): CallMembership | undefined {
        return this._ownMembership;
    }

    // scheduler
    private oldStatus?: Status;
    private scheduler: ActionScheduler;

    // MembershipManager mutable state.
    private state: MembershipManagerState;
    private static get defaultState(): MembershipManagerState {
        return {
            hasMemberStateEvent: false,
            delayId: undefined,

            startTime: 0,
            rateLimitRetries: new Map(),
            networkErrorRetries: new Map(),
            expireUpdateIterations: 1,
            probablyLeft: false,
        };
    }
    // Membership Event static parameters:
    protected deviceId: string;
    protected memberId: string;
    protected rtcTransport?: Transport;
    /** @deprecated This will be removed in favor or rtcTransport becoming a list of actively used transports */
    private fociPreferred?: Transport[];

    // Config:
    private delayedLeaveEventDelayMsOverride?: number;

    private get networkErrorRetryMs(): number {
        return this.joinConfig?.networkErrorRetryMs ?? 3_000;
    }
    private get membershipEventExpiryMs(): number {
        return this.joinConfig?.membershipEventExpiryMs ?? DEFAULT_EXPIRE_DURATION;
    }
    private get membershipEventExpiryHeadroomMs(): number {
        return this.joinConfig?.membershipEventExpiryHeadroomMs ?? 5_000;
    }
    private computeNextExpiryActionTs(iteration: number): number {
        return (
            this.state.startTime +
            Math.min(this.membershipEventExpiryMs, MEMBERSHIP_STICKY_DURATION_MS) * iteration -
            this.membershipEventExpiryHeadroomMs
        );
    }
    protected get delayedLeaveEventDelayMs(): number {
        return this.delayedLeaveEventDelayMsOverride ?? this.joinConfig?.delayedLeaveEventDelayMs ?? 8_000;
    }
    private get delayedLeaveEventRestartMs(): number {
        return this.joinConfig?.delayedLeaveEventRestartMs ?? 5_000;
    }
    private get maximumRateLimitRetryCount(): number {
        return this.joinConfig?.maximumRateLimitRetryCount ?? 10;
    }
    private get maximumNetworkErrorRetryCount(): number {
        return this.joinConfig?.maximumNetworkErrorRetryCount ?? 10;
    }
    private get delayedLeaveEventRestartLocalTimeoutMs(): number {
        return this.joinConfig?.delayedLeaveEventRestartLocalTimeoutMs ?? 2000;
    }

    // LOOP HANDLER:
    private async membershipLoopHandler(type: MembershipActionType): Promise<ActionUpdate> {
        switch (type) {
            case MembershipActionType.SendDelayedEvent: {
                // Before we start we check if we come from a state where we have a delay id.
                if (!this.state.delayId) {
                    return this.sendOrResendDelayedLeaveEvent(); // Normal case without any previous delayed id.
                } else {
                    // This can happen if someone else (or another client) removes our own membership event.
                    // It will trigger `onRTCSessionMemberUpdate` queue `MembershipActionType.SendDelayedEvent`.
                    // We might still have our delayed event from the previous participation and dependent on the server this might not
                    // get removed automatically if the state changes. Hence, it would remove our membership unexpectedly shortly after the rejoin.
                    //
                    // In this block we will try to cancel this delayed event before setting up a new one.

                    return this.cancelKnownDelayIdBeforeSendDelayedEvent(this.state.delayId);
                }
            }
            case MembershipActionType.RestartDelayedEvent: {
                if (!this.state.delayId) {
                    // Delay id got reset. This action was used to check if the hs canceled the delayed event when the join state got sent.
                    return createInsertActionUpdate(MembershipActionType.SendDelayedEvent);
                }
                return this.restartDelayedEvent(this.state.delayId);
            }
            case MembershipActionType.SendScheduledDelayedLeaveEvent: {
                // We are already good
                if (!this.state.hasMemberStateEvent) {
                    return { replace: [] };
                }
                if (this.state.delayId) {
                    return this.sendScheduledDelayedLeaveEventOrFallbackToSendLeaveEvent(this.state.delayId);
                } else {
                    return createInsertActionUpdate(MembershipActionType.SendLeaveEvent);
                }
            }
            case MembershipActionType.SendJoinEvent: {
                return this.sendJoinEvent();
            }
            case MembershipActionType.UpdateExpiry: {
                return this.updateExpiryOnJoinedEvent();
            }
            case MembershipActionType.SendLeaveEvent: {
                // We are good already
                if (!this.state.hasMemberStateEvent) {
                    return { replace: [] };
                }
                // This is only a fallback in case we do not have working delayed events support.
                // first we should try to just send the scheduled leave event
                return this.sendFallbackLeaveEvent();
            }
        }
    }

    // an abstraction to switch between sending state or a sticky event
    protected clientSendDelayedDisconnectMembership: () => Promise<SendDelayedEventResponse> = () =>
        this.client._unstable_sendDelayedStateEvent(
            this.room.roomId,
            { delay: this.delayedLeaveEventDelayMs },
            EventType.GroupCallMemberPrefix,
            {},
            this.memberId,
        );

    // HANDLERS (used in the membershipLoopHandler)
    private async sendOrResendDelayedLeaveEvent(): Promise<ActionUpdate> {
        // We can reach this at the start of a call (where we do not yet have a membership: state.hasMemberStateEvent=false)
        // or during a call if the state event canceled our delayed event or caused by an unexpected error that removed our delayed event.
        // (Another client could have canceled it, the homeserver might have removed/lost it due to a restart, ...)
        // In the `then` and `catch` block we treat both cases differently. "if (this.state.hasMemberStateEvent) {} else {}"
        return await this.clientSendDelayedDisconnectMembership()
            .then((response) => {
                this.state.expectedServerDelayLeaveTs = Date.now() + this.delayedLeaveEventDelayMs;
                this.setAndEmitProbablyLeft(false);
                // On success we reset retries and set delayId.
                this.resetRateLimitCounter(MembershipActionType.SendDelayedEvent);
                this.state.delayId = response.delay_id;
                if (this.state.hasMemberStateEvent) {
                    // This action was scheduled because the previous delayed event was cancelled
                    // due to lack of https://github.com/element-hq/synapse/pull/17810
                    return createInsertActionUpdate(
                        MembershipActionType.RestartDelayedEvent,
                        this.delayedLeaveEventRestartMs,
                    );
                } else {
                    // This action was scheduled because we are in the process of joining
                    return createInsertActionUpdate(MembershipActionType.SendJoinEvent);
                }
            })
            .catch((e) => {
                const repeatActionType = MembershipActionType.SendDelayedEvent;
                if (this.manageMaxDelayExceededSituation(e)) {
                    return createInsertActionUpdate(repeatActionType);
                }
                const update = this.actionUpdateFromErrors(e, repeatActionType, "_unstable_sendDelayedStateEvent");
                if (update) return update;

                if (this.state.hasMemberStateEvent) {
                    // This action was scheduled because the previous delayed event was cancelled
                    // due to lack of https://github.com/element-hq/synapse/pull/17810

                    // Don't do any other delayed event work if its not supported.
                    if (this.isUnsupportedDelayedEndpoint(e)) return {};
                    throw Error("Could not send delayed event, even though delayed events are supported. " + e);
                } else {
                    // This action was scheduled because we are in the process of joining
                    // log and fall through
                    if (this.isUnsupportedDelayedEndpoint(e)) {
                        this.logger.info("Not using delayed event because the endpoint is not supported");
                    } else {
                        this.logger.info("Not using delayed event because: " + e);
                    }
                    // On any other error we fall back to not using delayed events and send the join state event immediately
                    return createInsertActionUpdate(MembershipActionType.SendJoinEvent);
                }
            });
    }

    private async cancelKnownDelayIdBeforeSendDelayedEvent(delayId: string): Promise<ActionUpdate> {
        // Remove all running updates and restarts
        return await this.client
            ._unstable_cancelScheduledDelayedEvent(delayId)
            .then(() => {
                this.state.delayId = undefined;
                this.resetRateLimitCounter(MembershipActionType.SendDelayedEvent);
                return createReplaceActionUpdate(MembershipActionType.SendDelayedEvent);
            })
            .catch((e) => {
                const repeatActionType = MembershipActionType.SendDelayedEvent;
                const update = this.actionUpdateFromErrors(e, repeatActionType, "cancelScheduledDelayedEvent");
                if (update) return update;

                if (this.isNotFoundError(e)) {
                    // If we get a M_NOT_FOUND we know that the delayed event got already removed.
                    // This means we are good and can set it to undefined and run this again.
                    this.state.delayId = undefined;
                    return createReplaceActionUpdate(repeatActionType);
                }
                if (this.isUnsupportedDelayedEndpoint(e)) {
                    return createReplaceActionUpdate(MembershipActionType.SendJoinEvent);
                }
                // We do not just ignore and log this error since we would also need to reset the delayId.

                // This becomes an unrecoverable error case since something is significantly off if we don't hit any of the above cases
                // when state.delayId !== undefined
                // We do not just ignore and log this error since we would also need to reset the delayId.
                // It is cleaner if we, the frontend, rejoins instead of resetting the delayId here and behaving like in the success case.
                throw Error(
                    "We failed to cancel a delayed event where we already had a delay id with an error we cannot automatically handle",
                );
            });
    }

    private setAndEmitProbablyLeft(probablyLeft: boolean): void {
        if (this.state.probablyLeft === probablyLeft) {
            return;
        }
        this.state.probablyLeft = probablyLeft;
        this.emit(MembershipManagerEvent.ProbablyLeft, this.state.probablyLeft);
    }

    private async restartDelayedEvent(delayId: string): Promise<ActionUpdate> {
        // Compute the duration until we expect the server to send the delayed leave event.
        const durationUntilServerDelayedLeave = this.state.expectedServerDelayLeaveTs
            ? this.state.expectedServerDelayLeaveTs - Date.now()
            : undefined;
        const abortPromise = new Promise((_, reject) => {
            setTimeout(
                () => {
                    reject(new AbortError("Restart delayed event timed out before the HS responded"));
                },
                // We abort immediately at the time where we expect the server to send the delayed leave event.
                // At this point we want the catch block to run and set the `probablyLeft` state.
                //
                // While we are already in probablyLeft state, we use the unaltered delayedLeaveEventRestartLocalTimeoutMs.
                durationUntilServerDelayedLeave !== undefined && !this.state.probablyLeft
                    ? Math.min(this.delayedLeaveEventRestartLocalTimeoutMs, durationUntilServerDelayedLeave)
                    : this.delayedLeaveEventRestartLocalTimeoutMs,
            );
        });

        // The obvious choice here would be to use the `IRequestOpts` to set the timeout. Since this call might be forwarded
        // to the widget driver this information would get lost. That is why we mimic the AbortError using the race.
        return await Promise.race([this.client._unstable_restartScheduledDelayedEvent(delayId), abortPromise])
            .then(() => {
                // Whenever we successfully restart the delayed event we update the `state.expectedServerDelayLeaveTs`
                // which stores the predicted timestamp at which the server will send the delayed leave event if there wont be any further
                // successful restart requests.
                this.state.expectedServerDelayLeaveTs = Date.now() + this.delayedLeaveEventDelayMs;
                this.resetRateLimitCounter(MembershipActionType.RestartDelayedEvent);
                this.setAndEmitProbablyLeft(false);
                return createInsertActionUpdate(
                    MembershipActionType.RestartDelayedEvent,
                    this.delayedLeaveEventRestartMs,
                );
            })
            .catch((e) => {
                if (this.state.expectedServerDelayLeaveTs && this.state.expectedServerDelayLeaveTs <= Date.now()) {
                    // Once we reach this point it's likely that the server is sending the delayed leave event so we emit `probablyLeft = true`.
                    // It will emit `probablyLeft = false` once we notice about our leave through sync and successfully setup a new state event.
                    this.setAndEmitProbablyLeft(true);
                }
                const repeatActionType = MembershipActionType.RestartDelayedEvent;
                if (this.isNotFoundError(e)) {
                    this.state.delayId = undefined;
                    return createInsertActionUpdate(MembershipActionType.SendDelayedEvent);
                }
                // If the HS does not support delayed events we wont reschedule.
                if (this.isUnsupportedDelayedEndpoint(e)) return {};

                // TODO this also needs a test: get rate limit while checking id delayed event is scheduled
                const update = this.actionUpdateFromErrors(e, repeatActionType, "restartScheduledDelayedEvent");
                if (update) return update;

                // In other error cases we have no idea what is happening
                throw Error("Could not restart delayed event, even though delayed events are supported. " + e);
            });
    }

    private async sendScheduledDelayedLeaveEventOrFallbackToSendLeaveEvent(delayId: string): Promise<ActionUpdate> {
        return await this.client
            ._unstable_sendScheduledDelayedEvent(delayId)
            .then(() => {
                this.state.hasMemberStateEvent = false;
                this.resetRateLimitCounter(MembershipActionType.SendScheduledDelayedLeaveEvent);

                return { replace: [] };
            })
            .catch((e) => {
                const repeatActionType = MembershipActionType.SendLeaveEvent;
                if (this.isUnsupportedDelayedEndpoint(e)) return {};
                if (this.isNotFoundError(e)) {
                    this.state.delayId = undefined;
                    return createInsertActionUpdate(repeatActionType);
                }
                const update = this.actionUpdateFromErrors(e, repeatActionType, "sendScheduledDelayedEvent");
                if (update) return update;

                // On any other error we fall back to SendLeaveEvent (this includes hard errors from rate limiting)
                this.logger.warn(
                    "Encountered unexpected error during SendScheduledDelayedLeaveEvent. Falling back to SendLeaveEvent",
                    e,
                );
                return createInsertActionUpdate(repeatActionType);
            });
    }

    protected clientSendMembership: (
        myMembership: RtcMembershipData | SessionMembershipData | EmptyObject,
    ) => Promise<ISendEventResponse> = (myMembership) => {
        return this.client.sendStateEvent(
            this.room.roomId,
            EventType.GroupCallMemberPrefix,
            myMembership as EmptyObject | SessionMembershipData,
            this.memberId,
        );
    };

    private async sendJoinEvent(): Promise<ActionUpdate> {
        return await this.clientSendMembership(this.makeMyMembership(this.membershipEventExpiryMs))
            .then(() => {
                this.setAndEmitProbablyLeft(false);
                this.state.startTime = Date.now();
                // The next update should already use twice the membershipEventExpiryTimeout
                this.state.expireUpdateIterations = 1;
                this.state.hasMemberStateEvent = true;
                this.resetRateLimitCounter(MembershipActionType.SendJoinEvent);
                // An UpdateExpiry action might be left over from a previous join event.
                // We can reach sendJoinEvent when the delayed leave event gets send by the HS.
                // The branch where we might have a leftover UpdateExpiry action is:
                // RestartDelayedEvent (cannot find it, server removed it)
                // -> SendDelayedEvent (send new delayed event)
                // -> SendJoinEvent (here with a still scheduled UpdateExpiry action)
                const actionsWithoutUpdateExpiry = this.scheduler.actions.filter(
                    (a) =>
                        a.type !== MembershipActionType.UpdateExpiry && // A new UpdateExpiry action with an updated will be scheduled,
                        a.type !== MembershipActionType.SendJoinEvent, // Manually remove the SendJoinEvent action,
                );
                return {
                    replace: [
                        ...actionsWithoutUpdateExpiry,
                        // To check if the delayed event is still there or got removed by inserting the stateEvent, we need to restart it.
                        { ts: Date.now(), type: MembershipActionType.RestartDelayedEvent },
                        {
                            ts: this.computeNextExpiryActionTs(this.state.expireUpdateIterations),
                            type: MembershipActionType.UpdateExpiry,
                        },
                    ],
                };
            })
            .catch((e) => {
                const update = this.actionUpdateFromErrors(e, MembershipActionType.SendJoinEvent, "sendStateEvent");
                if (update) return update;
                throw e;
            });
    }

    private async updateExpiryOnJoinedEvent(): Promise<ActionUpdate> {
        const nextExpireUpdateIteration = this.state.expireUpdateIterations + 1;
        return await this.clientSendMembership(
            this.makeMyMembership(this.membershipEventExpiryMs * nextExpireUpdateIteration),
        )
            .then(() => {
                // Success, we reset retries and schedule update.
                this.resetRateLimitCounter(MembershipActionType.UpdateExpiry);
                this.state.expireUpdateIterations = nextExpireUpdateIteration;
                return {
                    insert: [
                        {
                            ts: this.computeNextExpiryActionTs(nextExpireUpdateIteration),
                            type: MembershipActionType.UpdateExpiry,
                        },
                    ],
                };
            })
            .catch((e) => {
                const update = this.actionUpdateFromErrors(e, MembershipActionType.UpdateExpiry, "sendStateEvent");
                if (update) return update;

                throw e;
            });
    }
    private async sendFallbackLeaveEvent(): Promise<ActionUpdate> {
        return await this.clientSendMembership({})
            .then(() => {
                this.resetRateLimitCounter(MembershipActionType.SendLeaveEvent);
                this.state.hasMemberStateEvent = false;
                return { replace: [] };
            })
            .catch((e) => {
                const update = this.actionUpdateFromErrors(e, MembershipActionType.SendLeaveEvent, "sendStateEvent");
                if (update) return update;
                throw e;
            });
    }

    // HELPERS
    private makeMembershipStateKey(localUserId: string, localDeviceId: string): string {
        const stateKey = `${localUserId}_${localDeviceId}_${this.slotDescription.application}${this.slotDescription.id}`;
        if (/^org\.matrix\.msc(3757|3779)\b/.exec(this.room.getVersion())) {
            return stateKey;
        } else {
            return `_${stateKey}`;
        }
    }

    /**
     * Constructs our own membership
     */
    protected makeMyMembership(expires: number): SessionMembershipData | RtcMembershipData {
        const ownMembership = this.ownMembership;

        const focusObjects =
            this.rtcTransport === undefined
                ? {
                      focus_active: { type: "livekit", focus_selection: "oldest_membership" } as const,
                      foci_preferred: this.fociPreferred ?? [],
                  }
                : {
                      focus_active: { type: "livekit", focus_selection: "multi_sfu" } as const,
                      foci_preferred: [this.rtcTransport, ...(this.fociPreferred ?? [])],
                  };
        return {
            "application": this.slotDescription.application,
            "call_id": this.slotDescription.id,
            "scope": "m.room",
            "device_id": this.deviceId,
            expires,
            "m.call.intent": this.callIntent,
            ...focusObjects,
            ...(ownMembership !== undefined ? { created_ts: ownMembership.createdTs() } : undefined),
        };
    }

    // Error checks and handlers

    /**
     * Check if its a NOT_FOUND error
     * @param error the error causing this handler check/execution
     * @returns true if its a not found error
     */
    private isNotFoundError(error: unknown): boolean {
        return error instanceof MatrixError && error.errcode === "M_NOT_FOUND";
    }

    /**
     * Check if this is a DelayExceeded timeout and update the TimeoutOverride for the next try
     * @param error the error causing this handler check/execution
     * @returns true if its a delay exceeded error and we updated the local TimeoutOverride
     */
    private manageMaxDelayExceededSituation(error: unknown): boolean {
        if (
            error instanceof MatrixError &&
            error.errcode === "M_UNKNOWN" &&
            error.data["org.matrix.msc4140.errcode"] === "M_MAX_DELAY_EXCEEDED"
        ) {
            const maxDelayAllowed = error.data["org.matrix.msc4140.max_delay"];
            if (typeof maxDelayAllowed === "number" && this.delayedLeaveEventDelayMs > maxDelayAllowed) {
                this.delayedLeaveEventDelayMsOverride = maxDelayAllowed;
            }
            this.logger.warn("Retry sending delayed disconnection event due to server timeout limitations:", error);
            return true;
        }
        return false;
    }

    protected actionUpdateFromErrors(
        error: unknown,
        type: MembershipActionType,
        method: string,
    ): ActionUpdate | undefined {
        const updateLimit = this.actionUpdateFromRateLimitError(error, method, type);
        if (updateLimit) return updateLimit;
        const updateNetwork = this.actionUpdateFromNetworkErrorRetry(error, type);
        if (updateNetwork) return updateNetwork;
    }
    /**
     * Check if we have a rate limit error and schedule the same action again if we dont exceed the rate limit retry count yet.
     * @param error the error causing this handler check/execution
     * @param method the method used for the throw message
     * @param type which MembershipActionType we reschedule because of a rate limit.
     * @throws If it is a rate limit error and the retry count got exceeded
     * @returns Returns true if we handled the error by rescheduling the correct next action.
     * Returns false if it is not a network error.
     */
    private actionUpdateFromRateLimitError(
        error: unknown,
        method: string,
        type: MembershipActionType,
    ): ActionUpdate | undefined {
        // "Is rate limit"-boundary
        if (!((error instanceof HTTPError || error instanceof MatrixError) && error.isRateLimitError())) {
            return undefined;
        }

        // retry boundary
        const rateLimitRetries = this.state.rateLimitRetries.get(type) ?? 0;
        if (rateLimitRetries < this.maximumRateLimitRetryCount) {
            let resendDelay: number;
            const defaultMs = 5000;
            try {
                resendDelay = error.getRetryAfterMs() ?? defaultMs;
                this.logger.info(`Rate limited by server, retrying in ${resendDelay}ms`);
            } catch (e) {
                this.logger.warn(
                    `Error while retrieving a rate-limit retry delay, retrying after default delay of ${defaultMs}`,
                    e,
                );
                resendDelay = defaultMs;
            }
            this.state.rateLimitRetries.set(type, rateLimitRetries + 1);
            return createInsertActionUpdate(type, resendDelay);
        }

        throw Error("Exceeded maximum retries for " + type + " attempts (client." + method + ")", { cause: error });
    }

    /**
     * FIXME Don't Check the error and retry the same MembershipAction again in the configured time and for the configured retry count.
     * @param error the error causing this handler check/execution
     * @param type the action type that we need to repeat because of the error
     * @throws If it is a network error and the retry count got exceeded
     * @returns
     * Returns true if we handled the error by rescheduling the correct next action.
     * Returns false if it is not a network error.
     */
    private actionUpdateFromNetworkErrorRetry(error: unknown, type: MembershipActionType): ActionUpdate | undefined {
        // "Is a network error"-boundary
        const retries = this.state.networkErrorRetries.get(type) ?? 0;

        // Strings for error logging
        const retryDurationString = this.networkErrorRetryMs / 1000 + "s";
        const retryCounterString = "(" + retries + "/" + this.maximumNetworkErrorRetryCount + ")";

        // Variables for scheduling the new event
        let retryDuration = this.networkErrorRetryMs;

        if (error instanceof Error && error.name === "AbortError") {
            // We do not wait for the timeout on local timeouts.
            retryDuration = 0;
            this.logger.warn(
                "Network local timeout error while sending event, immediate retry (" + retryCounterString + ")",
                error,
            );
        } else if (error instanceof Error && error.message.includes("updating delayed event")) {
            // TODO: We do not want error message matching here but instead the error should be a typed HTTPError
            // and be handled below automatically (the same as in the SPA case).
            //
            // The error originates because of https://github.com/matrix-org/matrix-widget-api/blob/5d81d4a26ff69e4bd3ddc79a884c9527999fb2f4/src/ClientWidgetApi.ts#L698-L701
            // uses `e` instance of HttpError (and not MatrixError)
            // The element web widget driver (only checks for MatrixError) is then failing to process (`processError`) it as a typed error: https://github.com/element-hq/element-web/blob/471712cbf06a067e5499bd5d2d7a75f693d9a12d/src/stores/widgets/StopGapWidgetDriver.ts#L711-L715
            // So it will not call: `error.asWidgetApiErrorData()` which is also missing for `HttpError`
            //
            // A proper fix would be to either find a place to convert the `HttpError` into a `MatrixError` and the `processError`
            // method to handle it as expected or to adjust `processError` to also process `HttpError`'s.
            this.logger.warn(
                "delayed event update timeout error, retrying in " + retryDurationString + " " + retryCounterString,
                error,
            );
        } else if (error instanceof ConnectionError) {
            this.logger.warn(
                "Network connection error while sending event, retrying in " +
                    retryDurationString +
                    " " +
                    retryCounterString,
                error,
            );
        } else if (
            (error instanceof HTTPError || error instanceof MatrixError) &&
            typeof error.httpStatus === "number" &&
            error.httpStatus >= 500 &&
            error.httpStatus < 600
        ) {
            this.logger.warn(
                "Server error while sending event, retrying in " + retryDurationString + " " + retryCounterString,
                error,
            );
        } else {
            return undefined;
        }

        // retry boundary
        if (retries < this.maximumNetworkErrorRetryCount) {
            this.state.networkErrorRetries.set(type, retries + 1);
            return createInsertActionUpdate(type, retryDuration);
        }

        // Failure
        throw Error(
            "Reached maximum (" + this.maximumNetworkErrorRetryCount + ") retries cause by: " + (error as Error),
        );
    }

    /**
     * Check if its an UnsupportedDelayedEventsEndpointError and which implies that we cannot do any delayed event logic
     * @param error The error to check
     * @returns true it its an UnsupportedDelayedEventsEndpointError
     */
    private isUnsupportedDelayedEndpoint(error: unknown): boolean {
        return error instanceof UnsupportedDelayedEventsEndpointError;
    }

    private resetRateLimitCounter(type: MembershipActionType): void {
        this.state.rateLimitRetries.set(type, 0);
        this.state.networkErrorRetries.set(type, 0);
    }

    public get status(): Status {
        const actions = this.scheduler.actions;
        if (actions.length === 1) {
            const { type } = actions[0];
            switch (type) {
                case MembershipActionType.SendDelayedEvent:
                case MembershipActionType.SendJoinEvent:
                    return Status.Connecting;
                case MembershipActionType.UpdateExpiry: // where no delayed events
                    return Status.Connected;
                case MembershipActionType.SendScheduledDelayedLeaveEvent:
                case MembershipActionType.SendLeaveEvent:
                    return Status.Disconnecting;
                default:
                // pass through as not expected
            }
        } else if (actions.length === 2) {
            const types = actions.map((a) => a.type);
            // normal state for connected with delayed events
            if (
                (types.includes(MembershipActionType.RestartDelayedEvent) ||
                    (types.includes(MembershipActionType.SendDelayedEvent) && this.state.hasMemberStateEvent)) &&
                types.includes(MembershipActionType.UpdateExpiry)
            ) {
                return Status.Connected;
            }
        } else if (actions.length === 3) {
            const types = actions.map((a) => a.type);
            // It is a correct connected state if we already schedule the next Restart but have not yet cleaned up
            // the current restart.
            if (
                types.filter((t) => t === MembershipActionType.RestartDelayedEvent).length === 2 &&
                types.includes(MembershipActionType.UpdateExpiry)
            ) {
                return Status.Connected;
            }
        }

        if (!this.scheduler.running) {
            return Status.Disconnected;
        }

        this.logger.error("MembershipManager has an unknown state. Actions: ", actions);
        return Status.Unknown;
    }

    public get probablyLeft(): boolean {
        return this.state.probablyLeft;
    }
}

/**
 * Implementation of the Membership manager that uses sticky events
 * rather than state events.
 */
export class StickyEventMembershipManager extends MembershipManager {
    public constructor(
        joinConfig: (SessionConfig & MembershipConfig) | undefined,
        room: Pick<Room, "getLiveTimeline" | "roomId" | "getVersion">,
        private readonly clientWithSticky: MembershipManagerClient &
            Pick<MatrixClient, "_unstable_sendStickyEvent" | "_unstable_sendStickyDelayedEvent">,
        sessionDescription: SlotDescription,
        parentLogger?: Logger,
    ) {
        super(joinConfig, room, clientWithSticky, sessionDescription, parentLogger);
    }

    protected clientSendDelayedDisconnectMembership: () => Promise<SendDelayedEventResponse> = () =>
        this.clientWithSticky._unstable_sendStickyDelayedEvent(
            this.room.roomId,
            MEMBERSHIP_STICKY_DURATION_MS,
            { delay: this.delayedLeaveEventDelayMs },
            null,
            EventType.RTCMembership,
            { msc4354_sticky_key: this.memberId },
        );

    protected clientSendMembership: (
        myMembership: RtcMembershipData | SessionMembershipData | EmptyObject,
    ) => Promise<ISendEventResponse> = (myMembership) => {
        return this.clientWithSticky._unstable_sendStickyEvent(
            this.room.roomId,
            MEMBERSHIP_STICKY_DURATION_MS,
            null,
            EventType.RTCMembership,
            { ...myMembership, msc4354_sticky_key: this.memberId },
        );
    };

    private static nameMap = new Map([
        ["sendStateEvent", "_unstable_sendStickyEvent"],
        ["sendDelayedStateEvent", "_unstable_sendStickyDelayedEvent"],
    ]);
    protected actionUpdateFromErrors(e: unknown, t: MembershipActionType, m: string): ActionUpdate | undefined {
        return super.actionUpdateFromErrors(e, t, StickyEventMembershipManager.nameMap.get(m) ?? "unknown");
    }

    protected makeMyMembership(expires: number): SessionMembershipData | RtcMembershipData {
        const ownMembership = this.ownMembership;

        const relationObject = ownMembership?.eventId
            ? { "m.relation": { rel_type: RelationType.Reference, event_id: ownMembership?.eventId } }
            : {};
        return {
            application: {
                type: this.slotDescription.application,
                ...(this.callIntent ? { "m.call.intent": this.callIntent } : {}),
            },
            slot_id: slotDescriptionToId(this.slotDescription),
            rtc_transports: this.rtcTransport ? [this.rtcTransport] : [],
            member: { device_id: this.deviceId, user_id: this.client.getUserId()!, id: this.memberId },
            versions: [],
            ...relationObject,
        };
    }
}
