import { logger as rootLogger } from "../logger.ts";
import { type EmptyObject } from "../matrix.ts";
import { sleep } from "../utils.ts";
import { MembershipActionType } from "./NewMembershipManager.ts";

const logger = rootLogger.getChild("MatrixRTCSession");

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
    public running = false;

    public constructor(
        /** This is the callback called for each scheduled action (`this.addAction()`) */
        private membershipLoopHandler: (type: MembershipActionType) => Promise<ActionUpdate>,
    ) {}

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
        if (this.running) {
            logger.error("Cannot call startWithJoin() on NewMembershipActionScheduler while already running");
            return;
        }
        this.running = true;
        this._actions = [{ ts: Date.now(), type: MembershipActionType.SendFirstDelayedEvent }];
        try {
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

                let handlerResult: ActionUpdate = {};
                if (!wakeupUpdate) {
                    logger.debug(
                        `Current MembershipManager processing: ${nextAction.type}\nQueue:`,
                        this._actions,
                        `\nDate.now: "${Date.now()}`,
                    );
                    try {
                        // `this.wakeup` can also be called and sets the `wakupUpdate` object while we are in the handler.
                        handlerResult = await this.membershipLoopHandler(nextAction.type as MembershipActionType);
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
            }
        } catch (e) {
            // Set the rtc session "not running" state since we cannot recover from here and the consumer user of the
            // MatrixRTCSession class needs to manually rejoin.
            this.running = false;
            throw e;
        }
        this.running = false;

        logger.debug("Leave MembershipManager ActionScheduler loop (no more actions)");
    }

    public initiateJoin(): void {
        this.wakeup?.({ replace: [{ ts: Date.now(), type: MembershipActionType.SendFirstDelayedEvent }] });
    }
    public initiateLeave(): void {
        this.wakeup?.({ replace: [{ ts: Date.now(), type: MembershipActionType.SendScheduledDelayedLeaveEvent }] });
    }
}
