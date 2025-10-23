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

import { MXID_PATTERN } from "../models/room-member.ts";
import { deepCompare } from "../utils.ts";
import { type LivekitFocusSelection } from "./LivekitTransport.ts";
import { slotDescriptionToId, slotIdToDescription, type SlotDescription } from "./MatrixRTCSession.ts";
import type { RTCCallIntent, Transport } from "./types.ts";
import { type IContent, type MatrixEvent } from "../models/event.ts";
import { type RelationType } from "../@types/event.ts";
import { logger } from "../logger.ts";

/**
 * The default duration in milliseconds that a membership is considered valid for.
 * Ordinarily the client responsible for the session will update the membership before it expires.
 * We use this duration as the fallback case where stale sessions are present for some reason.
 */
export const DEFAULT_EXPIRE_DURATION = 1000 * 60 * 60 * 4;

type CallScope = "m.room" | "m.user";
type Member = { user_id: string; device_id: string; id: string };

export interface RtcMembershipData {
    "slot_id": string;
    "member": Member;
    "m.relates_to"?: {
        event_id: string;
        rel_type: RelationType.Reference;
    };
    "application": {
        type: string;
        // other application specific keys
        [key: string]: unknown;
    };
    "rtc_transports": Transport[];
    "versions": string[];
    "msc4354_sticky_key"?: string;
    "sticky_key"?: string;
}

const checkRtcMembershipData = (
    data: IContent,
    errors: string[],
    referenceUserId: string,
): data is RtcMembershipData => {
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
        if (typeof data.member.user_id !== "string") errors.push(prefix + "member.user_id must be string");
        else if (!MXID_PATTERN.test(data.member.user_id)) errors.push(prefix + "member.user_id must be a valid mxid");
        // This is not what the spec enforces but there currently are no rules what power levels are required to
        // send a m.rtc.member event for a other user. So we add this check for simplicity and to avoid possible attacks until there
        // is a proper definition when this is allowed.
        else if (data.member.user_id !== referenceUserId) errors.push(prefix + "member.user_id must match the sender");
        if (typeof data.member.device_id !== "string") errors.push(prefix + "member.device_id must be string");
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

    return errors.length === 0;
};

/**
 * MSC4143 (MatrixRTC) session membership data.
 * Represents the `session` in the memberships section of an m.call.member event as it is on the wire.
 **/
export type SessionMembershipData = {
    /**
     * The RTC application defines the type of the RTC session.
     */
    "application": string;

    /**
     * The id of this session.
     * A session can never span over multiple rooms so this id is to distinguish between
     * multiple session in one room. A room wide session that is not associated with a user,
     * and therefore immune to creation race conflicts, uses the `call_id: ""`.
     */
    "call_id": string;

    /**
     * The Matrix device ID of this session. A single user can have multiple sessions on different devices.
     */
    "device_id": string;

    /**
     * The focus selection system this user/membership is using.
     */
    "focus_active": LivekitFocusSelection;

    /**
     * A list of possible foci this user knows about. One of them might be used based on the focus_active
     * selection system.
     */
    "foci_preferred": Transport[];

    /**
     * Optional field that contains the creation of the session. If it is undefined the creation
     * is the `origin_server_ts` of the event itself. For updates to the event this property tracks
     * the `origin_server_ts` of the initial join event.
     *  - If it is undefined it can be interpreted as a "Join".
     *  - If it is defined it can be interpreted as an "Update"
     */
    "created_ts"?: number;

    // Application specific data

    /**
     * If the `application` = `"m.call"` this defines if it is a room or user owned call.
     * There can always be one room scoped call but multiple user owned calls (breakout sessions)
     */
    "scope"?: CallScope;

    /**
     * Optionally we allow to define a delta to the `created_ts` that defines when the event is expired/invalid.
     * This should be set to multiple hours. The only reason it exist is to deal with failed delayed events.
     * (for example caused by a homeserver crashes)
     **/
    "expires"?: number;

    /**
     * The intent of the call from the perspective of this user. This may be an audio call, video call or
     * something else.
     */
    "m.call.intent"?: RTCCallIntent;
    /**
     * The sticky key in case of a sticky event. This string encodes the application + device_id indicating the used slot + device.
     */
    "msc4354_sticky_key"?: string;
};

const checkSessionsMembershipData = (data: IContent, errors: string[]): data is SessionMembershipData => {
    const prefix = " - ";
    if (typeof data.device_id !== "string") errors.push(prefix + "device_id must be string");
    if (typeof data.call_id !== "string") errors.push(prefix + "call_id must be string");
    if (typeof data.application !== "string") errors.push(prefix + "application must be a string");
    if (typeof data.focus_active?.type !== "string") errors.push(prefix + "focus_active.type must be a string");
    if (data.focus_active === undefined) {
        errors.push(prefix + "focus_active has an invalid type");
    }
    if (
        data.foci_preferred !== undefined &&
        !(
            Array.isArray(data.foci_preferred) &&
            data.foci_preferred.every(
                (f: Transport) => typeof f === "object" && f !== null && typeof f.type === "string",
            )
        )
    ) {
        errors.push(prefix + "foci_preferred must be an array of transport objects");
    }
    // optional parameters
    if (data.created_ts !== undefined && typeof data.created_ts !== "number") {
        errors.push(prefix + "created_ts must be number");
    }

    // application specific data (we first need to check if they exist)
    if (data.scope !== undefined && typeof data.scope !== "string") errors.push(prefix + "scope must be string");

    if (data["m.call.intent"] !== undefined && typeof data["m.call.intent"] !== "string") {
        errors.push(prefix + "m.call.intent must be a string");
    }

    return errors.length === 0;
};

type MembershipData = { kind: "rtc"; data: RtcMembershipData } | { kind: "session"; data: SessionMembershipData };
// TODO: Rename to RtcMembership once we removed the legacy SessionMembership from this file.
export class CallMembership {
    public static equal(a?: CallMembership, b?: CallMembership): boolean {
        return deepCompare(a?.membershipData, b?.membershipData);
    }

    private membershipData: MembershipData;

    /** The parsed data from the Matrix event.
     * To access checked eventId and sender from the matrixEvent.
     * Class construction will fail if these values cannot get obtained. */
    private readonly matrixEventData: { eventId: string; sender: string };
    public constructor(
        /** The Matrix event that this membership is based on */
        private readonly matrixEvent: MatrixEvent,
        data: IContent,
    ) {
        const eventId = matrixEvent.getId();
        const sender = matrixEvent.getSender();

        if (eventId === undefined) throw new Error("parentEvent is missing eventId field");
        if (sender === undefined) throw new Error("parentEvent is missing sender field");

        const sessionErrors: string[] = [];
        const rtcErrors: string[] = [];
        if (checkSessionsMembershipData(data, sessionErrors)) {
            this.membershipData = { kind: "session", data };
        } else if (checkRtcMembershipData(data, rtcErrors, sender)) {
            this.membershipData = { kind: "rtc", data };
        } else {
            const details =
                sessionErrors.length < rtcErrors.length
                    ? `Does not match MSC4143 m.call.member:\n${sessionErrors.join("\n")}\n\n`
                    : `Does not match MSC4143 m.rtc.member:\n${rtcErrors.join("\n")}\n\n`;
            const json = "\nevent:\n" + JSON.stringify(data).replaceAll('"', "'");
            throw Error(`unknown CallMembership data.\n` + details + json);
        }
        this.matrixEventData = { eventId, sender };
    }

    /** @deprecated use userId instead */
    public get sender(): string {
        return this.userId;
    }
    public get userId(): string {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.member.user_id;
            case "session":
            default:
                return this.matrixEventData.sender;
        }
    }

    public get eventId(): string {
        return this.matrixEventData.eventId;
    }

    /**
     * The ID of the MatrixRTC slot that this membership belongs to (format `{application}#{id}`).
     * This is computed in case SessionMembershipData is used.
     */
    public get slotId(): string {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.slot_id;
            case "session":
            default:
                return slotDescriptionToId({ application: this.application, id: data.call_id });
        }
    }

    public get deviceId(): string {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.member.device_id;
            case "session":
            default:
                return data.device_id;
        }
    }

    public get callIntent(): RTCCallIntent | undefined {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc": {
                const intent = data.application["m.call.intent"];
                if (typeof intent === "string") {
                    return intent;
                }
                logger.warn("RTC membership has invalid m.call.intent");
                return undefined;
            }
            case "session":
            default:
                return data["m.call.intent"];
        }
    }

    /**
     * Parsed `slot_id` (format `{application}#{id}`) into its components (application and id).
     */
    public get slotDescription(): SlotDescription {
        return slotIdToDescription(this.slotId);
    }

    public get application(): string {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.application.type;
            case "session":
            default:
                return data.application;
        }
    }
    public get applicationData(): { type: string; [key: string]: unknown } {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.application;
            case "session":
            default:
                return { "type": data.application, "m.call.intent": data["m.call.intent"] };
        }
    }

    /** @deprecated scope is not used and will be removed in future versions. replaced by application specific types.*/
    public get scope(): CallScope | undefined {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return undefined;
            case "session":
            default:
                return data.scope;
        }
    }

    public get membershipID(): string {
        // the createdTs behaves equivalent to the membershipID.
        // we only need the field for the legacy member events where we needed to update them
        // synapse ignores sending state events if they have the same content.
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.member.id;
            case "session":
            default:
                return (this.createdTs() ?? "").toString();
        }
    }

    public createdTs(): number {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                // TODO we need to read the referenced (relation) event if available to get the real created_ts
                return this.matrixEvent.getTs();
            case "session":
            default:
                return data.created_ts ?? this.matrixEvent.getTs();
        }
    }

    /**
     * Gets the absolute expiry timestamp of the membership.
     * @returns The absolute expiry time of the membership as a unix timestamp in milliseconds or undefined if not applicable
     */
    public getAbsoluteExpiry(): number | undefined {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return undefined;
            case "session":
            default:
                // TODO: calculate this from the MatrixRTCSession join configuration directly
                return this.createdTs() + (data.expires ?? DEFAULT_EXPIRE_DURATION);
        }
    }

    /**
     * @returns The number of milliseconds until the membership expires or undefined if applicable
     */
    public getMsUntilExpiry(): number | undefined {
        const { kind } = this.membershipData;
        switch (kind) {
            case "rtc":
                return undefined;
            case "session":
            default:
                // Assume that local clock is sufficiently in sync with other clocks in the distributed system.
                // We used to try and adjust for the local clock being skewed, but there are cases where this is not accurate.
                // The current implementation allows for the local clock to be -infinity to +MatrixRTCSession.MEMBERSHIP_EXPIRY_TIME/2
                return this.getAbsoluteExpiry()! - Date.now();
        }
    }

    /**
     * @returns true if the membership has expired, otherwise false
     */
    public isExpired(): boolean {
        const { kind } = this.membershipData;
        switch (kind) {
            case "rtc":
                return false;
            case "session":
            default:
                return this.getMsUntilExpiry()! <= 0;
        }
    }

    /**
     * ## RTC Membership
     * Gets the primary transport to use for this RTC membership (m.rtc.member).
     * This will return the primary transport that is used by this call membership to publish their media.
     * Directly relates to the `rtc_transports` field.
     *
     * ## Legacy session membership
     * In case of a legacy session membership (m.call.member) this will return the selected transport where
     * media is published. How this selection happens depends on the `focus_active` field of the session membership.
     * If the `focus_selection` is `oldest_membership` this will return the transport of the oldest membership
     * in the room (based on the `created_ts` field of the session membership).
     * If the `focus_selection` is `multi_sfu` it will return the first transport of the `foci_preferred` list.
     * (`multi_sfu` is equivalent to how `m.rtc.member` `rtc_transports` work).
     * @param oldestMembership For backwards compatibility with session membership (legacy). Unused in case of RTC membership.
     * Always required to make the consumer not care if it deals with RTC or session memberships.
     * @returns The transport this membership uses to publish media or undefined if no transport is available.
     */
    public getTransport(oldestMembership: CallMembership): Transport | undefined {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.rtc_transports[0];
            case "session":
                switch (data.focus_active.focus_selection) {
                    case "multi_sfu":
                        return data.foci_preferred[0];
                    case "oldest_membership":
                        if (CallMembership.equal(this, oldestMembership)) return data.foci_preferred[0];
                        if (oldestMembership !== undefined) return oldestMembership.getTransport(oldestMembership);
                        break;
                }
        }
        return undefined;
    }

    /**
     * The focus_active filed of the session membership (m.call.member).
     * @deprecated focus_active is not used and will be removed in future versions.
     */
    public getFocusActive(): LivekitFocusSelection | undefined {
        const { kind, data } = this.membershipData;
        if (kind === "session") return data.focus_active;
        return undefined;
    }
    /**
     * The value of the `rtc_transports` field for RTC memberships (m.rtc.member).
     * Or the value of the `foci_preferred` field for legacy session memberships (m.call.member).
     */
    public get transports(): Transport[] {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.rtc_transports;
            case "session":
            default:
                return data.foci_preferred;
        }
    }
}
