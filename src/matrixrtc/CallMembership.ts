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

import { deepCompare } from "../utils.ts";
import { type RTCCallIntent, type Transport, type SlotDescription } from "./types.ts";
import { type IContent, type MatrixEvent } from "../models/event.ts";
import { logger } from "../logger.ts";
import { slotDescriptionToId, slotIdToDescription } from "./utils.ts";
import { checkSessionsMembershipData, type SessionMembershipData } from "./membership/legacy.ts";
import { checkRtcMembershipData, type RtcMembershipData } from "./membership/rtc.ts";
import { MatrixRTCMembershipParseError } from "./membership/common.ts";
import { EventType } from "../@types/event.ts";

/**
 * The default duration in milliseconds that a membership is considered valid for.
 * Ordinarily the client responsible for the session will update the membership before it expires.
 * We use this duration as the fallback case where stale sessions are present for some reason.
 */
export const DEFAULT_EXPIRE_DURATION = 1000 * 60 * 60 * 4;

/**
 * Describes the source event type that provided the membership data.
 */
enum MembershipKind {
    /**
     * The modern MSC4143 format event.
     */
    RTC = "rtc",
    /**
     * The legacy call event type.
     */
    Session = "session",
}

type MembershipData =
    | { kind: MembershipKind.RTC; data: RtcMembershipData }
    | { kind: MembershipKind.Session; data: SessionMembershipData };
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
        const evType = matrixEvent.getType();

        if (eventId === undefined) throw new Error("parentEvent is missing eventId field");
        if (sender === undefined) throw new Error("parentEvent is missing sender field");

        try {
            // Event types are strictly checked here.
            if (evType === EventType.RTCMembership && checkRtcMembershipData(data, sender)) {
                this.membershipData = { kind: MembershipKind.RTC, data };
            } else if (evType === EventType.GroupCallMemberPrefix && checkSessionsMembershipData(data)) {
                this.membershipData = { kind: MembershipKind.Session, data };
            } else {
                throw Error(`'${evType} is not a known call membership type`);
            }
        } catch (ex) {
            if (ex instanceof MatrixRTCMembershipParseError) {
                logger.debug("CallMembership.MatrixRTCMembershipParseError provided data", data);
            }
            throw ex;
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
            case MembershipKind.RTC:
                return data.member.claimed_user_id;
            case MembershipKind.Session:
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
            case MembershipKind.RTC:
                return data.slot_id;
            case MembershipKind.Session:
            default:
                return slotDescriptionToId({ application: this.application, id: data.call_id });
        }
    }

    public get deviceId(): string {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return data.member.claimed_device_id;
            case MembershipKind.Session:
            default:
                return data.device_id;
        }
    }

    public get callIntent(): RTCCallIntent | undefined {
        const intent = this.applicationData["m.call.intent"];
        if (typeof intent === "string") {
            return intent;
        }
        logger.warn("RTC membership has invalid m.call.intent");
        return undefined;
    }

    /**
     * Parsed `slot_id` (format `{application}#{id}`) into its components (application and id).
     */
    public get slotDescription(): SlotDescription {
        // TODO: Should this use content.application?
        return slotIdToDescription(this.slotId);
    }

    /**
     * The application `type`.
     * @deprecated Use @see applicationData
     */
    public get application(): string {
        return this.applicationData.type;
    }

    /**
     * Information about the application being used for the RTC session.
     * May contain extra keys specific to the application.
     */
    public get applicationData(): { type: string; [key: string]: unknown } {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return data.application;
            case MembershipKind.Session:
            default:
                // XXX: This is a hack around
                return { "type": data.application, "m.call.intent": data["m.call.intent"] };
        }
    }

    /** @deprecated scope is not used and will be removed in future versions. replaced by application specific types.*/
    public get scope(): SessionMembershipData["scope"] | undefined {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return undefined;
            case MembershipKind.Session:
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
            case MembershipKind.RTC:
                return data.member.id;
            case MembershipKind.Session:
            default:
                return (this.createdTs() ?? "").toString();
        }
    }

    public createdTs(): number {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                // TODO we need to read the referenced (relation) event if available to get the real created_ts
                return this.matrixEvent.getTs();
            case MembershipKind.Session:
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
            case MembershipKind.RTC:
                return this.matrixEvent.unstableStickyExpiresAt;
            case MembershipKind.Session:
            default:
                // TODO: calculate this from the MatrixRTCSession join configuration directly
                return this.createdTs() + (data.expires ?? DEFAULT_EXPIRE_DURATION);
        }
    }

    /**
     * @returns The number of milliseconds until the membership expires or undefined if applicable
     * @deprecated Not used by RTC events.
     */
    public getMsUntilExpiry(): number | undefined {
        const absExpiry = this.getAbsoluteExpiry();
        // Assume that local clock is sufficiently in sync with other clocks in the distributed system.
        // We used to try and adjust for the local clock being skewed, but there are cases where this is not accurate.
        // The current implementation allows for the local clock to be -infinity to +MatrixRTCSession.MEMBERSHIP_EXPIRY_TIME/2
        return absExpiry ? absExpiry - Date.now() : undefined;
    }

    /**
     * @returns true if the membership has expired, otherwise false
     */
    public isExpired(): boolean {
        const { kind } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return this.matrixEvent.unstableStickyExpiresAt
                    ? Date.now() > this.matrixEvent.unstableStickyExpiresAt
                    : false;
            case MembershipKind.Session:
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
            case MembershipKind.RTC:
                return data.rtc_transports[0];
            case MembershipKind.Session:
                if (data.focus_active.focus_selection === "oldest_membership") {
                    // For legacy events we only support "oldest_membership"
                    if (CallMembership.equal(this, oldestMembership)) return data.foci_preferred[0];
                    if (oldestMembership !== undefined) return oldestMembership.getTransport(oldestMembership);
                }
                break;
        }
        return undefined;
    }

    /**
     * The value of the `rtc_transports` field for RTC memberships (m.rtc.member).
     * Or the value of the `foci_preferred` field for legacy session memberships (m.call.member).
     */
    public get transports(): Transport[] {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return data.rtc_transports;
            case MembershipKind.Session:
            default:
                return data.foci_preferred;
        }
    }
}
