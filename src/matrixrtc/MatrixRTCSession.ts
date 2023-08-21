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

const MEMBERSHIP_EXPIRY_TIME = 60 * 60 * 1000;
const CALL_MEMBER_EVENT_RETRY_DELAY_MIN = 3000;

export enum MatrixRTCSessionEvent {
    // A member joined, left, or updated a proprty of their membership
    MembershipsChanged = "memberships_changed",
    // We joined or left the session (our own local idea of whether we are joined, separate from MembershipsChanged)
    JoinStateChanged = "join_state_changed",
}

export type MatrixRTCSessionEventHandlerMap = {
    [MatrixRTCSessionEvent.MembershipsChanged]: (
        newMemberships: CallMembership[],
        oldMemberships: CallMembership[],
    ) => void;
    [MatrixRTCSessionEvent.JoinStateChanged]: (isJoined: boolean) => void;
};

/**
 * A MatrixRTCSession manages the membership & properties of a MatrixRTC session.
 * This class doesn't deal with media at all, just membership & properties of a session.
 */
export class MatrixRTCSession extends TypedEventEmitter<MatrixRTCSessionEvent, MatrixRTCSessionEventHandlerMap> {
    // How many ms after we joined the call, that our membership should expire, or undefined
    // if we're not yet joined
    private relativeExpiry: number | undefined;

    private memberEventTimeout?: ReturnType<typeof setTimeout>;
    private expiryTimeout?: ReturnType<typeof setTimeout>;

    private activeFoci: Focus[] | undefined;

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
                logger.warn("Ignoring malformed member event: no memberships section");
                continue;
            }
            if (!Array.isArray(eventMemberships)) {
                logger.warn("Malformed member event: memberships is not an array");
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

        return callMemberships;
    }

    /**
     * Return a the MatrixRTC for the room, whether there are currently active members or not
     */
    public static roomSessionForRoom(client: MatrixClient, room: Room): MatrixRTCSession {
        const callMemberships = MatrixRTCSession.callMembershipsForRoom(room);

        return new MatrixRTCSession(client, room, callMemberships);
    }

    /**
     * Given the state of a room, find the active MatrixRTC Room-scoped session (if any) any return it
     * or return undefined if no members are currently joined to the room's MatrixRTC session
     */
    /*public static activeRoomSessionForRoom(client: MatrixClient, room: Room): MatrixRTCSession | undefined {
        const callMemberships = MatrixRTCSession.callMembershipsForRoom(room);

        if (callMemberships.length === 0) return undefined;

        return new MatrixRTCSession(client, room, callMemberships);
    }*/

    private constructor(
        private readonly client: MatrixClient,
        public readonly room: Room,
        public memberships: CallMembership[],
    ) {
        super();
        this.setExpiryTimer();
    }

    public isJoined(): boolean {
        return this.relativeExpiry !== undefined;
    }

    /**
     * Performs cleanup & removes timers for client shutdown
     */
    public stop(): void {
        this.leaveRoomSession();
        if (this.expiryTimeout) {
            clearTimeout(this.expiryTimeout);
            this.expiryTimeout = undefined;
        }
    }

    /**
     * Announces this user and device as joined to the MatrixRTC session,
     * and continues to update the membership event to keep it valid until
     * leaveRoomSession() is called
     * This will not subscribe to updates: remember to call subscribe() separately if
     * desired.
     */
    public joinRoomSession(activeFoci: Focus[]): void {
        if (this.isJoined()) {
            logger.info(`Already joined to session in room ${this.room.roomId}: ignoring join call`);
            return;
        }

        logger.info(`Joining call session in room ${this.room.roomId}`);
        this.activeFoci = activeFoci;
        this.relativeExpiry = MEMBERSHIP_EXPIRY_TIME;
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, true);
        this.updateCallMembershipEvent();
    }

    /**
     * Announces this user and device as having left the MatrixRTC session
     * and stops scheduled updates.
     * This will not unsubscribe from updates: remember to call unsubscribe() separately if
     * desired.
     */
    public leaveRoomSession(): void {
        if (!this.isJoined()) {
            logger.info(`Not joined to session in room ${this.room.roomId}: ignoring leave call`);
            return;
        }

        logger.info(`Leaving call session in room ${this.room.roomId}`);
        this.relativeExpiry = undefined;
        this.activeFoci = undefined;
        this.emit(MatrixRTCSessionEvent.JoinStateChanged, false);
        this.updateCallMembershipEvent();
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

    public onMembershipUpdate = (): void => {
        const oldMemberships = this.memberships;
        this.memberships = MatrixRTCSession.callMembershipsForRoom(this.room);

        const changed =
            oldMemberships.length != this.memberships.length ||
            oldMemberships.some((m, i) => !CallMembership.equal(m, this.memberships[i]));

        if (changed) {
            logger.info(`Memberships for call in room ${this.room.roomId} have changed: emitting`);
            this.emit(MatrixRTCSessionEvent.MembershipsChanged, oldMemberships, this.memberships);
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

        const m: CallMembershipData = {
            call_id: "",
            scope: "m.room",
            application: "m.call",
            device_id: this.client.getDeviceId()!,
            expires: this.relativeExpiry,
            foci_active: this.activeFoci,
        };

        if (prevMembership) m.created_ts = prevMembership.createdTs();

        return m;
    }

    private updateCallMembershipEvent = async (): Promise<void> => {
        if (this.memberEventTimeout) {
            clearTimeout(this.memberEventTimeout);
            this.memberEventTimeout = undefined;
        }

        const roomState = this.room.getLiveTimeline().getState(EventTimeline.FORWARDS);
        const localUserId = this.client.getUserId();
        const localDeviceId = this.client.getDeviceId();

        if (!localUserId || !localDeviceId) throw new Error("User ID or device ID was null!");

        if (!roomState) throw new Error("Couldn't get room state for room " + this.room.roomId);

        const myCallMemberEvent = roomState.getStateEvents(EventType.GroupCallMemberPrefix, localUserId);
        const content = myCallMemberEvent?.getContent<Record<any, unknown>>() ?? {};
        const memberships: CallMembershipData[] = Array.isArray(content["memberships"]) ? content["memberships"] : [];

        const myPrevMembershipData = memberships.find((m) => m.device_id === localDeviceId);
        let myPrevMembership;
        try {
            if (myCallMemberEvent && myPrevMembershipData) {
                myPrevMembership = new CallMembership(myCallMemberEvent, myPrevMembershipData);
            }
        } catch (e) {
            // This would indicate a bug or something weird if our own call membership
            // wasn't valid
            logger.warn("Our previous call membership was invalid - this shouldn't happen.", e);
        }

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

        if (!needsUpdate) return;

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
        let newMemberships = memberships.filter(filterExpired).filter((m) => m.device_id !== localDeviceId);

        // Fix up any memberships that need their created_ts adding
        newMemberships = newMemberships.map(transformMemberships);

        // If we're joined, add our own
        if (this.isJoined()) {
            newMemberships.push(this.makeMyMembership(myPrevMembership));
        }

        const newContent = {
            memberships: newMemberships,
        };

        let resendDelay;
        try {
            await this.client.sendStateEvent(
                this.room.roomId,
                EventType.GroupCallMemberPrefix,
                newContent,
                localUserId,
            );

            // check in 2 mins to see if we need to refresh our member event
            if (this.isJoined()) resendDelay = 2 * 60 * 1000;
        } catch (e) {
            resendDelay = CALL_MEMBER_EVENT_RETRY_DELAY_MIN + Math.random() * 2000;
            logger.warn(`Failed to send call member event: retrying in ${resendDelay}`);
        }

        if (resendDelay) this.memberEventTimeout = setTimeout(this.updateCallMembershipEvent, resendDelay);
    };
}
