/*
Copyright 2023-2026 The Matrix.org Foundation C.I.C.

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
import { type MatrixEvent } from "../models/event.ts";
import { type Logger, logger } from "../logger.ts";
import { computeSlotId, slotIdToDescription } from "./utils.ts";
import {
    checkRtcMembershipData,
    computeRtcIdentityRaw,
    type RtcMembershipData,
    checkSessionsMembershipData,
    type SessionMembershipData,
    MatrixRTCMembershipParseError,
} from "./membershipData/index.ts";
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

type LimitedEvent = Pick<MatrixEvent, "getId" | "getSender" | "getTs" | "getType" | "getContent">;
// TODO: Rename to RtcMembership once we removed the legacy SessionMembership is removed, to avoid confusion.
export class CallMembership {
    /**
     * Parse the membershipdata from a call membership event.
     * @param matrixEvent The Matrix event to read.
     * @returns MembershipData in either MembershipKind.RTC or MembershipKind.Session format.
     * @throws If the content is neither format.
     */
    public static membershipDataFromMatrixEvent(matrixEvent: LimitedEvent): MembershipData {
        const sender = matrixEvent.getSender();
        const evType = matrixEvent.getType();
        const data = matrixEvent.getContent();
        if (sender === undefined) throw new Error("matrixEvent is missing sender field");
        try {
            // Event types are strictly checked here.
            if (evType === EventType.RTCMembership && checkRtcMembershipData(data, sender)) {
                return { kind: MembershipKind.RTC, data };
            } else if (evType === EventType.GroupCallMemberPrefix && checkSessionsMembershipData(data)) {
                return { kind: MembershipKind.Session, data };
            } else {
                throw Error(`'${evType} is not a known call membership type`);
            }
        } catch (ex) {
            if (ex instanceof MatrixRTCMembershipParseError) {
                logger.debug("CallMembership.MatrixRTCMembershipParseError provided invalid data", data);
            }
            throw ex;
        }
    }

    /**
     * Parse the contents of a MatrixEvent and create a CallMembership instance.
     * @param matrixEvent The Matrix event to read.
     */
    public static async parseFromEvent(matrixEvent: LimitedEvent): Promise<CallMembership> {
        const membershipData: MembershipData = this.membershipDataFromMatrixEvent(matrixEvent);
        const rtcBackendIdentity =
            membershipData.kind === MembershipKind.RTC
                ? await computeRtcIdentityRaw(
                      membershipData.data.member.user_id,
                      membershipData.data.member.device_id,
                      membershipData.data.member.id,
                  )
                : `${matrixEvent.getSender()}:${membershipData.data.device_id}`;
        return new CallMembership(matrixEvent, membershipData, rtcBackendIdentity);
    }

    public static equal(a?: CallMembership, b?: CallMembership): boolean {
        return deepCompare(a?.membershipData, b?.membershipData);
    }

    private logger: Logger;

    /** The parsed data from the Matrix event.
     * To access checked eventId and sender from the matrixEvent.
     * Class construction will fail if these values cannot get obtained. */
    private readonly matrixEventData: { eventId: string; sender: string };

    /**
     * Use `parseFromEvent`.
     * Constructor should only be used by tests.
     * @private
     * @param matrixEvent
     * @param membershipData
     * @param rtcBackendIdentity
     */
    public constructor(
        /** The Matrix event that this membership is based on */
        private readonly matrixEvent: LimitedEvent,
        private readonly membershipData: MembershipData,
        public readonly rtcBackendIdentity: string,
    ) {
        const eventId = matrixEvent.getId();
        const sender = matrixEvent.getSender();

        if (eventId === undefined) throw new Error("parentEvent is missing eventId field");
        if (sender === undefined) throw new Error("parentEvent is missing sender field");

        this.logger = logger.getChild(`[CallMembership ${sender}:${this.deviceId}]`);
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
                return data.member.user_id;
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
        if (data.application === "m.call") {
            switch (kind) {
                case MembershipKind.RTC:
                    return data.slot_id;
                case MembershipKind.Session:
                default: {
                    const [application, id] = [data.application, data.call_id];

                    // INFO_SLOT_ID_LEGACY_CASE  (search for all occurances of this INFO to get the full picture)
                    // The spec got changed to use `"ROOM"` instead of `""` empyt string for the implicit default call.
                    // State events still are sent with `""` however. To find other events that should end up in the same call,
                    // we use the slotId.
                    // Since the CallMembership is the public representation of a rtc.member event, we just pretend it is a
                    // "ROOM" slotId/call_id.
                    // This makes all the remote members work with just this simple trick.
                    //
                    // We of course now need to be careful when sending legacy events (state events)
                    // They get a slotDescription containing "ROOM" since this is what we use starting at the time this comment
                    // is commited.
                    //
                    // See the Other INFO_SLOT_ID_LEGACY_CASE comments to see where we revert back to "" just before sending the event.
                    let compatibilityAdaptedId: string;
                    if (id === "") {
                        compatibilityAdaptedId = "ROOM";
                        this.logger?.info("use slotId compat hack emptyString -> ROOM");
                    } else {
                        compatibilityAdaptedId = id;
                    }
                    return computeSlotId({
                        application,
                        id: compatibilityAdaptedId,
                    });
                }
            }
        }

        this.logger?.info("NOT using slotId compat hack emptyString -> ROOM");
        // This is what the function should look like for any other application that did not
        // go through a `""`=> `"ROOM"` rename
        switch (kind) {
            case MembershipKind.RTC:
                return data.slot_id;
            case MembershipKind.Session:
            default:
                return computeSlotId({ application: data.application, id: data.call_id });
        }
    }

    public get deviceId(): string {
        const { kind, data } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return data.member.device_id;
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
        this.logger.warn("RTC membership has invalid m.call.intent");
        return undefined;
    }

    /**
     * Parsed `slot_id` (format `{application}#{id}`) into its components (application and id).
     */
    public get slotDescription(): SlotDescription {
        const { kind, data } = this.membershipData;
        if (kind === MembershipKind.RTC) {
            const id = data.slot_id.slice(`${data.application.type}#`.length);
            return { application: data.application.type, id };
        }
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
                // SessionData does not have application data as such. We return specific
                // properties in use by other getters in this class, for compatibility.
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

    /**
     * This computes the membership ID for the membership.
     * For the sticky event based rtcSessionData this is trivial it is `member.id`.
     * This is not supposed to be used to identity on an rtc backend. This is just a nouance for
     * a generated (sha256) anonymised identity. Only send `rtcBackendIdentity` to any rtc backend service.
     *
     * For the legacy sessionMemberEvents it is a bit more complex. Here we sometimes do not have this data
     * in the event content and we expected the SFU and the client to use `${this.matrixEventData.sender}:${data.device_id}`.
     *
     * So if there is no membershipID we use the hard coded jwt id default (`${this.matrixEventData.sender}:${data.device_id}`)
     * value (used until version 0.16.0)
     *
     * It is also possible for a session event to set a custom membershipID. in that case this will be used.
     */
    public get memberId(): string {
        // the createdTs behaves equivalent to the membershipID.
        // we only need the field for the legacy member events where we needed to update them
        // synapse ignores sending state events if they have the same content.
        const { kind, data } = this.membershipData;
        switch (kind) {
            case "rtc":
                return data.member.id;
            case "session":
                return (
                    // best case we have a client already publishing the right custom membershipId
                    data.membershipID ??
                    // alternativly we use the hard coded jwt id defuatl value (used until version 0.16.0)
                    `${this.matrixEventData.sender}:${data.device_id}`
                );
            default:
                throw Error("Not possible to get memberID without knowing the membership event kind");
        }
    }

    /**
     * @deprecated renamed to `memberId`
     */
    public get membershipID(): string {
        return this.memberId;
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
                return undefined;
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
        const { kind } = this.membershipData;
        if (kind === MembershipKind.Session) {
            const absExpiry = this.getAbsoluteExpiry();
            if (absExpiry) {
                // Assume that local clock is sufficiently in sync with other clocks in the distributed system.
                // We used to try and adjust for the local clock being skewed, but there are cases where this is not accurate.
                // The current implementation allows for the local clock to be -infinity to +MatrixRTCSession.MEMBERSHIP_EXPIRY_TIME/2
                return absExpiry - Date.now();
            }
        }
        return undefined;
    }

    /**
     * @returns true if the membership has expired, otherwise false
     */
    public isExpired(): boolean {
        const { kind } = this.membershipData;
        switch (kind) {
            case MembershipKind.RTC:
                return false;
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
                switch (data.focus_active.focus_selection) {
                    case "oldest_membership":
                        if (CallMembership.equal(this, oldestMembership)) return data.foci_preferred[0];
                        if (oldestMembership !== undefined) return oldestMembership.getTransport(oldestMembership);
                        break;
                    case "multi_sfu":
                        return data.foci_preferred[0];
                    default:
                        // `focus_selection` not understood.
                        return undefined;
                }
                break;
            default:
                return undefined;
        }
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
