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

import { EitherAnd } from "matrix-events-sdk/lib/types";

import { MatrixEvent } from "../matrix";
import { deepCompare } from "../utils";
import { Focus } from "./focus";
import { isLivekitFocusActive } from "./LivekitFocus";

type CallScope = "m.room" | "m.user";
// Represents an entry in the memberships section of an m.call.member event as it is on the wire

// There are two different data interfaces. One for the Legacy types and one compliant with MSC4143

// MSC4143 (MatrixRTC) session membership data

export type SessionMembershipData = {
    application: string;
    call_id: string;
    device_id: string;

    focus_active: Focus;
    foci_preferred: Focus[];
    created_ts?: number;

    // Application specific data
    scope?: CallScope;
};

export const isSessionMembershipData = (data: CallMembershipData): data is SessionMembershipData =>
    "focus_active" in data;

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

// Legacy session membership data

export type CallMembershipDataLegacy = {
    application: string;
    call_id: string;
    scope: CallScope;
    device_id: string;
    membershipID: string;
    created_ts?: number;
    foci_active?: Focus[];
} & EitherAnd<{ expires: number }, { expires_ts: number }>;

export const isLegacyCallMembershipData = (data: CallMembershipData): data is CallMembershipDataLegacy =>
    "membershipID" in data;

const checkCallMembershipDataLegacy = (data: any, errors: string[]): data is CallMembershipDataLegacy => {
    const prefix = "Malformed legacy rtc membership event: ";
    if (!("expires" in data || "expires_ts" in data)) {
        errors.push(prefix + "expires_ts or expires must be present");
    }
    if ("expires" in data) {
        if (typeof data.expires !== "number") {
            errors.push(prefix + "expires must be numeric");
        }
    }
    if ("expires_ts" in data) {
        if (typeof data.expires_ts !== "number") {
            errors.push(prefix + "expires_ts must be numeric");
        }
    }

    if (typeof data.device_id !== "string") errors.push(prefix + "device_id must be string");
    if (typeof data.call_id !== "string") errors.push(prefix + "call_id must be string");
    if (typeof data.application !== "string") errors.push(prefix + "application must be a string");
    if (typeof data.membershipID !== "string") errors.push(prefix + "membershipID must be a string");
    // optional elements
    if (data.created_ts && typeof data.created_ts !== "number") errors.push(prefix + "created_ts must be number");
    // application specific data (we first need to check if they exist)
    if (data.scope && typeof data.scope !== "string") errors.push(prefix + "scope must be string");
    return errors.length === 0;
};

export type CallMembershipData = CallMembershipDataLegacy | SessionMembershipData;

export class CallMembership {
    public static equal(a: CallMembership, b: CallMembership): boolean {
        return deepCompare(a.membershipData, b.membershipData);
    }
    private membershipData: CallMembershipData;

    public constructor(
        private parentEvent: MatrixEvent,
        data: any,
    ) {
        const sessionErrors: string[] = [];
        const legacyErrors: string[] = [];
        if (!checkSessionsMembershipData(data, sessionErrors) && !checkCallMembershipDataLegacy(data, legacyErrors)) {
            throw Error(
                `unknown CallMembership data. Does not match legacy call.member (${legacyErrors.join(" & ")}) events nor MSC4143 (${sessionErrors.join(" & ")})`,
            );
        } else {
            this.membershipData = data;
        }
    }

    public get sender(): string | undefined {
        return this.parentEvent.getSender();
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
        if (isLegacyCallMembershipData(this.membershipData)) return this.membershipData.membershipID;
        // the createdTs behaves equivalent to the membershipID.
        // we only need the field for the legacy member envents where we needed to update them
        // synapse ignores sending state events if they have the same content.
        else return this.createdTs().toString();
    }

    public createdTs(): number {
        return this.membershipData.created_ts ?? this.parentEvent.getTs();
    }

    /**
     * Gets the absolute expiry time of the membership if applicable to this membership type.
     * @returns The absolute expiry time of the membership as a unix timestamp in milliseconds or undefined if not applicable
     */
    public getAbsoluteExpiry(): number | undefined {
        // if the membership is not a legacy membership, we assume it is MSC4143
        if (!isLegacyCallMembershipData(this.membershipData)) return undefined;

        if ("expires" in this.membershipData) {
            // we know createdTs exists since we already do the isLegacyCallMembershipData check
            return this.createdTs() + this.membershipData.expires;
        } else {
            // We know it exists because we checked for this in the constructor.
            return this.membershipData.expires_ts;
        }
    }

    /**
     * Gets the expiry time of the event, converted into the device's local time.
     * @deprecated This function has been observed returning bad data and is no longer used by MatrixRTC.
     * @returns The local expiry time of the membership as a unix timestamp in milliseconds or undefined if not applicable
     */
    public getLocalExpiry(): number | undefined {
        // if the membership is not a legacy membership, we assume it is MSC4143
        if (!isLegacyCallMembershipData(this.membershipData)) return undefined;

        if ("expires" in this.membershipData) {
            // we know createdTs exists since we already do the isLegacyCallMembershipData check
            const relativeCreationTime = this.parentEvent.getTs() - this.createdTs();

            const localCreationTs = this.parentEvent.localTimestamp - relativeCreationTime;

            return localCreationTs + this.membershipData.expires;
        } else {
            // With expires_ts we cannot convert to local time.
            // TODO: Check the server timestamp and compute a diff to local time.
            return this.membershipData.expires_ts;
        }
    }

    /**
     * @returns The number of milliseconds until the membership expires or undefined if applicable
     */
    public getMsUntilExpiry(): number | undefined {
        if (isLegacyCallMembershipData(this.membershipData)) {
            // Assume that local clock is sufficiently in sync with other clocks in the distributed system.
            // We used to try and adjust for the local clock being skewed, but there are cases where this is not accurate.
            // The current implementation allows for the local clock to be -infinity to +MatrixRTCSession.MEMBERSHIP_EXPIRY_TIME/2
            return this.getAbsoluteExpiry()! - Date.now();
        }

        // Assumed to be MSC4143
        return undefined;
    }

    /**
     * @returns true if the membership has expired, otherwise false
     */
    public isExpired(): boolean {
        if (isLegacyCallMembershipData(this.membershipData)) return this.getMsUntilExpiry()! <= 0;

        // MSC4143 events expire by being updated. So if the event exists, its not expired.
        return false;
    }

    public getPreferredFoci(): Focus[] {
        // To support both, the new and the old MatrixRTC memberships have two cases based
        // on the availablitiy of `foci_preferred`
        if (isLegacyCallMembershipData(this.membershipData)) return this.membershipData.foci_active ?? [];

        // MSC4143 style membership
        return this.membershipData.foci_preferred;
    }

    public getFocusSelection(): string | undefined {
        if (isLegacyCallMembershipData(this.membershipData)) {
            return "oldest_membership";
        } else {
            const focusActive = this.membershipData.focus_active;
            if (isLivekitFocusActive(focusActive)) {
                return focusActive.focus_selection;
            }
        }
    }
}
