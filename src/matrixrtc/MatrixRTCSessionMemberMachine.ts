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

import { logger } from "../logger.ts";
import {
    EventTimeline,
    EventType,
    HTTPError,
    MatrixClient,
    MatrixError,
    MatrixEvent,
    Room,
    UpdateDelayedEventAction,
} from "../matrix.ts";
import { sleep } from "../utils.ts";
import { checkSessionsMembershipData, DEFAULT_EXPIRE_DURATION, SessionMembershipData } from "./CallMembership.ts";
import { Focus } from "./focus.ts";
import { JoinSessionMemberConfig } from "./MatrixRTCSession.ts";

interface MemberMachineInterface {
    start: () => void;
    stop: () => void;
    running: boolean;
}

class TimeoutLoopState {
    public constructor() {}
    public promise?: Promise<void>;
    public running: boolean = false;
    public timeout?: ReturnType<typeof setTimeout>;
    public start(): void {
        this.running = true;
    }
    public async stop(): Promise<void> {
        this.running = false;
        await this.promise;
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = undefined;
    }
}

/**
 * A machine that takes care of this users memberhsip.
 * It is running a set of restart loops that make sure the member stays connected.
 * It can be started (this will send all necessary events to join and stay connected)
 * And stopped, which will send all the leave events and stop all async loops.
 */
export class MatrixRTCSessionMemberMachine implements MemberMachineInterface {
    // CONFIG:
    private membershipExpiryTimeout: number;
    private callMemberEventRetryDelayMinimum: number;
    /**
     * If the server disallows the configured {@link membershipServerSideExpiryTimeout},
     * this stores a delay that the server does allow.
     */
    private membershipLeaveServerSideDelayTimeoutOverride?: number;
    // TODO: maybe this is enough. we dont need the overwrite but just overwrite this value if we get instructions to
    // do so from the server.
    private membershipServerSideExpiryTimeoutConfig: number;
    private get membershipServerSideExpiryTimeout(): number {
        return this.membershipLeaveServerSideDelayTimeoutOverride ?? this.membershipServerSideExpiryTimeoutConfig;
    }

    // STATE:
    private disconnectDelayId?: string;

    private memberEventUpdateLoopState = new TimeoutLoopState();
    private leaveDelayRestartLoopState = new TimeoutLoopState();

    private isRunning: boolean = false;
    // MATRIX
    private client: MatrixClient;

    public constructor(
        private room: Room,
        config?: JoinSessionMemberConfig,
        public ownFociPreferred?: Focus[],
        public ownFocusActive?: Focus,
    ) {
        this.client = room.client;
        this.membershipExpiryTimeout = config?.membershipExpiryTimeout ?? DEFAULT_EXPIRE_DURATION;
        this.callMemberEventRetryDelayMinimum = config?.callMemberEventRetryDelayMinimum ?? 3_000;
        this.membershipServerSideExpiryTimeoutConfig = config?.membershipServerSideExpiryTimeout ?? 8_000;
    }

    // ACTIONS:
    // Each action runs as a async loop.
    // The associated scheduleNext.. methods have to be designed so that they
    // can be called as often as the user wants to but only maintain one recursion loop.

    // -- LeaveDelayRestart Loop
    private async startLeaveDelayRestartLoop(): Promise<void> {
        // ignore start calls if already running
        if (this.leaveDelayRestartLoopState.running) return;

        this.leaveDelayRestartLoopState.start();
        while (this.leaveDelayRestartLoopState.running) {
            await sleep(this.callMemberEventRetryDelayMinimum);
            // It could have been stopped while the timeout was running
            if (this.leaveDelayRestartLoopState.running) {
                this.leaveDelayRestartLoopState.promise = this.sendDelayRestart();
            }
            await this.leaveDelayRestartLoopState.promise;
        }
    }

    private async sendDelayRestart(): Promise<void> {
        if (this.disconnectDelayId === undefined) {
            // dont await this so we dont lock ourselves with the `leaveDelayRestartLoopState.promise`
            void this.leaveDelayRestartLoopState.stop();
            return;
        }
        try {
            const knownDisconnectDelayId = this.disconnectDelayId;
            await resendIfRateLimited(() =>
                this.client._unstable_updateDelayedEvent(knownDisconnectDelayId, UpdateDelayedEventAction.Restart),
            );
        } catch (e) {
            if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") {
                // This is hopefully unreachable code. If we use sendMembershipEventWithLeave we should not reach this without a delayed leave.
                // This is only if other code updates state and we might loose our delayed event as a consequence.
                // This would then reschedule the leave event if the new state still looks like a SessionMembership
                // If we get a M_NOT_FOUND we prepare a new delayed event.
                // In other error cases we do not want to prepare anything since we do not have the guarantee, that the
                // future isnt still running.
                logger.warn("Failed to update delayed disconnection event, prepare it again:", e);
                this.disconnectDelayId = undefined;
                // dont await this so we dont lock ourselves with the `leaveDelayRestartLoopState.promise`
                void this.leaveDelayRestartLoopState.stop();
                if (checkSessionsMembershipData(this.getCurrentMemberEvent().getContent())) {
                    // If we are connected but are missing the delayed event recreate it.
                    try {
                        logger.info("Recreating delayed event because it was not found but we are still connected.");
                        this.prepareDelayedDisconnection(this.makeMembershipStateKey());
                    } catch (err) {
                        logger.error("Could not prepare delayed disconnection after it was M_NOT_FOUND:", err);
                    }
                }
            }
        }
    }

    // -- MembershipEventUpdate Loop
    private async startMemberEventUpdateLoop(): Promise<void> {
        // ignore start calls if already running
        if (this.memberEventUpdateLoopState.running) return;

        this.memberEventUpdateLoopState.start();
        while (this.memberEventUpdateLoopState.running) {
            await sleep(this.membershipExpiryTimeout);
            try {
                await this.updateCallMembershipToNotExpire();
            } catch (e) {
                logger.error("Could not update membership expiry because:", e);
            }
        }
    }

    /**
     * @throws if it could not get the room state or the state key
     */
    private getCurrentMemberEvent(): MatrixEvent {
        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        const stateKey = this.makeMembershipStateKey();
        if (!roomState) throw new Error("Couldn't get room state for room " + this.room.roomId);
        const event = roomState.events.get(EventType.GroupCallMemberPrefix)?.get(stateKey);
        if (!event) throw new Error("Couldn't get member event " + this.room.roomId);
        return event;
    }

    /**
     * This method resends the call membership with an updated expires time.
     * This is not used to update the content.
     * Use `sendMembershipEventWithLeave` directly to update the content of the call member.
     *
     * @throws if it could not get the required data to update the memeberhsip
     */
    private async updateCallMembershipToNotExpire(): Promise<void> {
        const event = this.getCurrentMemberEvent();
        const oldContent = event.getContent() as SessionMembershipData;
        const newContent = {
            ...oldContent,
            expires: oldContent.expires ?? this.membershipExpiryTimeout + this.membershipExpiryTimeout,
        };
        await this.sendMembershipEventWithLeave(newContent);
    }
    private prepareDelayedDisconnection = async (stateKey: string): Promise<void> => {
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
                if (typeof maxDelayAllowed === "number" && this.membershipServerSideExpiryTimeout > maxDelayAllowed) {
                    this.membershipLeaveServerSideDelayTimeoutOverride = maxDelayAllowed;
                    return this.prepareDelayedDisconnection(stateKey);
                }
            }
            logger.error("Failed to prepare delayed disconnection event:", e);
        }
    };
    /**
     * This sends a rtc membership event with the specified content.
     * It does all the necessary setup and cleanup for the delayed leave events
     *  - Sends the delayed leave event
     *  - Resends the event if sending the actual state canceled it
     *    (See: MSC4140, where sending state doesn't cancel delayed events with the same type and key.)
     *  - Checks if it needs to schedule a new delayed leave based on tracking `this.disconnectDelayId`
     *  - Does rate limit checks on all requests and retries if necessary.
     * @param content The new content for the existing or newly created call membership.
     */
    private async sendMembershipEventWithLeave(content: SessionMembershipData): Promise<void> {
        const stateKey = this.makeMembershipStateKey();

        // First setup the leave event if we do not already have one running
        const prevDisconnectDelayId = this.disconnectDelayId;
        if (this.disconnectDelayId === undefined) {
            await this.prepareDelayedDisconnection(stateKey);
        }
        // Send the new state content event _after_ a delayed disconnection event is set up.
        await resendIfRateLimited(() =>
            this.client.sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, content, stateKey),
        );
        if (this.disconnectDelayId !== undefined) {
            // If there was already a previous delay disconnection event we tracked, stop that first.
            if (prevDisconnectDelayId && prevDisconnectDelayId !== this.disconnectDelayId) {
                await this.leaveDelayRestartLoopState.stop();
                await resendIfRateLimited(() =>
                    this.client._unstable_updateDelayedEvent(prevDisconnectDelayId, UpdateDelayedEventAction.Cancel),
                );
            }
            // If sending state cancels your own delayed state, prepare another delayed state
            // TODO: Remove this once MSC4140 is stable & doesn't cancel own delayed state
            try {
                await resendIfRateLimited(() =>
                    this.client._unstable_updateDelayedEvent(this.disconnectDelayId!, UpdateDelayedEventAction.Restart),
                );
            } catch (e) {
                if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") {
                    // If we get a M_NOT_FOUND we prepare a new delayed event.
                    // In other error cases we do not want to prepare anything since we do not have the guarantee, that the
                    // future is not still running.
                    logger.warn("Failed to update delayed disconnection event, prepare it again:", e);
                    this.disconnectDelayId = undefined;
                    await this.prepareDelayedDisconnection(stateKey);
                }
            }
        }
        // At this point we should
        // - have created a this.disconnectDelayId
        // - created the delayed leave event
        // - have stopped all running delay loops if necessary so that starting can have
        //   an effect if required. (It is possible that we dont need to start a new loop then this is a no-op)
        if (this.disconnectDelayId !== undefined) {
            // There can only ever be one restart loop running
            this.startLeaveDelayRestartLoop();
        }
    }

    // METHODS:
    /**
     * @throws Could not get local deviceId
     * Constructs our own membership
     */
    private makeMyMembership(): SessionMembershipData {
        const deviceId = this.client.getDeviceId();
        if (!deviceId) throw Error("Could not get local deviceId to create membership");
        return {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: deviceId,
            expires: this.membershipExpiryTimeout,
            focus_active: { type: "livekit", focus_selection: "oldest_membership" },
            foci_preferred: this.ownFociPreferred ?? [],
        };
    }

    /**
     * @throws {Error} if it is not possible to get the userId or deviceId from the client
     * @returns The state key formatted for a `m.rtc.member` state event. `${localUserId}_${localDeviceId}`
     */
    private makeMembershipStateKey(): string {
        const localUserId = this.client.getUserId();
        const localDeviceId = this.client.getDeviceId();
        if (!localUserId || !localDeviceId) throw new Error("User ID or device ID was null!");

        const stateKey = `${localUserId}_${localDeviceId}`;
        if (/^org\.matrix\.msc(3757|3779)\b/.exec(this.room.getVersion())) {
            return stateKey;
        } else {
            return `_${stateKey}`;
        }
    }

    /**
     * Sends a leave event for this users rtc membership.
     *  - It tries to use the delayed leave events send action.
     *  - It stops the running delay restart loops
     *  - It falls back sending a normal empty state event if sending the delayed leave fails.
     */
    private async sendLeaveEvent(): Promise<void> {
        let sentDelayedDisconnect = false;
        // Stop any state event resending:
        await this.memberEventUpdateLoopState.stop();
        if (this.disconnectDelayId !== undefined) {
            try {
                await resendIfRateLimited(() =>
                    this.client._unstable_updateDelayedEvent(this.disconnectDelayId!, UpdateDelayedEventAction.Send),
                );
                sentDelayedDisconnect = true;
            } catch (e) {
                logger.error("Failed to send our delayed disconnection event:", e);
            }
            // The restart loop will stop if we do not track a disconnectDelayId anymore
            this.disconnectDelayId = undefined;
            // Manually stop the loop for good tone.
            this.leaveDelayRestartLoopState.stop();
        }
        if (!sentDelayedDisconnect) {
            await resendIfRateLimited(() =>
                this.client.sendStateEvent(
                    this.room.roomId,
                    EventType.GroupCallMemberPrefix,
                    {}, // leave state content
                    this.makeMembershipStateKey(),
                ),
            );
        }
    }
    /**
     * This sends a call join event and also a delayed leave event.
     * It starts (indirectly) two async loops:
     *  - resending the member event when it expires.
     *  - sending the delayed events restart update action to stay connected.
     */
    private async sendJoinEventWithRestartLoops(): Promise<void> {
        try {
            const content = this.makeMyMembership();
            await this.sendMembershipEventWithLeave(content);
            this.startMemberEventUpdateLoop();
        } catch (e) {
            logger.error("Failed to join the call, ", e);
        }
    }

    /**
     * Start the MemberMachine. This will make the user Join and stay connected by:
     *  - Sending the join membership event
     *  - Sending the delayed leave event
     *  - updating the delayed leave event
     *  - updating the membership when it expires
     *
     * NOTE: There are two expiration mechanisms.
     * Delayed events for a short feedback loop (~10s) So a user disconnects when loosing connection.
     * An expiration field in the state event that that clients use to determine if a state event is expired.
     * The second (passive) expiration relies on resending the event every ~5h with an updated expiration time.
     * It is only necessary on homeservers that do not support delayed events.
     */
    public start: () => Promise<void> = async () => {
        this.isRunning = true;
        await this.sendJoinEventWithRestartLoops();
    };
    /**
     * Stopt this MemberMachine by sending a leave and canceling all timers.
     */
    public stop: () => Promise<void> = async () => {
        await this.memberEventUpdateLoopState.stop();
        const ev = this.getCurrentMemberEvent();
        if (checkSessionsMembershipData(ev.getContent())) {
            // we are still connected
            await this.sendLeaveEvent();
            return;
        }
        // not connected
        if (this.disconnectDelayId === undefined) return;
        try {
            await resendIfRateLimited(() =>
                this.client._unstable_updateDelayedEvent(this.disconnectDelayId!, UpdateDelayedEventAction.Cancel),
            );
        } catch (e) {
            logger.error("Failed to send our delayed disconnection event:", e);
        }
        // The restart loop will stop if we do not track a disconnectDelayId anymore
        this.disconnectDelayId = undefined;
        // Manually stop the loop for good tone.
        await this.leaveDelayRestartLoopState.stop();
        this.isRunning = false;
    };
    public get running(): boolean {
        return this.isRunning;
    }
}

// HELPER:
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
