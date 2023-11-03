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

import { MatrixEvent } from "../matrix";
import { deepCompare } from "../utils";
import { Focus } from "./focus";

type CallScope = "m.room" | "m.user";

// Represents an entry in the memberships section of an m.call.member event as it is on the wire
export interface CallMembershipData {
    application?: string;
    call_id: string;
    scope: CallScope;
    device_id: string;
    created_ts?: number;
    expires: number;
    foci_active?: Focus[];
    membershipID: string;
}

export class CallMembership {
    public static equal(a: CallMembership, b: CallMembership): boolean {
        return deepCompare(a.data, b.data);
    }

    public constructor(private parentEvent: MatrixEvent, private data: CallMembershipData) {
        if (typeof data.expires !== "number") throw new Error("Malformed membership: expires must be numeric");
        if (typeof data.device_id !== "string") throw new Error("Malformed membership event: device_id must be string");
        if (typeof data.call_id !== "string") throw new Error("Malformed membership event: call_id must be string");
        if (typeof data.scope !== "string") throw new Error("Malformed membership event: scope must be string");
        if (!parentEvent.getSender()) throw new Error("Invalid parent event: sender is null");
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

    public get scope(): CallScope {
        return this.data.scope;
    }

    public get membershipID(): string {
        return this.data.membershipID;
    }

    public createdTs(): number {
        return this.data.created_ts ?? this.parentEvent.getTs();
    }

    public getAbsoluteExpiry(): number {
        return this.createdTs() + this.data.expires;
    }

    // gets the expiry time of the event, converted into the device's local time
    public getLocalExpiry(): number {
        const relativeCreationTime = this.parentEvent.getTs() - this.createdTs();

        const localCreationTs = this.parentEvent.localTimestamp - relativeCreationTime;

        return localCreationTs + this.data.expires;
    }

    public getMsUntilExpiry(): number {
        return this.getLocalExpiry() - Date.now();
    }

    public isExpired(): boolean {
        return this.getMsUntilExpiry() <= 0;
    }

    public getActiveFoci(): Focus[] {
        return this.data.foci_active ?? [];
    }
}
