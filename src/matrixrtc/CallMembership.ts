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

import { IContent, MatrixEvent } from "../matrix";
import { deepCompare } from "../utils";
import { Focus } from "./focus";

type CallScope = "m.room" | "m.user";
// Represents an entry in the memberships section of an m.call.member event as it is on the wire

// There are two different data interfaces. One for the Legacy types and one complient with MSC4143

// MSC4143 (MatrixRTC) session membership data

export interface SessionMembershipData {
    application: string;
    call_id: string;
    device_id: string;

    foci_active: Focus;
    foci_preferred: Focus[];
    created_ts?: number;

    // Application specific data
    scope?: CallScope;
}

export const isSessionMembershipData = (data: any): data is SessionMembershipData =>
    "foci_active" in data &&
    "foci_preferred" in data &&
    !Array.isArray(data.foci_active) &&
    Array.isArray(data.foci_preferred);

const checkSessionsMembershipData = (data: SessionMembershipData): void => {
    const prefix = "Malformed session membership event: ";
    if (typeof data.device_id !== "string") throw new Error(prefix + "device_id must be string");
    if (typeof data.call_id !== "string") throw new Error(prefix + "call_id must be string");
    if (typeof data.application !== "string") throw new Error(prefix + "application must be a string");
    if (typeof data.foci_active?.type !== "string") throw new Error(prefix + "foci_active.type must be a string");
    if (!Array.isArray(data.foci_preferred)) throw new Error(prefix + "foci_preferred must be an array");
    // optional elements
    if (data.created_ts && typeof data.created_ts !== "number") throw new Error(prefix + "created_ts must be number");

    // application specific data (we first need to check if they exist)
    if (data.scope && typeof data.scope !== "string") throw new Error(prefix + "scope must be string");
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

export const isLegacyCallMembershipData = (data: any): data is CallMembershipDataLegacy => "membershipID" in data;

const checkCallMembershipDataLegacy = (data: CallMembershipDataLegacy): void => {
    const prefix = "Malformed legacy rtc membership event: ";
    if (!("expires" in data || "expires_ts" in data)) {
        throw new Error(prefix + "expires_ts or expires must be present");
    }
    if ("expires" in data) {
        if (typeof data.expires !== "number") {
            throw new Error(prefix + "expires must be numeric");
        }
    }
    if ("expires_ts" in data) {
        if (typeof data.expires_ts !== "number") {
            throw new Error(prefix + "expires_ts must be numeric");
        }
    }

    if (typeof data.device_id !== "string") throw new Error(prefix + "device_id must be string");
    if (typeof data.call_id !== "string") throw new Error(prefix + "call_id must be string");
    if (typeof data.application !== "string") throw new Error(prefix + "application must be a string");
    if (typeof data.membershipID !== "string") throw new Error(prefix + "membershipID must be a string");
    // optional elements
    if (data.created_ts && typeof data.created_ts !== "number") throw new Error(prefix + "created_ts must be number");
    // application specific data (we first need to check if they exist)
    if (data.scope && typeof data.scope !== "string") throw new Error(prefix + "scope must be string");
};

export type CallMembershipData = CallMembershipDataLegacy | SessionMembershipData;

export class CallMembership {
    public static equal(a: CallMembership, b: CallMembership): boolean {
        return deepCompare(a.data, b.data);
    }

    public constructor(
        private parentEvent: MatrixEvent,
        private data: IContent,
    ) {
        if (isLegacyCallMembershipData(data)) checkCallMembershipDataLegacy(data);
        else if (isSessionMembershipData(data)) checkSessionsMembershipData(data);
        else throw Error("unknown CallMembership data. Does not match legacy call.member events nor MSC4143");
        if (!parentEvent.getSender()) throw new Error("Invalid parent event: sender is null");
    }

    public get isLegacy(): boolean {
        return isLegacyCallMembershipData(this.data);
    }

    public get sender(): string | undefined {
        return this.parentEvent.getSender();
    }

    public get callId(): string {
        return this.data.call_id;
    }

    public get deviceId(): string {
        return this.data.device_id;
    }

    public get application(): string | undefined {
        return this.data.application;
    }

    public get scope(): CallScope | undefined {
        return this.data.scope;
    }

    public get membershipID(): string {
        if (isLegacyCallMembershipData(this.data)) return this.data.membershipID;
        // the createdTs behaves equivalent to the membershipID.
        // we only need the field for the legacy member envents where we needed to update them
        // synapse ignores sending state events if they have the same content.
        else return this.createdTs().toString();
    }

    public createdTs(): number {
        return this.data.created_ts ?? this.parentEvent.getTs();
    }

    public getAbsoluteExpiry(): number | undefined {
        if (!isLegacyCallMembershipData(this.data)) return undefined;
        if ("expires" in this.data) {
            // we know createdTs exists since we already do the isLegacyCallMembershipData check
            return this.createdTs() + this.data.expires;
        } else {
            // We know it exists because we checked for this in the constructor.
            return this.data.expires_ts;
        }
    }

    // gets the expiry time of the event, converted into the device's local time
    public getLocalExpiry(): number | undefined {
        if (!isLegacyCallMembershipData(this.data)) return undefined;
        if ("expires" in this.data) {
            // we know createdTs exists since we already do the isLegacyCallMembershipData check
            const relativeCreationTime = this.parentEvent.getTs() - this.createdTs();

            const localCreationTs = this.parentEvent.localTimestamp - relativeCreationTime;

            return localCreationTs + this.data.expires;
        } else {
            // With expires_ts we cannot convert to local time.
            // TODO: Check the server timestamp and compute a diff to local time.
            return this.data.expires_ts;
        }
    }

    public getMsUntilExpiry(): number | undefined {
        if (isLegacyCallMembershipData(this.data)) return this.getLocalExpiry()! - Date.now();
    }

    public isExpired(): boolean {
        if (isLegacyCallMembershipData(this.data)) return this.getMsUntilExpiry()! <= 0;

        // MSC4143 events expire by being updated. So if the event exists, its not expired.
        return false;
    }

    public getPreferredFoci(): Focus[] {
        // To support both, the new and the old MatrixRTC memberships have two cases based
        // on the availablitiy of `foci_preferred`
        if (isLegacyCallMembershipData(this.data)) return this.data.foci_active ?? [];

        // MSC4143 style membership
        return this.data.foci_preferred;
    }
}
