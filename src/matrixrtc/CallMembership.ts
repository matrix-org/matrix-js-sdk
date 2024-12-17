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

import { MatrixEvent } from "../matrix.ts";
import { deepCompare } from "../utils.ts";
import { Focus } from "./focus.ts";
import { isLivekitFocusActive } from "./LivekitFocus.ts";

export const DEFAULT_EXPIRE_DURATION = 1000 * 60 * 10 * 4; // 4 hours

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

    // Optionally we allow to define a delta to the created_ts when it expires. This should be set to multiple hours.
    // The only reason it exist is if delayed events fail. (for example because if a homeserver crashes)
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

    public get expires(): number {
        return this.membershipData.expires ?? DEFAULT_EXPIRE_DURATION;
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
     * Gets the absolute expiry time of the membership if applicable to this membership type.
     * @returns The absolute expiry time of the membership as a unix timestamp in milliseconds or undefined if not applicable
     */
    public getAbsoluteExpiry(): number | undefined {
        return this.createdTs() + this.expires;
    }

    /**
     * @returns The number of milliseconds until the membership expires or undefined if applicable
     */
    public getMsUntilExpiry(): number | undefined {
        // Assume that local clock is sufficiently in sync with other clocks in the distributed system.
        // We used to try and adjust for the local clock being skewed, but there are cases where this is not accurate.
        // The current implementation allows for the local clock to be -infinity to +MatrixRTCSession.MEMBERSHIP_EXPIRY_TIME/2
        return this.getAbsoluteExpiry()! - Date.now();
    }

    /**
     * @returns true if the membership has expired, otherwise false
     */
    public isExpired(): boolean {
        return this.getMsUntilExpiry()! <= 0;
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
