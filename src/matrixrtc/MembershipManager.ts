import { EventType } from "../@types/event.ts";
import { UpdateDelayedEventAction } from "../@types/requests.ts";
import type { MatrixClient } from "../client.ts";
import { HTTPError, MatrixError } from "../http-api/errors.ts";
import { logger } from "../logger.ts";
import { EventTimeline } from "../models/event-timeline.ts";
import { Room } from "../models/room.ts";
import { sleep } from "../utils.ts";
import { CallMembership, DEFAULT_EXPIRE_DURATION, SessionMembershipData } from "./CallMembership.ts";
import { Focus } from "./focus.ts";
import { isLivekitFocusActive } from "./LivekitFocus.ts";
import { MembershipConfig } from "./MatrixRTCSession.ts";

/**
 *  This internal class is used by the MatrixRTCSession to manage the local user's own membership of the session.
 *  @internal
 */
export class MembershipManager {
    private relativeExpiry: number | undefined;

    public constructor(
        private joinConfig: MembershipConfig | undefined,
        private room: Room,
        private client: MatrixClient,
        private getOldestMembership: () => CallMembership | undefined,
    ) {}
    private memberEventTimeout?: ReturnType<typeof setTimeout>;

    /**
     *   This is a Foci array that contains the Focus objects this user is aware of and proposes to use.
     */
    private ownFociPreferred?: Focus[];
    /**
     *   This is a Focus with the specified fields for an ActiveFocus (e.g. LivekitFocusActive for type="livekit")
     */
    private ownFocusActive?: Focus;

    private updateCallMembershipRunning = false;
    private needCallMembershipUpdate = false;
    /**
     * If the server disallows the configured {@link membershipServerSideExpiryTimeout},
     * this stores a delay that the server does allow.
     */
    private membershipServerSideExpiryTimeoutOverride?: number;
    private disconnectDelayId: string | undefined;

    private get callMemberEventRetryDelayMinimum(): number {
        return this.joinConfig?.callMemberEventRetryDelayMinimum ?? 3_000;
    }
    private get membershipExpiryTimeout(): number {
        return this.joinConfig?.membershipExpiryTimeout ?? DEFAULT_EXPIRE_DURATION;
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

    private get callMemberEventRetryJitter(): number {
        return this.joinConfig?.callMemberEventRetryJitter ?? 2_000;
    }

    public join(fociPreferred: Focus[], fociActive?: Focus): void {
        this.ownFocusActive = fociActive;
        this.ownFociPreferred = fociPreferred;
        this.relativeExpiry = this.membershipExpiryTimeout;
        // We don't wait for this, mostly because it may fail and schedule a retry, so this
        // function returning doesn't really mean anything at all.
        this.triggerCallMembershipEventUpdate();
    }

    public async leave(timeout: number | undefined = undefined): Promise<boolean> {
        this.relativeExpiry = undefined;
        this.ownFocusActive = undefined;

        if (this.memberEventTimeout) {
            clearTimeout(this.memberEventTimeout);
            this.memberEventTimeout = undefined;
        }
        if (timeout) {
            // The sleep promise returns the string 'timeout' and the membership update void
            // A success implies that the membership update was quicker then the timeout.
            const raceResult = await Promise.race([this.triggerCallMembershipEventUpdate(), sleep(timeout, "timeout")]);
            return raceResult !== "timeout";
        } else {
            await this.triggerCallMembershipEventUpdate();
            return true;
        }
    }

    public async onMembershipsUpdate(): Promise<void> {
        return this.triggerCallMembershipEventUpdate();
    }
        }
    }
    public triggerCallMembershipEventUpdate = async (): Promise<void> => {
        // TODO: Should this await on a shared promise?
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
    private makeNewMembership(deviceId: string): SessionMembershipData | {} {
        // If we're joined, add our own
        if (this.isJoined()) {
            return this.makeMyMembership(deviceId);
        }
        return {};
    }
    /*
     * Returns true if we intend to be participating in the MatrixRTC session.
     * This is determined by checking if the relativeExpiry has been set.
     */
    public isJoined(): boolean {
        return this.relativeExpiry !== undefined;
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
            expires: this.relativeExpiry,
            focus_active: { type: "livekit", focus_selection: "oldest_membership" },
            foci_preferred: this.ownFociPreferred ?? [],
        };
    }

    public getActiveFocus(): Focus | undefined {
        if (this.ownFocusActive && isLivekitFocusActive(this.ownFocusActive)) {
            // A livekit active focus
            if (this.ownFocusActive.focus_selection === "oldest_membership") {
                const oldestMembership = this.getOldestMembership();
                return oldestMembership?.getPreferredFoci()[0];
            }
        } else {
            // We do not understand the membership format (could be legacy). We default to oldestMembership
            // Once there are other methods this is a hard error!
            const oldestMembership = this.getOldestMembership();
            return oldestMembership?.getPreferredFoci()[0];
        }
    }
    public async updateCallMembershipEvent(): Promise<void> {
        if (this.memberEventTimeout) {
            clearTimeout(this.memberEventTimeout);
            this.memberEventTimeout = undefined;
        }

        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        if (!roomState) throw new Error("Couldn't get room state for room " + this.room.roomId);

        const localUserId = this.client.getUserId();
        const localDeviceId = this.client.getDeviceId();
        if (!localUserId || !localDeviceId) throw new Error("User ID or device ID was null!");

        let newContent: {} | SessionMembershipData = {};
        // TODO: add back expiary logic to non-legacy events
        // previously we checked here if the event is timed out and scheduled a check if not.
        // maybe there is a better way.
        newContent = this.makeNewMembership(localDeviceId);

        try {
            if (this.isJoined()) {
                const stateKey = this.makeMembershipStateKey(localUserId, localDeviceId);
                const prepareDelayedDisconnection = async (): Promise<void> => {
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
                        logger.log("BEFOER:", this.disconnectDelayId);
                        this.disconnectDelayId = res.delay_id;
                        logger.log("AFTER:", this.disconnectDelayId);
                    } catch (e) {
                        if (
                            e instanceof MatrixError &&
                            e.errcode === "M_UNKNOWN" &&
                            e.data["org.matrix.msc4140.errcode"] === "M_MAX_DELAY_EXCEEDED"
                        ) {
                            const maxDelayAllowed = e.data["org.matrix.msc4140.max_delay"];
                            if (
                                typeof maxDelayAllowed === "number" &&
                                this.membershipServerSideExpiryTimeout > maxDelayAllowed
                            ) {
                                this.membershipServerSideExpiryTimeoutOverride = maxDelayAllowed;
                                return prepareDelayedDisconnection();
                            }
                        }
                        logger.error("Failed to prepare delayed disconnection event:", e);
                    }
                };
                await prepareDelayedDisconnection();
                // Send join event _after_ preparing the delayed disconnection event
                await resendIfRateLimited(() =>
                    this.client.sendStateEvent(this.room.roomId, EventType.GroupCallMemberPrefix, newContent, stateKey),
                );
                // If sending state cancels your own delayed state, prepare another delayed state
                // TODO: Remove this once MSC4140 is stable & doesn't cancel own delayed state
                if (this.disconnectDelayId !== undefined) {
                    try {
                        const knownDisconnectDelayId = this.disconnectDelayId;
                        await resendIfRateLimited(() =>
                            this.client._unstable_updateDelayedEvent(
                                knownDisconnectDelayId,
                                UpdateDelayedEventAction.Restart,
                            ),
                        );
                    } catch (e) {
                        if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") {
                            // If we get a M_NOT_FOUND we prepare a new delayed event.
                            // In other error cases we do not want to prepare anything since we do not have the guarantee, that the
                            // future is not still running.
                            logger.warn("Failed to update delayed disconnection event, prepare it again:", e);
                            this.disconnectDelayId = undefined;
                            await prepareDelayedDisconnection();
                        }
                    }
                }
                if (this.disconnectDelayId !== undefined) {
                    this.scheduleDelayDisconnection();
                }
            } else {
                // Not joined
                let sentDelayedDisconnect = false;
                if (this.disconnectDelayId !== undefined) {
                    try {
                        const knownDisconnectDelayId = this.disconnectDelayId;
                        await resendIfRateLimited(() =>
                            this.client._unstable_updateDelayedEvent(
                                knownDisconnectDelayId,
                                UpdateDelayedEventAction.Send,
                            ),
                        );
                        sentDelayedDisconnect = true;
                    } catch (e) {
                        logger.error("Failed to send our delayed disconnection event:", e);
                    }
                    this.disconnectDelayId = undefined;
                }
                if (!sentDelayedDisconnect) {
                    await resendIfRateLimited(() =>
                        this.client.sendStateEvent(
                            this.room.roomId,
                            EventType.GroupCallMemberPrefix,
                            {},
                            this.makeMembershipStateKey(localUserId, localDeviceId),
                        ),
                    );
                }
            }
            logger.info("Sent updated call member event.");
        } catch (e) {
            const resendDelay = this.callMemberEventRetryDelayMinimum + Math.random() * this.callMemberEventRetryJitter;
            logger.warn(`Failed to send call member event (retrying in ${resendDelay}): ${e}`);
            await sleep(resendDelay);
            await this.triggerCallMembershipEventUpdate();
        }
    }

    private scheduleDelayDisconnection(): void {
        this.memberEventTimeout = setTimeout(this.delayDisconnection, this.membershipKeepAlivePeriod);
    }

    private readonly delayDisconnection = async (): Promise<void> => {
        try {
            const knownDisconnectDelayId = this.disconnectDelayId!;
            await resendIfRateLimited(() =>
                this.client._unstable_updateDelayedEvent(knownDisconnectDelayId, UpdateDelayedEventAction.Restart),
            );
            this.scheduleDelayDisconnection();
        } catch (e) {
            logger.error("Failed to delay our disconnection event:", e);
        }
    };

    private makeMembershipStateKey(localUserId: string, localDeviceId: string): string {
        const stateKey = `${localUserId}_${localDeviceId}`;
        if (/^org\.matrix\.msc(3757|3779)\b/.exec(this.room.getVersion())) {
            return stateKey;
        } else {
            return `_${stateKey}`;
        }
    }
}

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
