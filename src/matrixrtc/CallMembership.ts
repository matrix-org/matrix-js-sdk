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

import { type MatrixEvent } from "../matrix.ts";
import { deepCompare } from "../utils.ts";
import { type Focus } from "./focus.ts";
import { isLivekitFocusActive } from "./LivekitFocus.ts";

/**
 * The default duration in milliseconds that a membership is considered valid for.
 * Ordinarily the client responsible for the session will update the membership before it expires.
 * We use this duration as the fallback case where stale sessions are present for some reason.
 */
export const DEFAULT_EXPIRE_DURATION = 1000 * 60 * 60 * 4;

type CallScope = "m.room" | "m.user";

/**
 * MSC4143 (MatrixRTC) session membership data.
 * Represents an entry in the memberships section of an m.call.member event as it is on the wire.
 **/
export type SessionMembershipData = {
    /**
     * The RTC application defines the type of the RTC session.
     */
    application: string;

    /**
     * The id of this session.
     * A session can never span over multiple rooms so this id is to distinguish between
     * multiple session in one room. A room wide session that is not associated with a user,
     * and therefore immune to creation race conflicts, uses the `call_id: ""`.
     */
    call_id: string;

    /**
     * The Matrix device ID of this session. A single user can have multiple sessions on different devices.
     */
    device_id: string;

    /**
     * The focus selection system this user/membership is using.
     */
    focus_active: Focus;

    /**
     * A list of possible foci this uses knows about. One of them might be used based on the focus_active
     * selection system.
     */
    foci_preferred: Focus[];

    /**
     * Optional field that contains the creation of the session. If it is undefined the creation
     * is the `origin_server_ts` of the event itself. For updates to the event this property tracks
     * the `origin_server_ts` of the initial join event.
     *  - If it is undefined it can be interpreted as a "Join".
     *  - If it is defined it can be interpreted as an "Update"
     */
    created_ts?: number;

    // Application specific data

    /**
     * If the `application` = `"m.call"` this defines if it is a room or user owned call.
     * There can always be one room scroped call but multiple user owned calls (breakout sessions)
     */
    scope?: CallScope;

    /**
     * Optionally we allow to define a delta to the `created_ts` that defines when the event is expired/invalid.
     * This should be set to multiple hours. The only reason it exist is to deal with failed delayed events.
     * (for example caused by a homeserver crashes)
     **/
    expires?: number;
};

const checkSessionsMembershipData = (data: any, errors: string[]): data is SessionMembershipData => {
    const prefix = "Malformed session membership event: ";
    if (typeof data.device_id !== "string") errors.push(prefix + "device_id must be string");
    if (typeof data.call_id !== "string") errors.push(prefix + "call_id must be string");
    if (typeof data.application !== "string") errors.push(prefix + "application must be a string");
    if (typeof data.focus_active?.type !== "string") errors.push(prefix + "focus_active.type must be a string");
    if (!Array.isArray(data.foci_preferred)) errors.push(prefix + "foci_preferred must be an array");
    // optional parameters
    if (data.created_ts && typeof data.created_ts !== "number") errors.push(prefix + "created_ts must be number");

    // application specific data (we first need to check if they exist)
    if (data.scope && typeof data.scope !== "string") errors.push(prefix + "scope must be string");
    return errors.length === 0;
};

export class CallMembership {
    public static equal(a: CallMembership, b: CallMembership): boolean {
        return deepCompare(a.membershipData, b.membershipData);
    }
    private membershipData: SessionMembershipData;

    public constructor(
        private parentEvent: MatrixEvent,
        data: any,
    ) {
        const sessionErrors: string[] = [];
        if (!checkSessionsMembershipData(data, sessionErrors)) {
            throw Error(
                `unknown CallMembership data. Does not match MSC4143 call.member (${sessionErrors.join(" & ")}) events this could be a legacy membership event: (${data})`,
            );
        } else {
            this.membershipData = data;
        }
    }

    public get sender(): string | undefined {
        return this.parentEvent.getSender();
    }

    public get eventId(): string | undefined {
        return this.parentEvent.getId();
    }

    public get callId(): string {
        return this.membershipData.call_id;
    }

    public get deviceId(): string {
        return this.membershipData.device_id;
    }

    public get application(): string | undefined {
        return this.membershipData.application;
    }

    public get scope(): CallScope | undefined {
        return this.membershipData.scope;
    }

    public get membershipID(): string {
        // the createdTs behaves equivalent to the membershipID.
        // we only need the field for the legacy member envents where we needed to update them
        // synapse ignores sending state events if they have the same content.
        return this.createdTs().toString();
    }

    public createdTs(): number {
        return this.membershipData.created_ts ?? this.parentEvent.getTs();
    }

    /**
     * Gets the absolute expiry timestamp of the membership.
     * @returns The absolute expiry time of the membership as a unix timestamp in milliseconds or undefined if not applicable
     */
    public getAbsoluteExpiry(): number {
        // TODO: calculate this from the MatrixRTCSession join configuration directly
        return this.createdTs() + (this.membershipData.expires ?? DEFAULT_EXPIRE_DURATION);
    }

    /**
     * @returns The number of milliseconds until the membership expires or undefined if applicable
     */
    public getMsUntilExpiry(): number {
        // Assume that local clock is sufficiently in sync with other clocks in the distributed system.
        // We used to try and adjust for the local clock being skewed, but there are cases where this is not accurate.
        // The current implementation allows for the local clock to be -infinity to +MatrixRTCSession.MEMBERSHIP_EXPIRY_TIME/2
        return this.getAbsoluteExpiry() - Date.now();
    }

    /**
     * @returns true if the membership has expired, otherwise false
     */
    public isExpired(): boolean {
        return this.getMsUntilExpiry() <= 0;
    }

    public getPreferredFoci(): Focus[] {
        return this.membershipData.foci_preferred;
    }

    public getFocusSelection(): string | undefined {
        const focusActive = this.membershipData.focus_active;
        if (isLivekitFocusActive(focusActive)) {
            return focusActive.focus_selection;
        }
    }
}
