/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { MXID_PATTERN } from "../../models/room-member.ts";
import type { IContent } from "../../models/event.ts";
import type { RelationType } from "../../types.ts";
import { type RtcSlotEventContent, type Transport } from "../types.ts";
import { MatrixRTCMembershipParseError } from "./common.ts";
import { sha256 } from "../../digest.ts";
import { encodeUnpaddedBase64Url } from "../../base64.ts";
import { slotIdToDescription } from "../utils.ts";

/**
 * Represents the current form of MSC4143, which uses sticky events to store membership.
 */
export interface RtcMembershipData {
    "slot_id": string;
    "member": {
        user_id: string;
        device_id: string;
        id: string;
    };
    "m.relates_to"?: {
        event_id: string;
        rel_type: RelationType.Reference;
    };
    "application": RtcSlotEventContent["application"];
    "rtc_transports": Transport[];
    "versions": string[];
    "msc4354_sticky_key"?: string;
    "sticky_key"?: string;
}

/**
 * Validates that `data` matches the format expected by MSC4143.
 * @param data The event content.
 * @param sender The sender of the event.
 * @returns true if `data` is valid RtcMembershipData
 * @throws {MatrixRTCMembershipParseError} if the content is not valid
 */
export const checkRtcMembershipData = (data: IContent, sender: string): data is RtcMembershipData => {
    const errors: string[] = [];
    const prefix = " - ";
    const expectedSlotPrefix = `${data?.application?.type}#`;

    // required fields
    if (typeof data.slot_id !== "string") {
        errors.push(prefix + "slot_id must be string");
    } else if (!data.slot_id.startsWith(expectedSlotPrefix)) {
        errors.push(prefix + `slot_id must start with ${expectedSlotPrefix}`);
    } else {
        try {
            slotIdToDescription(data.slot_id);
        } catch (ex) {
            errors.push(prefix + `slot_id was badly formed${ex instanceof Error ? `: ${ex.message}` : ""}`);
        }
    }

    if (typeof data.member !== "object" || data.member === null) {
        errors.push(prefix + "member must be an object");
    } else {
        if (typeof data.member.user_id !== "string") {
            errors.push(prefix + "member.user_id must be string");
        } else if (!MXID_PATTERN.test(data.member.user_id)) {
            errors.push(prefix + "member.user_id must be a valid mxid");
        }
        // This is not what the spec enforces but there currently are no rules what power levels are required to
        // send a m.rtc.member event for a other user. So we add this check for simplicity and to avoid possible attacks until there
        // is a proper definition when this is allowed.
        else if (data.member.user_id !== sender) {
            errors.push(prefix + "member.user_id must match the sender");
        }
        if (typeof data.member.device_id !== "string") {
            errors.push(prefix + "member.device_id must be string");
        }
        if (typeof data.member.id !== "string") errors.push(prefix + "member.id must be string");
    }
    if (typeof data.application !== "object" || data.application === null) {
        errors.push(prefix + "application must be an object");
    } else {
        if (typeof data.application.type !== "string") {
            errors.push(prefix + "application.type must be a string");
        } else {
            if (data.application.type.includes("#")) errors.push(prefix + 'application.type must not include "#"');
        }
    }
    if (data.rtc_transports === undefined || !Array.isArray(data.rtc_transports)) {
        errors.push(prefix + "rtc_transports must be an array");
    } else {
        // validate that each transport has at least a string 'type'
        for (const t of data.rtc_transports) {
            if (typeof t !== "object" || t === null || typeof (t as any).type !== "string") {
                errors.push(prefix + "rtc_transports entries must be objects with a string type");
                break;
            }
        }
    }
    if (data.versions === undefined || !Array.isArray(data.versions)) {
        errors.push(prefix + "versions must be an array");
    } else if (!data.versions.every((v) => typeof v === "string")) {
        errors.push(prefix + "versions must be an array of strings");
    }

    // optional fields
    if ((data.sticky_key ?? data.msc4354_sticky_key) === undefined) {
        errors.push(prefix + "sticky_key or msc4354_sticky_key must be a defined");
    }
    if (data.sticky_key !== undefined && typeof data.sticky_key !== "string") {
        errors.push(prefix + "sticky_key must be a string");
    }
    if (data.msc4354_sticky_key !== undefined && typeof data.msc4354_sticky_key !== "string") {
        errors.push(prefix + "msc4354_sticky_key must be a string");
    }
    if (
        data.sticky_key !== undefined &&
        data.msc4354_sticky_key !== undefined &&
        data.sticky_key !== data.msc4354_sticky_key
    ) {
        errors.push(prefix + "sticky_key and msc4354_sticky_key must be equal if both are defined");
    }
    if (data["m.relates_to"] !== undefined) {
        const rel = data["m.relates_to"] as RtcMembershipData["m.relates_to"];
        if (typeof rel !== "object" || rel === null) {
            errors.push(prefix + "m.relates_to must be an object if provided");
        } else {
            if (typeof rel.event_id !== "string") errors.push(prefix + "m.relates_to.event_id must be a string");
            if (rel.rel_type !== "m.reference") errors.push(prefix + "m.relates_to.rel_type must be m.reference");
        }
    }

    if (errors.length) {
        throw new MatrixRTCMembershipParseError("RtcMembership", errors);
    }

    return true;
};

export async function computeRtcIdentityRaw(userId: string, deviceId: string, memberId: string): Promise<string> {
    const hashInput = `${userId}|${deviceId}|${memberId}`;
    const hashBuffer = await sha256(hashInput);
    const hashedString = encodeUnpaddedBase64Url(hashBuffer);
    return hashedString;
}
