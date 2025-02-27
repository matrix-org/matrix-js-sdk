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

import { EventType } from "../@types/event.ts";
import { UpdateDelayedEventAction } from "../@types/requests.ts";
import type { MatrixClient } from "../client.ts";
import { UnsupportedEndpointError } from "../errors.ts";
import { ConnectionError, HTTPError, MatrixError } from "../http-api/errors.ts";
import { logger as rootLogger } from "../logger.ts";
import { type Room } from "../models/room.ts";
import { defer, type IDeferred, sleep } from "../utils.ts";
import { type CallMembership, DEFAULT_EXPIRE_DURATION, type SessionMembershipData } from "./CallMembership.ts";
import { type Focus } from "./focus.ts";
import { isLivekitFocusActive } from "./LivekitFocus.ts";
import { type MembershipConfig } from "./MatrixRTCSession.ts";

const logger = rootLogger.getChild("MatrixRTCSession");
/**
 * This interface defines what a MembershipManager uses and exposes.
 * This interface is what we use to write tests and allows changing the actual implementation
 * without breaking tests because of some internal method renaming.
 *
 * @internal
 */
export interface IMembershipManager {
    /**
     * If we are trying to join, or have successfully joined the session.
     * It does not reflect if the room state is already configured to represent us being joined.
     * It only means that the Manager is running.
     * @returns true if we intend to be participating in the MatrixRTC session
     */
    isJoined(): boolean;
    /**
     * Start sending all necessary events to make this user participate in the RTC session.
     * @param fociPreferred the list of preferred foci to use in the joined RTC membership event.
     * @param fociActive the active focus to use in the joined RTC membership event.
     * @throws can throw if it exceeds a configured maximum retry.
     */
    join(fociPreferred: Focus[], fociActive?: Focus, onError?: (error: unknown) => void): void;
    /**
     * Send all necessary events to make this user leave the RTC session.
     * @param timeout the maximum duration in ms until the promise is forced to resolve.
     * @returns It resolves with true in case the leave was sent successfully.
     * It resolves with false in case we hit the timeout before sending successfully.
     */
    leave(timeout?: number): Promise<boolean>;
    /**
     * Call this if the MatrixRTC session members have changed.
     */
    onRTCSessionMemberUpdate(memberships: CallMembership[]): Promise<void>;
    /**
     * The used active focus in the currently joined session.
     * @returns the used active focus in the currently joined session or undefined if not joined.
     */
    getActiveFocus(): Focus | undefined;
}

/* SCHEDULER TYPES:

            DirectMembershipManagerAction.Join
                           ▼
                 ┌─────────────────────┐
                 │SendFirstDelayedEvent│
                 └─────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
       ┌────────────│SendJoinEvent│────────────┐
       │            └─────────────┘            │
       │  ┌─────┐                  ┌──────┐    │    ┌──────┐
       ▼  ▼     │                  │      ▼    ▼    ▼      │
┌────────────┐  │                  │ ┌───────────────────┐ │
│UpdateExpiry│  │                  │ │RestartDelayedEvent│ │
└────────────┘  │                  │ └───────────────────┘ │
          │     │                  │      │    │           │
          └─────┘                  └──────┘    │           │
                                               │           │
                 ┌────────────────────┐        │           │
                 │SendMainDelayedEvent│◄───────┘           │
                 └───────────────────┬┘                    │
                                     │                     │
                                     └─────────────────────┘
                     STOP ALL ABOVE
           DirectMembershipManagerAction.Leave
                           ▼
            ┌───────────────────────────────┐
            │ SendScheduledDelayedLeaveEvent│
            └───────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │SendLeaveEvent│
                    └──────────────┘
*/
enum MembershipActionType {
    SendFirstDelayedEvent = "SendFirstDelayedEvent",
    //  -> MembershipActionType.SendJoinEvent if successful
    //  -> DelayedLeaveActionType.SendFirstDelayedEvent on error, retry sending the first delayed event.
    SendJoinEvent = "SendJoinEvent",
    //  -> MembershipActionType.SendJoinEvent if we run into a rate limit and need to retry
    //  -> MembershipActionType.Update if we successfully send the join event then schedule the expire event update
    //  -> DelayedLeaveActionType.RestartDelayedEvent to recheck the delayed event
    RestartDelayedEvent = "RestartDelayedEvent",
    //  -> DelayedLeaveActionType.SendMainDelayedEvent on missing delay id but there is a rtc state event
    //  -> DelayedLeaveActionType.SendFirstDelayedEvent on missing delay id and there is no state event
    //  -> DelayedLeaveActionType.RestartDelayedEvent on success we schedule the next restart
    UpdateExpiry = "UpdateExpiry",
    //  -> MembershipActionType.Update if the timeout has passed so the next update is required.
    SendMainDelayedEvent = "SendMainDelayedEvent",
    //  -> DelayedLeaveActionType.RestartDelayedEvent on success start updating the delayed event
    //  -> DelayedLeaveActionType.SendMainDelayedEvent on error try again
    SendScheduledDelayedLeaveEvent = "SendScheduledDelayedLeaveEvent",
    //  -> MembershipActionType.SendLeaveEvent on failiour (not found) we need to send the leave manually and cannot use the scheduled delayed event
    //  -> DelayedLeaveActionType.SendScheduledDelayedLeaveEvent on error we try again.
    SendLeaveEvent = "SendLeaveEvent",
    // -> MembershipActionType.SendLeaveEvent
}

/**
 * Actions that are supposed to be used from outside the main handle methods.
 */
enum DirectMembershipManagerAction {
    Join = MembershipActionType.SendFirstDelayedEvent,
    Leave = MembershipActionType.SendScheduledDelayedLeaveEvent,
}
interface ActionSchedulerState {
    /** The delayId we got when successfully sending the delayed leave event.
     * Gets set to undefined if the server claims it cannot find the delayed event anymore. */
    delayId?: string;
    /** Stores how often we have update the `expires` field.
     * `expireUpdateIterations` * `membershipEventExpiryTimeout` resolves to the value the expires field should contain next */
    expireUpdateIterations: number;
    /** The time at which we send the first state event. The time the call started from the DAG point of view.
     * This is used to compute the local sleep timestamps when to next update the member event with a new expires value. */
    startTime: number;
    /** Flag that gets set once join is called.
     * The manager tries its best to get the user into the call.
     * Does not imply the user is actually joined via room state. */
    running: boolean;
    /** The manager is in the state where its actually connected to the session. */
    hasMemberStateEvent: boolean;
    // There can be multiple retries at once so we need to store counters per action
    // e.g. the send update membership and the restart delayed could be rate limited at the same time.
    /** Retry counter for rate limits */
    rateLimitRetries: Map<MembershipActionType, number>;
    /** Retry counter for other errors */
    networkErrorRetries: Map<MembershipActionType, number>;
}

interface Action {
    /**
     * When this action should be executed
     */
    ts: number;
    /**
     * The state of the different loops
     * can also be thought of as the type of the action
     */
    type: MembershipActionType | DirectMembershipManagerAction;
}

/**
 * This state machine tracks the state of the current membership participation
 * and runs one central timer that wakes up a handler callback with the correct action
 * whenever necessary.
 *
 * It can also be awakened whenever a new action is added which is
 * earlier then the current "next awake".
 * @internal
 */
class ActionScheduler {
    public state: ActionSchedulerState;
    public static get defaultState(): ActionSchedulerState {
        return {
            hasMemberStateEvent: false,
            running: false,
            startTime: 0,
            delayId: undefined,
            rateLimitRetries: new Map(),
            networkErrorRetries: new Map(),
            expireUpdateIterations: 0,
        };
    }
    public constructor(
        state: ActionSchedulerState,
        /** This is the callback called for each scheduled action (`this.addAction()`) */
        private membershipLoopHandler: (state: ActionSchedulerState, type: MembershipActionType) => Promise<void>,
    ) {
        this.state = state;
    }
    // function for the wakeup mechanism (in case we add an action externally and need to leave the current sleep)
    private wakeup?: (value: void | PromiseLike<void>) => void;

    private actions: Action[] = [];
    private insertions: Action[] = [];
    private resetWith?: Action[];
    /**
     * This starts the main loop of the membership manager that handles event sending, delayed event sending and delayed event restarting.
     * @param initialActions The initial actions the manager will start with. It should be enough to pass: DelayedLeaveActionType.Initial
     * @returns Promise that resolves once all actions have run and no more are scheduled.
     * @throws This throws an error if one of the actions throws.
     * In most other error cases the manager will try to handle any server errors by itself.
     */
    public async startWithActions(initialActions: Action[]): Promise<void> {
        this.actions = initialActions;

        while (this.actions.length > 0) {
            this.actions.sort((a, b) => a.ts - b.ts);
            const nextAction = this.actions[0];
            let didWakeUp = false;
            const wakeupPromise = new Promise<void>((resolve) => {
                this.wakeup = (): void => {
                    didWakeUp = true;
                    resolve();
                };
            });
            if (nextAction.ts > Date.now()) await Promise.race([wakeupPromise, sleep(nextAction.ts - Date.now())]);
            if (!didWakeUp) {
                logger.debug(
                    "Current MembershipManager processing: " + nextAction.type,
                    "\nQueue:",
                    this.actions,
                    "\nDate.now: " + Date.now(),
                );
                try {
                    await this.membershipLoopHandler(this.state, nextAction.type as MembershipActionType);
                } catch (e) {
                    throw Error("The MembershipManager has to shut down because of the end condition: " + e);
                }
            }

            if (this.resetWith) {
                this.actions = this.resetWith;
                this.resetWith = undefined;
            }
            this.actions = this.actions.filter((a) => a !== nextAction);

            this.actions.push(...this.insertions);
            this.insertions = [];
        }
        logger.debug("Leave MembershipManager ActionScheduler loop (no more actions)");
    }

    public addAction(action: Action): void {
        this.insertions.push(action);
        const nextTs = this.actions[0]?.ts;
        if (!nextTs || nextTs > action.ts) {
            this.wakeup?.();
        }
    }
    public resetActions(actions: Action[]): void {
        this.resetWith = actions;
        const nextTs = this.actions[0]?.ts;
        const newestTs = this.resetWith.map((a) => a.ts).sort((a, b) => a - b)[0];
        if (nextTs && newestTs && nextTs > newestTs) {
            this.wakeup?.();
        }
    }
    public resetState(): void {
        this.state = ActionScheduler.defaultState;
    }
    public resetRateLimitCounter(type: MembershipActionType): void {
        this.state.rateLimitRetries.set(type, 0);
        this.state.networkErrorRetries.set(type, 0);
    }
}

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
export class MembershipManager implements IMembershipManager {
    // PUBLIC:

    public isJoined(): boolean {
        return this.scheduler.state.running;
    }
    /**
     * Puts the MembershipManager in a state where it tries to be joined.
     * It will send delayed events and membership events
     * @param fociPreferred
     * @param focusActive
     * @param onError This will be called once the membership manager encounters an unrecoverable error.
     * This should bubble up the the frontend to communicate that the call does not work in the current environment.
     */
    public join(fociPreferred: Focus[], focusActive?: Focus, onError?: (error: unknown) => void): void {
        this.fociPreferred = fociPreferred;
        this.focusActive = focusActive;
        this.leavePromiseDefer = undefined;
        if (!this.scheduler.state.running) {
            this.scheduler.resetState();
            this.scheduler.state.running = true;
            this.scheduler
                .startWithActions([{ ts: Date.now(), type: DirectMembershipManagerAction.Join }])
                .catch((e) => {
                    logger.error("MembershipManager stopped because: ", e);
                    onError?.(e);
                });
        }
    }

    /**
     * Leave from the call (Send an rtc session event with content: `{}`)
     * @param timeout the maximum duration this promise will take to resolve
     * @returns true if it managed to leave and false if the timeout condition happened.
     */
    public leave(timeout?: number): Promise<boolean> {
        if (!this.scheduler.state.running) return Promise.resolve(true);
        this.scheduler.state.running = false;

        if (!this.leavePromiseDefer) {
            // reset scheduled actions so we will not do any new actions.
            this.scheduler.resetActions([{ type: DirectMembershipManagerAction.Leave, ts: Date.now() }]);
            this.leavePromiseDefer = defer<boolean>();
            if (timeout) setTimeout(() => this.leavePromiseDefer?.resolve(false), timeout);
        }
        return this.leavePromiseDefer.promise;
    }
    private leavePromiseDefer?: IDeferred<boolean>;

    public async onRTCSessionMemberUpdate(memberships: CallMembership[]): Promise<void> {
        const isMyMembership = (m: CallMembership): boolean =>
            m.sender === this.client.getUserId() && m.deviceId === this.client.getDeviceId();

        if (this.isJoined() && !memberships.some(isMyMembership)) {
            logger.warn("Missing own membership: force re-join");
            this.scheduler.state.hasMemberStateEvent = false;
            this.scheduler.addAction({ ts: Date.now(), type: DirectMembershipManagerAction.Join });
        }
        return Promise.resolve();
    }

    public getActiveFocus(): Focus | undefined {
        if (this.focusActive) {
            // A livekit active focus
            if (isLivekitFocusActive(this.focusActive)) {
                if (this.focusActive.focus_selection === "oldest_membership") {
                    const oldestMembership = this.getOldestMembership();
                    return oldestMembership?.getPreferredFoci()[0];
                }
            } else {
                logger.warn("Unknown own ActiveFocus type. This makes it impossible to connect to an SFU.");
            }
        } else {
            // We do not understand the membership format (could be legacy). We default to oldestMembership
            // Once there are other methods this is a hard error!
            const oldestMembership = this.getOldestMembership();
            return oldestMembership?.getPreferredFoci()[0];
        }
    }

    /**
     * @throws if the client does not return user or device id.
     * @param joinConfig
     * @param room
     * @param client
     * @param getOldestMembership
     */
    public constructor(
        private joinConfig: MembershipConfig | undefined,
        private room: Pick<Room, "getLiveTimeline" | "roomId" | "getVersion">,
        private client: Pick<
            MatrixClient,
            | "getUserId"
            | "getDeviceId"
            | "sendStateEvent"
            | "_unstable_sendDelayedStateEvent"
            | "_unstable_updateDelayedEvent"
        >,
        private getOldestMembership: () => CallMembership | undefined,
    ) {
        const [userId, deviceId] = [this.client.getUserId(), this.client.getDeviceId()];
        if (userId === null) throw Error("Missing userId in client");
        if (deviceId === null) throw Error("Missing deviceId in client");
        this.deviceId = deviceId;
        this.stateKey = this.makeMembershipStateKey(userId, deviceId);
    }

    // PRIVATE:

    // Membership Event parameters:
    private deviceId: string;
    private stateKey: string;
    private fociPreferred?: Focus[];
    private focusActive?: Focus;

    // Config:
    private membershipServerSideExpiryTimeoutOverride?: number;

    private get callMemberEventRetryDelayMinimum(): number {
        return this.joinConfig?.callMemberEventRetryDelayMinimum ?? 3_000;
    }
    private get membershipEventExpiryTimeout(): number {
        return this.joinConfig?.membershipExpiryTimeout ?? DEFAULT_EXPIRE_DURATION;
    }
    private get membershipEventExpiryTimeoutHeadroom(): number {
        return this.joinConfig?.membershipExpiryTimeoutHeadroom ?? 5_000;
    }
    private computeNextExpiryActionTs(iteration: number): number {
        return (
            this.scheduler.state.startTime +
            this.membershipEventExpiryTimeout * iteration -
            this.membershipEventExpiryTimeoutHeadroom
        );
    }
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
    private get maximumRateLimitRetryCount(): number {
        return this.joinConfig?.maximumRateLimitRetryCount ?? 10;
    }
    private get maximumNetworkErrorRetryCount(): number {
        return this.joinConfig?.maximumNetworkErrorRetryCount ?? 10;
    }

    // Scheduler:
    private scheduler = new ActionScheduler(ActionScheduler.defaultState, (state, type) =>
        this.membershipLoopHandler(state, type),
    );

    // Loop Handler:
    private async membershipLoopHandler(state: ActionSchedulerState, type: MembershipActionType): Promise<void> {
        switch (type) {
            case MembershipActionType.SendFirstDelayedEvent: {
                // Before we start we check if we come from a state where we have a delay id.
                if (!state.delayId) {
                    // Normal case without any previous delayed id.
                    await this.client
                        ._unstable_sendDelayedStateEvent(
                            this.room.roomId,
                            {
                                delay: this.membershipServerSideExpiryTimeout,
                            },
                            EventType.GroupCallMemberPrefix,
                            {}, // leave event
                            this.stateKey,
                        )
                        .then((response) => {
                            // Success we reset retries and set delayId.
                            state.rateLimitRetries.set(MembershipActionType.SendFirstDelayedEvent, 0);
                            state.networkErrorRetries.set(MembershipActionType.SendFirstDelayedEvent, 0);
                            state.delayId = response.delay_id;
                            this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendJoinEvent });
                        })
                        .catch((e) => {
                            if (this.rateLimitErrorHandler(e, "sendDelayedStateEvent", type)) return;
                            if (this.maxDelayExceededErrorHandler(e)) {
                                this.scheduler.addAction({
                                    ts: Date.now(),
                                    type: MembershipActionType.SendFirstDelayedEvent,
                                });
                                return;
                            }
                            if (this.retryOnNetworkError(e, type)) return;

                            // log and fall through
                            if (this.unsupportedDelayedEndpoint(e)) {
                                logger.info("Not using delayed event because the endpoint is not supported");
                            } else {
                                logger.info("Not using delayed event because: " + e);
                            }
                            // On any other error we fall back to not using delayed events and send the join state event immediately
                            this.scheduler.addAction({
                                ts: Date.now(),
                                type: MembershipActionType.SendJoinEvent,
                            });
                        });
                } else {
                    // This can happen if someone else (or another client) removes our own membership event.
                    // It will trigger `onRTCSessionMemberUpdate` queue `MembershipActionType.SendFirstDelayedEvent`.
                    // We might still have our delyed event from the previous participation and dependent on the serve this might not
                    // get automatically removed if the state changes. Hence It would remove our membership unexpectedly shortly after the rejoin.
                    //
                    // In this block we will try to cancel this delayed event before setting up a new one.

                    // Remove all running updates and restarts
                    this.scheduler.resetActions([]);
                    await this.client
                        ._unstable_updateDelayedEvent(state.delayId, UpdateDelayedEventAction.Cancel)
                        .then(() => {
                            state.delayId = undefined;
                            this.scheduler.resetRateLimitCounter(MembershipActionType.SendFirstDelayedEvent);
                            this.scheduler.addAction({
                                ts: Date.now(),
                                type: MembershipActionType.SendFirstDelayedEvent,
                            });
                        })
                        .catch((e) => {
                            if (this.rateLimitErrorHandler(e, "updateDelayedEvent", type)) return;
                            if (this.isNotFoundError(e)) {
                                // If we get a M_NOT_FOUND we know that the delayed event got already removed.
                                // This means we are good and can set it to undefined and run this again.
                                state.delayId = undefined;
                                this.scheduler.addAction({
                                    ts: Date.now(),
                                    type: MembershipActionType.SendFirstDelayedEvent,
                                });
                                return;
                            }
                            if (this.unsupportedDelayedEndpoint(e)) {
                                this.scheduler.addAction({
                                    ts: Date.now(),
                                    type: MembershipActionType.SendJoinEvent,
                                });
                                return;
                            }

                            if (this.retryOnNetworkError(e, type)) return;

                            // This becomes an unhandle-able error case since sth is signifciantly off if we dont hit any of the above cases
                            // when state.delayId !== undefined
                            // We do not use ignore and log this error since we would also need to reset the delayId.
                            // It is cleaner if we the frontend rejoines instead of resetting the delayId here and behaving like in the success case.
                            throw Error(
                                "We failed to cancel a delayed event where we already had a delay id with an error we cannot automatically handle",
                            );
                        });
                }
                break;
            }
            case MembershipActionType.RestartDelayedEvent: {
                if (!state.delayId) {
                    // Delay id got reset. This action was used to check if the hs canceled the delayed event when the join state got sent.
                    this.scheduler.addAction({
                        ts: Date.now(),
                        type: state.hasMemberStateEvent
                            ? MembershipActionType.SendMainDelayedEvent
                            : MembershipActionType.SendFirstDelayedEvent,
                    });
                    break;
                }
                await this.client
                    ._unstable_updateDelayedEvent(state.delayId, UpdateDelayedEventAction.Restart)
                    .then(() => {
                        this.scheduler.resetRateLimitCounter(MembershipActionType.RestartDelayedEvent);
                        this.scheduler.addAction({
                            ts: Date.now() + this.membershipKeepAlivePeriod,
                            type: MembershipActionType.RestartDelayedEvent,
                        });
                    })
                    .catch((e) => {
                        if (this.isNotFoundError(e)) {
                            state.delayId = undefined;
                            this.scheduler.addAction({
                                ts: Date.now(),
                                type: MembershipActionType.SendMainDelayedEvent,
                            });
                            return;
                        }
                        // If the HS does not support delayed events we wont reschedule.
                        if (this.unsupportedDelayedEndpoint(e)) return;

                        // TODO this also needs a test: get rate limit while checking id delayed event is scheduled
                        if (this.rateLimitErrorHandler(e, "updateDelayedEvent", type)) return;

                        if (this.retryOnNetworkError(e, type)) return;

                        // In other error cases we have no idea what is happening
                        throw Error("Could not restart delayed event, even though delayed events are supported. " + e);
                    });
                break;
            }
            case MembershipActionType.SendMainDelayedEvent: {
                await this.client
                    ._unstable_sendDelayedStateEvent(
                        this.room.roomId,
                        {
                            delay: this.membershipServerSideExpiryTimeout,
                        },
                        EventType.GroupCallMemberPrefix,
                        {}, // leave event
                        this.stateKey,
                    )
                    .then((response) => {
                        state.delayId = response.delay_id;
                        this.scheduler.resetRateLimitCounter(MembershipActionType.SendMainDelayedEvent);
                        this.scheduler.addAction({
                            ts: Date.now() + this.membershipKeepAlivePeriod,
                            type: MembershipActionType.RestartDelayedEvent,
                        });
                    })
                    .catch((e) => {
                        if (this.maxDelayExceededErrorHandler(e)) {
                            this.scheduler.addAction({
                                ts: Date.now(),
                                type: MembershipActionType.SendMainDelayedEvent,
                            });
                            return;
                        }
                        if (this.rateLimitErrorHandler(e, "sendDelayedStateEvent", type)) return;
                        // Don't do any other delayed event work if its not supported.
                        if (this.unsupportedDelayedEndpoint(e)) return;
                        // after that
                        if (this.retryOnNetworkError(e, type)) return;
                        throw Error("Could not send delayed event, even though delayed events are supported. " + e);
                    });
                break;
            }
            case MembershipActionType.SendScheduledDelayedLeaveEvent: {
                if (state.delayId) {
                    await this.client
                        ._unstable_updateDelayedEvent(state.delayId, UpdateDelayedEventAction.Send)
                        .then(() => {
                            state.hasMemberStateEvent = false;
                            this.scheduler.resetRateLimitCounter(MembershipActionType.SendScheduledDelayedLeaveEvent);
                            this.scheduler.resetActions([]);
                            this.leavePromiseDefer?.resolve(true);
                            this.leavePromiseDefer = undefined;
                        })
                        .catch((e) => {
                            if (this.isNotFoundError(e)) {
                                state.delayId = undefined;
                                this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                                return;
                            }
                            if (this.rateLimitErrorHandler(e, "updateDelayedEvent", type)) return;
                            if (this.unsupportedDelayedEndpoint(e)) return;
                            if (this.retryOnNetworkError(e, type)) return;

                            // On any other error we fall back to SendLeaveEvent (this includes hard errors from rate limiting)
                            logger.warn(
                                "Encountered unexpected error during SendScheduledDelayedLeaveEvent. Falling back to SendLeaveEvent",
                                e,
                            );
                            this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                        });
                } else {
                    this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                }
                break;
            }
            case MembershipActionType.SendJoinEvent: {
                await this.client
                    .sendStateEvent(
                        this.room.roomId,
                        EventType.GroupCallMemberPrefix,
                        this.makeMyMembership(this.membershipEventExpiryTimeout),
                        this.stateKey,
                    )
                    .then(() => {
                        state.startTime = Date.now();
                        // The next update should already use twice the membershipEventExpiryTimeout
                        this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.RestartDelayedEvent });
                        this.scheduler.addAction({
                            ts: this.computeNextExpiryActionTs(1),
                            type: MembershipActionType.UpdateExpiry,
                        });
                        state.expireUpdateIterations = 2;
                        state.hasMemberStateEvent = true;
                        this.scheduler.resetRateLimitCounter(MembershipActionType.SendJoinEvent);
                    })
                    .catch((e) => {
                        if (this.rateLimitErrorHandler(e, "sendStateEvent", type)) return;

                        // Event sending retry (different to rate limit retries)
                        if (this.retryOnNetworkError(e, type)) return;

                        throw e;
                    });
                break;
            }
            case MembershipActionType.UpdateExpiry: {
                await this.client
                    .sendStateEvent(
                        this.room.roomId,
                        EventType.GroupCallMemberPrefix,
                        this.makeMyMembership(this.membershipEventExpiryTimeout * state.expireUpdateIterations),
                        this.stateKey,
                    )
                    .then(() => {
                        // Success, we reset retries and schedule update.
                        this.scheduler.addAction({
                            ts: this.computeNextExpiryActionTs(state.expireUpdateIterations),
                            type: MembershipActionType.UpdateExpiry,
                        });
                        state.expireUpdateIterations++;
                        this.scheduler.resetRateLimitCounter(MembershipActionType.UpdateExpiry);
                    })
                    .catch((e) => {
                        if (this.rateLimitErrorHandler(e, "sendStateEvent", type)) return;

                        // Event sending retry (different to rate limit retries)
                        if (this.retryOnNetworkError(e, type)) return;

                        throw e;
                    });
                break;
            }
            case MembershipActionType.SendLeaveEvent: {
                // We are good already
                if (!state.hasMemberStateEvent) {
                    this.leavePromiseDefer?.resolve(true);
                    this.leavePromiseDefer = undefined;
                    return;
                }
                // This is only a fallback in case we do not have working delayed events support.
                // first we should try to just send the scheduled leave event
                await this.client
                    .sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, {}, this.stateKey)
                    .then(() => {
                        this.scheduler.resetRateLimitCounter(MembershipActionType.SendLeaveEvent);
                        this.scheduler.resetActions([]);
                        this.leavePromiseDefer?.resolve(true);
                        this.leavePromiseDefer = undefined;
                        state.hasMemberStateEvent = false;
                    })
                    .catch((e) => {
                        if (this.rateLimitErrorHandler(e, "sendStateEvent", type)) return;

                        // Event sending retry (different to rate limit retries)
                        if (this.retryOnNetworkError(e, type)) return;

                        throw e;
                    });
                break;
            }
        }
    }

    // HELPERS
    private makeMembershipStateKey(localUserId: string, localDeviceId: string): string {
        const stateKey = `${localUserId}_${localDeviceId}`;
        if (/^org\.matrix\.msc(3757|3779)\b/.exec(this.room.getVersion())) {
            return stateKey;
        } else {
            return `_${stateKey}`;
        }
    }
    /**
     * Constructs our own membership
     */
    private makeMyMembership(expires: number): SessionMembershipData {
        return {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: this.deviceId,
            expires,
            focus_active: { type: "livekit", focus_selection: "oldest_membership" },
            foci_preferred: this.fociPreferred ?? [],
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
    private maxDelayExceededErrorHandler(error: unknown): boolean {
        if (
            error instanceof MatrixError &&
            error.errcode === "M_UNKNOWN" &&
            error.data["org.matrix.msc4140.errcode"] === "M_MAX_DELAY_EXCEEDED"
        ) {
            const maxDelayAllowed = error.data["org.matrix.msc4140.max_delay"];
            if (typeof maxDelayAllowed === "number" && this.membershipServerSideExpiryTimeout > maxDelayAllowed) {
                this.membershipServerSideExpiryTimeoutOverride = maxDelayAllowed;
            }
            logger.warn("Retry sending delayed disconnection event due to server timeout limitations:", error);
            return true;
        }
        return false;
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
    private rateLimitErrorHandler(error: unknown, method: string, type: MembershipActionType): boolean {
        // "Is rate limit"-boundary
        if (!(error instanceof HTTPError && error.isRateLimitError())) {
            return false;
        }

        // retry boundary
        const rateLimitRetries = this.scheduler.state.rateLimitRetries.get(type) ?? 0;
        if (rateLimitRetries < this.maximumRateLimitRetryCount) {
            let resendDelay: number;
            const defaultMs = 5000;
            try {
                resendDelay = error.getRetryAfterMs() ?? defaultMs;
                logger.info(`Rate limited by server, retrying in ${resendDelay}ms`);
            } catch (e) {
                logger.warn(
                    `Error while retrieving a rate-limit retry delay, retrying after default delay of ${defaultMs}`,
                    e,
                );
                resendDelay = defaultMs;
            }
            this.scheduler.state.rateLimitRetries.set(type, rateLimitRetries + 1);
            this.scheduler.addAction({ ts: Date.now() + resendDelay, type });
            return true;
        }

        throw Error("Exceeded maximum retries for " + type + " attempts (client." + method + "): " + (error as Error));
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
    private retryOnNetworkError(error: unknown, type: MembershipActionType): boolean {
        // "Is a network error"-boundary
        const retries = this.scheduler.state.networkErrorRetries.get(type) ?? 0;
        const retryDurationString = this.callMemberEventRetryDelayMinimum / 1000 + "s";
        const retryCounterString = "(" + retries + "/" + this.maximumNetworkErrorRetryCount + ")";
        if (error instanceof Error && error.name === "AbortError") {
            logger.warn(
                "Network local timeout error while sending event, retrying in " +
                    retryDurationString +
                    " " +
                    retryCounterString,
                error,
            );
        } else if (error instanceof ConnectionError) {
            logger.warn(
                "Network connection error while sending event, retrying in " +
                    retryDurationString +
                    " " +
                    retryCounterString,
                error,
            );
        } else if (
            error instanceof HTTPError &&
            typeof error.httpStatus === "number" &&
            error.httpStatus >= 500 &&
            error.httpStatus < 600
        ) {
            logger.warn(
                "Server error while sending event, retrying in " + retryDurationString + " " + retryCounterString,
                error,
            );
        } else {
            return false;
        }

        // retry boundary
        if (retries < this.maximumNetworkErrorRetryCount) {
            this.scheduler.state.networkErrorRetries.set(type, retries + 1);
            this.scheduler.addAction({ ts: Date.now() + this.callMemberEventRetryDelayMinimum, type });
            return true;
        }

        // Failiour
        throw Error(
            "Reached maximum (" + this.maximumNetworkErrorRetryCount + ") retries cause by: " + (error as Error),
        );
    }

    /**
     * Check if its an UnsupportedEndpointError and which implies that we cannot do any delayed event logic
     * @param error The error to check
     * @returns true it its an UnsupportedEndpointError
     */
    private unsupportedDelayedEndpoint(error: unknown): boolean {
        return error instanceof UnsupportedEndpointError;
    }
}
