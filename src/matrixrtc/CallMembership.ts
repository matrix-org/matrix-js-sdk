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
import { IEvent, MatrixClient, MatrixEvent, RoomMember } from "../matrix";
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
    encryption_key_event?: string;
}

export class CallMembership {
    public static equal(a: CallMembership, b: CallMembership): boolean {
        return deepCompare(a.data, b.data);
    }

    public constructor(
        private client: MatrixClient,
        private parentEvent: MatrixEvent,
        private data: CallMembershipData,
    ) {
        if (typeof data.expires !== "number") throw new Error("Malformed membership: expires must be numeric");
        if (typeof data.device_id !== "string") throw new Error("Malformed membership event: device_id must be string");
        if (typeof data.call_id !== "string") throw new Error("Malformed membership event: call_id must be string");
        if (typeof data.scope !== "string") throw new Error("Malformed membership event: scope must be string");
        if (typeof data.encryption_key_event !== "string") {
            throw new Error("Malformed membership event: encryption_key_event must be string");
        }
        if (parentEvent.sender === null) throw new Error("Invalid parent event: sender is null");
    }

    public get member(): RoomMember {
        return this.parentEvent.sender!;
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
        return this.getAbsoluteExpiry() < this.parentEvent.getTs() + this.parentEvent.getLocalAge();
    }

    public getActiveFoci(): Focus[] {
        return this.data.foci_active ?? [];
    }

    public async getActiveEncryptionKey(): Promise<string | undefined> {
        const roomId = this.parentEvent.getRoomId();
        const eventId = this.data.encryption_key_event;

        if (!roomId) return;
        if (!eventId) return;

        let partialEvent: Partial<IEvent>;
        try {
            partialEvent = await this.client.fetchRoomEvent(roomId, eventId);
        } catch (error) {
            logger.warn("Failed to fetch encryption key event", error);
            return;
        }

        const event = new MatrixEvent(partialEvent);
        const content = event.getContent();
        const encryptionKey = content["io.element.key"];

        if (!encryptionKey) return undefined;
        if (typeof encryptionKey !== "string") return undefined;

        return encryptionKey;
    }
}
