import { logger as rootLogger } from "../logger.ts";
import { type EmptyObject } from "../matrix.ts";
import { sleep } from "../utils.ts";
import { MembershipActionType } from "./NewMembershipManager.ts";

const logger = rootLogger.getChild("MatrixRTCSession");

/**
 * @internal
 */
export interface ActionSchedulerState {
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
/** @internal */
export interface Action {
    /**
     * When this action should be executed
     */
    ts: number;
    /**
     * The state of the different loops
     * can also be thought of as the type of the action
     */
    type: MembershipActionType;
}
/** @internal */
export type ActionUpdate =
    | {
          /** Replace all existing scheduled actions with this new array */
          replace: Action[];
      }
    | {
          /** Add these actions to the existing scheduled actions */
          insert: Action[];
      }
    | EmptyObject;

enum Status {
    Disconnected = "Disconnected",
    Connecting = "Connecting",
    ConnectingFailed = "ConnectingFailed",
    Connected = "Connected",
    Reconnecting = "Reconnecting",
    Disconnecting = "Disconnecting",
    Stuck = "Stuck",
    Unknown = "Unknown",
}

/**
 * This scheduler tracks the state of the current membership participation
 * and runs one central timer that wakes up a handler callback with the correct action + state
 * whenever necessary.
 *
 * It can also be awakened whenever a new action is added which is
 * earlier then the current "next awake".
 * @internal
 */
export class ActionScheduler {
    public state: ActionSchedulerState;
    public static get defaultState(): ActionSchedulerState {
        return {
            hasMemberStateEvent: false,
            running: false,
            delayId: undefined,

            startTime: 0,
            rateLimitRetries: new Map(),
            networkErrorRetries: new Map(),
            expireUpdateIterations: 1,
        };
    }
    public constructor(
        state: ActionSchedulerState,
        /** This is the callback called for each scheduled action (`this.addAction()`) */
        private membershipLoopHandler: (
            state: ActionSchedulerState,
            type: MembershipActionType,
        ) => Promise<ActionUpdate>,
    ) {
        this.state = state;
    }
    // function for the wakeup mechanism (in case we add an action externally and need to leave the current sleep)
    private wakeup: (update: ActionUpdate) => void = (update: ActionUpdate): void => {
        logger.error("Cannot call wakeup before calling `startWithJoin()`");
    };
    private _actions: Action[] = [];
    public get actions(): Action[] {
        return this._actions;
    }

    /**
     * This starts the main loop of the membership manager that handles event sending, delayed event sending and delayed event restarting.
     * @param initialActions The initial actions the manager will start with. It should be enough to pass: DelayedLeaveActionType.Initial
     * @returns Promise that resolves once all actions have run and no more are scheduled.
     * @throws This throws an error if one of the actions throws.
     * In most other error cases the manager will try to handle any server errors by itself.
     */
    public async startWithJoin(): Promise<void> {
        this._actions = [{ ts: Date.now(), type: MembershipActionType.SendFirstDelayedEvent }];

        while (this._actions.length > 0) {
            // Sort so next (smallest ts) action is at the beginning
            this._actions.sort((a, b) => a.ts - b.ts);
            const nextAction = this._actions[0];
            let wakeupUpdate: ActionUpdate | undefined = undefined;

            // while we await for the next action, wakeup has to resolve the wakeupPromise
            const wakeupPromise = new Promise<void>((resolve) => {
                this.wakeup = (update: ActionUpdate): void => {
                    wakeupUpdate = update;
                    resolve();
                };
            });
            if (nextAction.ts > Date.now()) await Promise.race([wakeupPromise, sleep(nextAction.ts - Date.now())]);

            const oldStatus = this.status;
            logger.info(`MembershipManager ActionScheduler awakened. status=${oldStatus}`);

            let handlerResult: ActionUpdate = {};
            if (!wakeupUpdate) {
                logger.debug(
                    `Current MembershipManager processing: ${nextAction.type}\nQueue:`,
                    this._actions,
                    `\nDate.now: "${Date.now()}`,
                );
                try {
                    // `this.wakeup` can also be called and sets the `wakupUpdate` object while we are in the handler.
                    handlerResult = await this.membershipLoopHandler(
                        this.state,
                        nextAction.type as MembershipActionType,
                    );
                } catch (e) {
                    throw Error(`The MembershipManager shut down because of the end condition: ${e}`);
                }
            }
            // remove the processed action only after we are done processing
            this._actions.splice(0, 1);
            // The wakeupUpdate always wins since that is a direct external update.
            const actionUpdate = wakeupUpdate ?? handlerResult;

            if ("replace" in actionUpdate) {
                this._actions = actionUpdate.replace;
            } else if ("insert" in actionUpdate) {
                this._actions.push(...actionUpdate.insert);
            }

            logger.info(
                `MembershipManager ActionScheduler applied action changes. Status: ${oldStatus} -> ${this.status}`,
            );
        }
        logger.debug("Leave MembershipManager ActionScheduler loop (no more actions)");
    }

    public initiateJoin(): void {
        this.wakeup?.({ replace: [{ ts: Date.now(), type: MembershipActionType.SendFirstDelayedEvent }] });
    }
    public initiateLeave(): void {
        this.wakeup?.({ replace: [{ ts: Date.now(), type: MembershipActionType.SendScheduledDelayedLeaveEvent }] });
    }

    public resetState(): void {
        this.state = ActionScheduler.defaultState;
    }

    public resetRateLimitCounter(type: MembershipActionType): void {
        this.state.rateLimitRetries.set(type, 0);
        this.state.networkErrorRetries.set(type, 0);
    }

    public get status(): Status {
        if (this.actions.length === 1) {
            const { type } = this.actions[0];
            switch (type) {
                case MembershipActionType.SendFirstDelayedEvent:
                case MembershipActionType.SendJoinEvent:
                case MembershipActionType.SendMainDelayedEvent:
                    return Status.Connecting;
                case MembershipActionType.UpdateExpiry: // where no delayed events
                    return Status.Connected;
                case MembershipActionType.SendScheduledDelayedLeaveEvent:
                case MembershipActionType.SendLeaveEvent:
                    return Status.Disconnecting;
                default:
                // pass through as not expected
            }
        } else if (this.actions.length === 2) {
            const types = this.actions.map((a) => a.type);
            // normal state for connected with delayed events
            if (
                (types.includes(MembershipActionType.RestartDelayedEvent) ||
                    types.includes(MembershipActionType.SendMainDelayedEvent)) &&
                types.includes(MembershipActionType.UpdateExpiry)
            ) {
                return Status.Connected;
            }
        } else if (this.actions.length === 3) {
            const types = this.actions.map((a) => a.type);
            // It is a correct connected state if we already schedule the next Restart but have not yet cleaned up
            // the current restart.
            if (
                types.filter((t) => t === MembershipActionType.RestartDelayedEvent).length === 2 &&
                types.includes(MembershipActionType.UpdateExpiry)
            ) {
                return Status.Connected;
            }
        }

        if (!this.state.running) {
            return Status.Disconnected;
        }

        logger.error("MembershipManager has an unknown state. Actions: ", this.actions);
        return Status.Unknown;
    }
}
