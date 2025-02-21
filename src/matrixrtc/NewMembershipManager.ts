import { EventType } from "../@types/event.ts";
import { UpdateDelayedEventAction } from "../@types/requests.ts";
import type { MatrixClient } from "../client.ts";
import { HTTPError, MatrixError } from "../http-api/errors.ts";
import { logger } from "../logger.ts";
import { type Room } from "../models/room.ts";
import { sleep } from "../utils.ts";
import { type CallMembership, DEFAULT_EXPIRE_DURATION, type SessionMembershipData } from "./CallMembership.ts";
import { type Focus } from "./focus.ts";
import { isLivekitFocusActive } from "./LivekitFocus.ts";
import { type MembershipConfig } from "./MatrixRTCSession.ts";

/**
 * This interface defines what a MembershipManager uses and exposes.
 * This interface is what we use to write tests and allows to change the actual implementation
 * Without breaking tests because of some internal method renaming.
 *
 * @internal
 */
export interface IMembershipManager {
    /**
     * If we are trying to join the session.
     * It does not reflect if the room state is already configures to represent us being joined.
     * It only means that the Manager is running.
     * @returns true if we intend to be participating in the MatrixRTC session
     */
    isJoined(): boolean;
    /**
     * Start sending all necessary events to make this user participant in the RTC session.
     * @param fociPreferred the list of preferred foci to use in the joined RTC membership event.
     * @param fociActive the active focus to use in the joined RTC membership event.
     * @throws can throw if it exceeds a configured maximum retry.
     */
    join(fociPreferred: Focus[], fociActive?: Focus): Promise<void>;
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

// SCHEDULER TYPES:
enum MembershipActionType {
    SendJoinEvent = "SendJoinEvent",
    //  -> MembershipActionType.SendJoinEvent if we run in a rate limit and need to retry
    //  -> MembershipActionType.Update if we successfully send it to schedule the expire event update
    //  -> DelayedLeaveActionType.RestartDelayedEvent to recheck the delayed event
    Update = "Update",
    //  -> MembershipActionType.Update if the timeout has passed so the next update is required.
    SendLeaveEvent = "SendLeaveEvent", // -> MembershipActionType.SendLeaveEvent
}
function isMembershipActionType(val: any): val is MembershipActionType {
    return val in MembershipActionType;
}

enum DelayedLeaveActionType {
    SendFirstDelayedEvent = "SendFirstDelayedEvent",
    //  -> MembershipActionType.SendJoinEvent if successful
    //  -> DelayedLeaveActionType.SendFirstDelayedEvent on error, retry sending the first delayed event.
    SendMainDelayedEvent = "SendMainDelayedEvent",
    //  -> DelayedLeaveActionType.RestartDelayedEvent on success start updating the delayed event
    //  -> DelayedLeaveActionType.SendMainDelayedEvent on error try again
    RestartDelayedEvent = "RestartDelayedEvent",
    //  -> DelayedLeaveActionType.SendMainDelayedEvent on missing delay id but there is a rtc state event
    //  -> DelayedLeaveActionType.SendFirstDelayedEvent on missing delay id and there is no state event
    //  -> DelayedLeaveActionType.RestartDelayedEvent on success we schedule the next restart
    SendScheduledDelayedLeaveEvent = "SendScheduledDelayedLeaveEvent",
    //  -> MembershipActionType.SendLeaveEvent on failiour (not found) we need to send the leave manually and cannot use the scheduled delayed event
    //  -> DelayedLeaveActionType.SendScheduledDelayedLeaveEvent on error we try again.
}

function isDelayedLeaveActionType(val: any): val is DelayedLeaveActionType {
    return val in DelayedLeaveActionType;
}

/**
 * Actions that are supposed to be used from outside the main handle methods.
 */
enum DirectMemberhsipManagerActions {
    Join = DelayedLeaveActionType.SendFirstDelayedEvent,
    Leave = DelayedLeaveActionType.SendScheduledDelayedLeaveEvent,
}
interface ActionSchedulerState {
    /** The delayId we got when successfully sending the delayed leave event.
     * Gets set to undefined if the server claims it cannot find the delayed event anymore. */
    delayId?: string;
    /** Stores the value we want to use for the `expires` field in the next own membership update. */
    nextRelativeExpiry: number;
    /** Flag that gets set once join is called.
     * The manager tries its best to get the user into the call.
     * Does not imply the user is actually joined via room state. */
    running: boolean;
    /** The manager is in the state where its actually connected to the session. */
    hasMemberStateEvent: boolean;
    // Retry counters that get used to limit the maximum rate limit retires we want to do.
    // They get reused for each rate limit loop we run into and reset to 0 on unrecoverable failiour or success.
    sendMembershipRetries: number;
    sendDelayedEventRetries: number;
    updateDelayedEventRetries: number;
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
    type: DelayedLeaveActionType | MembershipActionType | DirectMemberhsipManagerActions;
}

/**
 * @internal
 */
class ActionScheduler {
    public state: ActionSchedulerState;

    public constructor(
        state: ActionSchedulerState,
        private manager: Pick<MembershipManager, "delayedLeaveLoopHandler" | "membershipLoopHandler">,
    ) {
        this.state = state;
    }
    // state variables for a wakeup mechanism (in case we add some action externally and need to leave the current sleep)
    private wakeupPromise?: Promise<void>;
    private wakeup?: (value: void | PromiseLike<void>) => void;
    private didWakeUp = false;

    private actions: Action[] = [];
    private insertions: Action[] = [];
    private resetWith?: Action[];
    /**
     * This starts the main loop of the memberhsip manager that handles event sending, delayed event sending and delayed event restarting.
     * @param initialActions The initial actions the manager will start with. It should be enough to pass: DelayedLeaveActionType.Initial
     * @throws This throws an error only if the memberhsip cannot run anymore. For example it reached the maximum retires.
     * In most other error cases the manager will try to handle any server errors by itself.
     */
    public async startWithActions(initialActions: Action[]): Promise<void> {
        this.actions = initialActions;

        while (this.actions.length > 0) {
            this.actions.sort((a, b) => a.ts - b.ts);
            logger.debug("Current MembershipManager action queue: ", this.actions, "\nDate.now: ", +Date.now());
            const nextAction = this.actions[0];

            this.wakeupPromise = new Promise((resolve) => {
                this.wakeup = resolve;
            });
            if (nextAction.ts > Date.now()) await Promise.race([this.wakeupPromise, sleep(nextAction.ts - Date.now())]);
            if (this.didWakeUp) {
                // In case of a wakeup we do not want to run the next action because the next action now might be sth different.
                // Instead we recompute the actions array and do another iteration.
                this.didWakeUp = false;
            } else {
                try {
                    if (isDelayedLeaveActionType(nextAction.type)) {
                        await this.manager.delayedLeaveLoopHandler(this.state, nextAction.type);
                    } else if (isMembershipActionType(nextAction.type)) {
                        await this.manager.membershipLoopHandler(this.state, nextAction.type);
                    }
                } catch (e) {
                    throw Error("The MemberhsipManager has to shut down because of the end condition: " + e);
                }
            }

            this.actions = this.actions.filter((a) => a !== nextAction);
            this.actions.push(...this.insertions);
            this.insertions = [];

            if (this.resetWith) {
                this.actions = this.resetWith;
                this.resetWith = undefined;
            }
        }
    }

    public addAction(action: Action): void {
        // Dont add any other actions if we have a leave scheduled
        if (this.actions.some((a) => a.type === DirectMemberhsipManagerActions.Leave)) return;
        this.insertions.push(action);
        if (this.actions[0].ts > action.ts) {
            this.didWakeUp = true;
            this.wakeup?.();
        }
    }
    public resetActions(actions: Action[]): void {
        this.resetWith = actions;
        const nextTs = this.actions[0]?.ts;
        const newestTs = actions.map((a) => a.ts).sort((a, b) => a - b)[0];
        if (nextTs && newestTs && nextTs > newestTs) {
            this.didWakeUp = true;
            this.wakeup?.();
        }
    }
    public hasAction(condition: (action: Action) => boolean): boolean {
        return this.actions.some(condition);
    }
}
/**
 * This Class takes care of the membership management.
 * It has the following tasks:
 *  - Send the users leave delayed event before sending the memberhsip
 *  - Sent the users membership if the state machine is started
 *  - Check if the delayed event was canceled due to sending the membership
 *  - update the delayed event (`restart`)
 *  - Update the state event every ~5h = `DEFAULT_EXPIRE_DURATION` (so it does not get treated as expired)
 *  - When the state machine is stopped:
 *   - Disconnect the member
 *   - Stop the timer for the delay refresh
 *   - Stop the timer for updateint the state event
 */

export class MembershipManager implements IMembershipManager {
    public isJoined(): boolean {
        return this.scheduler.state.running;
    }
    /**
     * @throws can throw if it exceeds a configured maximum retry.
     * @param fociPreferred
     * @param focusActive
     */
    public join(fociPreferred: Focus[], focusActive?: Focus): Promise<void> {
        this.fociPreferred = fociPreferred;
        this.focusActive = focusActive;
        if (!this.scheduler.state.running) {
            this.scheduler.state.running = true;
            return this.scheduler.startWithActions([{ ts: Date.now(), type: DirectMemberhsipManagerActions.Join }]);
        }
        return Promise.resolve();
    }

    public leave(timeout?: number): Promise<boolean> {
        this.scheduler.state.running = false;

        if (this.leavePromise && this.scheduler.hasAction((a) => a.type === DirectMemberhsipManagerActions.Leave)) {
            return this.leavePromise;
        }

        // reset scheduled actions so we will not do any new actions.
        this.scheduler.resetActions([{ type: DirectMemberhsipManagerActions.Leave, ts: Date.now() }]);
        return new Promise<boolean>((resolve, reject) => {
            this.leavePromiseHandle.reject = reject;
            this.leavePromiseHandle.resolve = resolve;
            if (timeout) setTimeout(() => resolve(false), timeout);
        });
    }
    private leavePromise?: Promise<boolean>;
    private leavePromiseHandle: {
        reject?: (reason: any) => void;
        resolve?: (didSendLeaveEvent: boolean) => void;
    } = {};

    public async onRTCSessionMemberUpdate(memberships: CallMembership[]): Promise<void> {
        const isMyMembership = (m: CallMembership): boolean =>
            m.sender === this.client.getUserId() && m.deviceId === this.client.getDeviceId();

        if (this.isJoined() && !memberships.some(isMyMembership)) {
            logger.warn("Missing own membership: force re-join");
            this.scheduler.state.hasMemberStateEvent = false;
            this.scheduler.addAction({ ts: Date.now(), type: DirectMemberhsipManagerActions.Join });
        }
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
        this.userId = userId;
        this.stateKey = this.makeMembershipStateKey(userId, deviceId);
    }

    // Membership Event parameters:
    private userId: string;
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
    private get membershipTimerExpiryTimeout(): number {
        let expiryTimeout = this.membershipEventExpiryTimeout;
        const expiryTimeoutSlack = this.joinConfig?.membershipExpiryTimeoutSlack;
        if (expiryTimeoutSlack) {
            if (expiryTimeout > expiryTimeoutSlack) {
                expiryTimeout = expiryTimeout - expiryTimeoutSlack;
            } else {
                logger.warn(
                    "The membershipExpiryTimeoutSlack is misconfigured. It cannot be less than the membershipExpiryTimeout",
                    "membershipExpiryTimeout:",
                    expiryTimeout,
                    "membershipExpiryTimeoutSlack:",
                    expiryTimeoutSlack,
                );
            }
        } else {
            // Default Slack
            expiryTimeout -= 5_000;
        }
        return Math.max(expiryTimeout, 1000);
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
        return this.joinConfig?.maximumRateLimitRetryCount ?? 5;
    }
    // Scheduler:
    private scheduler = new ActionScheduler(
        {
            hasMemberStateEvent: false,
            running: false,
            nextRelativeExpiry: this.membershipEventExpiryTimeout,
            delayId: undefined,
            sendMembershipRetries: 0,
            sendDelayedEventRetries: 0,
            updateDelayedEventRetries: 0,
        },
        this,
    );

    // Loop Handlers:
    public async delayedLeaveLoopHandler(state: ActionSchedulerState, type: DelayedLeaveActionType): Promise<void> {
        switch (type) {
            case DelayedLeaveActionType.SendFirstDelayedEvent:
                // Remove all running updates and restarts
                this.scheduler.resetActions([]);
                // Before we start we check if we come from a state where we have a delay id.
                if (state.delayId) {
                    try {
                        await this.client._unstable_updateDelayedEvent(state.delayId, UpdateDelayedEventAction.Cancel);
                        state.delayId = undefined;
                        state.updateDelayedEventRetries = 0;
                        this.scheduler.addAction({
                            ts: Date.now(),
                            type: DelayedLeaveActionType.SendFirstDelayedEvent,
                        });
                    } catch (e) {
                        this.handleRateLimitError(
                            e,
                            state.updateDelayedEventRetries,
                            (retryIn) => {
                                state.updateDelayedEventRetries++;
                                this.scheduler.addAction({
                                    ts: Date.now() + retryIn,
                                    type: DelayedLeaveActionType.SendFirstDelayedEvent,
                                });
                            },
                            () => {
                                throw Error(
                                    "Exceeded maximum delayed event update (cancel) attempts (client._unstable_updateDelayedEvent): " +
                                        e,
                                );
                            },
                        );
                        this.handleNotFoundError(e, () => {
                            // If we get a M_NOT_FOUND we know that the delayed event got already removed.
                            // This means we are good and can set it to undefined and run this again.
                            state.delayId = undefined;
                            this.scheduler.addAction({
                                ts: Date.now(),
                                type: DelayedLeaveActionType.SendFirstDelayedEvent,
                            });
                        });
                    }
                } else {
                    try {
                        const response = await this.client._unstable_sendDelayedStateEvent(
                            this.room.roomId,
                            {
                                delay: this.membershipServerSideExpiryTimeout,
                            },
                            EventType.GroupCallMemberPrefix,
                            {}, // leave event
                            this.stateKey,
                        );
                        // Success we reset retires and set delayId.
                        state.sendDelayedEventRetries = 0;
                        state.delayId = response.delay_id;
                        this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendJoinEvent });
                    } catch (e) {
                        this.handleMaxDelayeExceededError(e, () => {
                            this.scheduler.addAction({
                                ts: Date.now(),
                                type: DelayedLeaveActionType.SendFirstDelayedEvent,
                            });
                        });
                        this.handleRateLimitError(
                            e,
                            state.sendDelayedEventRetries,
                            (retryIn) => {
                                logger.warn("Retry sending delayed disconnection due to rate limit:", e);
                                state.sendDelayedEventRetries++;
                                this.scheduler.addAction({
                                    ts: Date.now() + retryIn,
                                    type: DelayedLeaveActionType.SendFirstDelayedEvent,
                                });
                            },
                            () => {
                                throw Error(
                                    "Exceeded maximum delayed event send attempts (client._unstable_sendDelayedStateEvent): " +
                                        e,
                                );
                            },
                        );
                    }
                }
                break;
            case DelayedLeaveActionType.RestartDelayedEvent:
                if (!state.delayId) {
                    // Delay id got reset. This action was used to check if the hs canceled the delayed event when the join state got sent.
                    this.scheduler.addAction({
                        ts: Date.now(),
                        type: state.hasMemberStateEvent
                            ? DelayedLeaveActionType.SendMainDelayedEvent
                            : DelayedLeaveActionType.SendFirstDelayedEvent,
                    });
                    break;
                }
                try {
                    await this.client._unstable_updateDelayedEvent(state.delayId, UpdateDelayedEventAction.Restart);
                    state.updateDelayedEventRetries = 0;
                    this.scheduler.addAction({
                        ts: Date.now() + this.membershipKeepAlivePeriod,
                        type: DelayedLeaveActionType.RestartDelayedEvent,
                    });
                } catch (e) {
                    // TODO this also needs a test: get rate limit while checking id delayed event is scheduled
                    this.handleNotFoundError(e, () => {
                        state.delayId = undefined;
                        this.scheduler.addAction({ ts: Date.now(), type: DelayedLeaveActionType.SendMainDelayedEvent });
                    });
                    this.handleRateLimitError(
                        e,
                        state.updateDelayedEventRetries,
                        (retryIn) => {
                            state.updateDelayedEventRetries++;
                            this.scheduler.addAction({
                                ts: Date.now() + retryIn,
                                type: DelayedLeaveActionType.RestartDelayedEvent,
                            });
                        },
                        () => {
                            throw Error(
                                "Exceeded maximum restart delayed event update attempts (client._unstable_updateDelayedEvent): " +
                                    e,
                            );
                        },
                    );
                }
                break;
            case DelayedLeaveActionType.SendMainDelayedEvent:
                try {
                    const response = await this.client._unstable_sendDelayedStateEvent(
                        this.room.roomId,
                        {
                            delay: this.membershipServerSideExpiryTimeout,
                        },
                        EventType.GroupCallMemberPrefix,
                        {}, // leave event
                        this.stateKey,
                    );
                    state.delayId = response.delay_id;
                    this.scheduler.addAction({
                        ts: Date.now() + this.membershipKeepAlivePeriod,
                        type: DelayedLeaveActionType.RestartDelayedEvent,
                    });
                } catch (e) {
                    this.handleMaxDelayeExceededError(e, () => {
                        this.scheduler.addAction({
                            ts: Date.now(),
                            type: DelayedLeaveActionType.SendMainDelayedEvent,
                        });
                    });
                    this.handleRateLimitError(
                        e,
                        state.sendMembershipRetries,
                        (retryIn) => {
                            logger.warn("Retry sending delayed disconnection due to rate limit:", e);
                            state.sendMembershipRetries++;
                            this.scheduler.addAction({
                                ts: Date.now() + Math.max(retryIn, this.callMemberEventRetryDelayMinimum),
                                type: DelayedLeaveActionType.SendMainDelayedEvent,
                            });
                        },
                        () => {
                            throw Error(
                                "Exceeded maximum send delayed event attempts (client._unstable_sendDelayedStateEvent): " +
                                    e,
                            );
                        },
                    );
                }
                break;
            case DelayedLeaveActionType.SendScheduledDelayedLeaveEvent:
                if (state.delayId) {
                    try {
                        await this.client._unstable_updateDelayedEvent(state.delayId, UpdateDelayedEventAction.Send);
                        state.hasMemberStateEvent = false;
                        state.updateDelayedEventRetries = 0;
                        this.scheduler.resetActions([]);
                        this.leavePromiseHandle.resolve?.(true);
                    } catch (e) {
                        const notFoundHandled = this.handleNotFoundError(e, () => {
                            state.delayId = undefined;
                            this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                        });
                        const rateLimitHandled = this.handleRateLimitError(
                            e,
                            state.updateDelayedEventRetries,
                            (retryIn) => {
                                state.updateDelayedEventRetries++;
                                this.scheduler.addAction({
                                    ts: Date.now() + retryIn,
                                    type: DelayedLeaveActionType.SendScheduledDelayedLeaveEvent,
                                });
                            },
                            () => {
                                this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                            },
                        );
                        if (!(notFoundHandled || rateLimitHandled)) {
                            this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                        }
                    }
                } else {
                    this.scheduler.addAction({ ts: Date.now(), type: MembershipActionType.SendLeaveEvent });
                }
                break;
        }
    }

    public async membershipLoopHandler(state: ActionSchedulerState, type: MembershipActionType): Promise<void> {
        switch (type) {
            case MembershipActionType.Update:
                try {
                    await this.client.sendStateEvent(
                        this.room.roomId,
                        EventType.GroupCallMemberPrefix,
                        this.makeMyMembership(state.nextRelativeExpiry),
                        this.stateKey,
                    );
                    state.nextRelativeExpiry += this.membershipEventExpiryTimeout;
                    // Success, we reset retries and schedule update.
                    state.sendMembershipRetries = 0;

                    this.scheduler.addAction({
                        ts: Date.now() + this.membershipTimerExpiryTimeout,
                        type: MembershipActionType.Update,
                    });
                } catch (e) {
                    const rateLimitHandled = this.handleRateLimitError(
                        e,
                        state.sendMembershipRetries,
                        (retryIn) => {
                            logger.warn("Retry sending membership state event due to rate limit:", e);
                            state.sendMembershipRetries++;
                            this.scheduler.addAction({
                                ts: Date.now() + Math.max(retryIn, this.callMemberEventRetryDelayMinimum),
                                type: MembershipActionType.Update,
                            });
                        },
                        () => {
                            throw Error(
                                "Exceeded maximum own Membership state update attempts (client.sendStateEvent): " + e,
                            );
                        },
                    );
                    if (!rateLimitHandled) {
                        this.scheduler.addAction({
                            ts: Date.now() + this.callMemberEventRetryDelayMinimum,
                            type: MembershipActionType.Update,
                        });
                    }
                }
                break;
            case MembershipActionType.SendJoinEvent:
                try {
                    await this.client.sendStateEvent(
                        this.room.roomId,
                        EventType.GroupCallMemberPrefix,
                        this.makeMyMembership(state.nextRelativeExpiry),
                        this.stateKey,
                    );
                    state.nextRelativeExpiry += this.membershipEventExpiryTimeout;
                    state.hasMemberStateEvent = true;
                    state.sendMembershipRetries = 0;
                    this.scheduler.addAction({ ts: Date.now(), type: DelayedLeaveActionType.RestartDelayedEvent });
                    this.scheduler.addAction({
                        ts: Date.now() + this.membershipTimerExpiryTimeout,
                        type: MembershipActionType.Update,
                    });
                } catch (e) {
                    this.handleRateLimitError(
                        e,
                        state.sendMembershipRetries,
                        (resendDelay) => {
                            state.sendMembershipRetries++;
                            this.scheduler.addAction({
                                ts: Date.now() + resendDelay,
                                type: MembershipActionType.SendJoinEvent,
                            });
                        },
                        () => {
                            throw Error(
                                "Exceeded maximum Own Membership state update attempts (client.sendStateEvent): " + e,
                            );
                        },
                    );
                }
                break;
            case MembershipActionType.SendLeaveEvent:
                // We are good already
                if (!state.hasMemberStateEvent) return;

                // This is only a fallback in case we do not have working delayed events support.
                // first we should try to just send the scheduled leave event
                try {
                    this.client.sendStateEvent(
                        this.room.roomId,
                        EventType.GroupCallMemberPrefix,
                        {},
                        this.makeMembershipStateKey(this.userId, this.deviceId),
                    );
                    state.updateDelayedEventRetries = 0;
                    this.scheduler.resetActions([]);
                    this.leavePromiseHandle.resolve?.(true);
                    state.hasMemberStateEvent = false;
                } catch (e) {
                    this.handleRateLimitError(
                        e,
                        state.sendMembershipRetries,
                        (retryIn) => {
                            this.scheduler.addAction({
                                ts: Date.now() + retryIn,
                                type: MembershipActionType.SendLeaveEvent,
                            });
                        },
                        () => {
                            throw Error("could not send final leave event due to max rate limit retries" + e);
                        },
                    );
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
    private handleNotFoundError(e: unknown, onNotFound: () => void): boolean {
        if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") {
            onNotFound();
            return true;
        }
        return false;
    }
    private handleMaxDelayeExceededError(e: unknown, didSetupDelayTimeout: () => void): boolean {
        if (
            e instanceof MatrixError &&
            e.errcode === "M_UNKNOWN" &&
            e.data["org.matrix.msc4140.errcode"] === "M_MAX_DELAY_EXCEEDED"
        ) {
            const maxDelayAllowed = e.data["org.matrix.msc4140.max_delay"];
            if (typeof maxDelayAllowed === "number" && this.membershipServerSideExpiryTimeout > maxDelayAllowed) {
                this.membershipServerSideExpiryTimeoutOverride = maxDelayAllowed;
            }
            didSetupDelayTimeout();
            logger.warn("Retry sending delayed disconnection event due to server timeout limitations:", e);
            return true;
        }
        return false;
    }

    /**
     *
     * @param e
     * @param allowedRetries
     * @param currentRetries
     * @param onRetry
     * @param onAbort
     * @returns Returns true if it did anything.
     */
    private handleRateLimitError(
        e: unknown,
        currentRetries: number,
        onRetry: (retryIn: number) => void,
        onAbort: () => void,
    ): boolean {
        if (currentRetries < this.maximumRateLimitRetryCount && e instanceof HTTPError && e.isRateLimitError()) {
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
            onRetry(resendDelay);
            return true;
        } else if (e instanceof HTTPError && e.isRateLimitError()) {
            onAbort();
            return true;
        }
        return false;
    }
}
