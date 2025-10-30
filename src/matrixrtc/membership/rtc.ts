import { EventType, IContent, MXID_PATTERN, RelationType } from "../../matrix";
import { RtcSlotEventContent, Transport } from "../types";
import { MatrixRTCMembershipParseError } from "./common";


/**
 * Represents the current form of MSC4143.
 */
export interface RtcMembershipData {
    "slot_id": string;
    "member": {
        claimed_user_id: string;
        claimed_device_id: string;
        id: string
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

export const checkRtcMembershipData = (
    data: IContent,
    referenceUserId: string,
): data is RtcMembershipData => {
    const errors: string[] = [];
    const prefix = " - ";

    // required fields
    if (typeof data.slot_id !== "string") {
        errors.push(prefix + "slot_id must be string");
    } else {
        if (data.slot_id.split("#").length !== 2) errors.push(prefix + 'slot_id must include exactly one "#"');
    }
    if (typeof data.member !== "object" || data.member === null) {
        errors.push(prefix + "member must be an object");
    } else {
        if (typeof data.member.claimed_user_id !== "string") errors.push(prefix + "member.claimed_user_id must be string");
        else if (!MXID_PATTERN.test(data.member.claimed_user_id)) errors.push(prefix + "member.claimed_user_id must be a valid mxid");
        // This is not what the spec enforces but there currently are no rules what power levels are required to
        // send a m.rtc.member event for a other user. So we add this check for simplicity and to avoid possible attacks until there
        // is a proper definition when this is allowed.
        else if (data.member.claimed_user_id !== referenceUserId) errors.push(prefix + "member.claimed_user_id must match the sender");
        if (typeof data.member.claimed_device_id !== "string") errors.push(prefix + "member.claimed_device_id must be string");
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
        throw new MatrixRTCMembershipParseError(EventType.RTCMembership, errors)
    }

    return true;
};