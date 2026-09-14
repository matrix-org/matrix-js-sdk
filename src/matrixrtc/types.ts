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
import type { IContent, IMentions } from "../matrix.ts";
import type { RelationEvent } from "../types.ts";
import type { MatrixEvent } from "../models/event.ts";
import type { Room } from "../models/room.ts";
import { EventTimeline } from "../models/event-timeline.ts";
import { EventType, RelationType } from "../@types/event.ts";
import { CallMembership } from "./CallMembership.ts";
import { type CallMembershipIdentityParts } from "./EncryptionManager.ts";
import { isLeftMembershipContent } from "./membershipData/index.ts";
import { isSlotClosed, slotIdToDescription } from "./utils.ts";

export type EncryptionKeyMapKey = string;

export interface EncryptionKeyEntry {
    index: number;
    key: string;
}

/**
 * The mxID, deviceId and membership timestamp of a RTC session participant.
 */
export type ParticipantDeviceInfo = {
    userId: string;
    deviceId: string;
    membershipTs: number;
};

/**
 * A type representing the information needed to decrypt video streams.
 */
export type InboundEncryptionSession = {
    key: Uint8Array<ArrayBuffer>;
    membership: CallMembershipIdentityParts;
    keyIndex: number;
    creationTS: number;
};

/**
 * The information about the key used to encrypt video streams.
 */
export type OutboundEncryptionSession = {
    key: Uint8Array<ArrayBuffer>;
    creationTS: number;
    // The devices that this key is shared with.
    sharedWith: Array<ParticipantDeviceInfo>;
    // This is an index acting as the id of the key
    keyId: number;
};

export interface EncryptionKeysEventContent {
    keys: EncryptionKeyEntry[];
    device_id: string;
    call_id: string;
    sent_ts?: number;
}

/**
 * THe content of a to-device event that contains encryption keys.
 */
export interface EncryptionKeysToDeviceEventContent {
    keys: { index: number; key: string };
    member: {
        id: string;
        // TODO Remove that it is claimed, need to get the sealed sender from decryption info
        // Or add some validation on it based on the encryption info
        claimed_device_id: string;
    };
    room_id: string;
    session: {
        application: string;
        call_id: string;
        scope: string;
    };
    // Why is this needed?
    sent_ts?: number;
}
/**
 * @deprecated Use `RTCNotificationType` instead.
 */
export type CallNotifyType = "ring" | "notify";
/**
 * @deprecated Use `IRTCNotificationContent` instead.
 */
export interface ICallNotifyContent {
    "application": string;
    "m.mentions": IMentions;
    "notify_type": CallNotifyType;
    "call_id": string;
}

export type RTCNotificationType = "ring" | "notification";

/**
 * Represents the intention of the call from the perspective of the sending user.
 * May be any string, although `"audio"` and `"video"` are commonly accepted values.
 */
export type RTCCallIntent = "audio" | "video" | string;

/**
 * The maximum `lifetime` of an RTC notification as per MSC4075. Larger values are capped to this.
 *
 * Exported for use within the js-sdk only. Not re-exported from `matrixrtc/index.ts`.
 * @internal
 */
export const RTC_NOTIFICATION_MAX_LIFETIME_MS = 2 * 60 * 1000; // 2 minutes

/**
 * The maximum amount by which a notification's `sender_ts` may lie ahead of its `origin_server_ts`
 * before the `lifetime` is measured from `origin_server_ts` instead, as per MSC4075.
 *
 * Exported for use within the js-sdk only. Not re-exported from `matrixrtc/index.ts`.
 * @internal
 */
export const RTC_NOTIFICATION_MAX_SENDER_TS_AHEAD_MS = 20 * 1000; // 20 seconds

/**
 * The context that is needed to evaluate the MSC4075 rules for receiving notifications.
 */
export interface RTCNotificationValidationContext {
    /** The room in which the notification was received. */
    room: Pick<
        Room,
        | "getLiveTimeline"
        | "findEventById"
        | "getUnfilteredTimelineSet"
        | "_unstable_getStickyEvents"
        | "_unstable_getKeyedStickyEvent"
    >;
    /** The user ID of the receiving (local) user. */
    userId: string;
    /** The current time in milliseconds since the epoch. Defaults to `Date.now()`. */
    now?: number;
}

/**
 * Computes the absolute timestamp at which an RTC notification stops being valid, as per MSC4075.
 *
 * The `lifetime` is measured from `sender_ts` unless `sender_ts` lies more than 20 seconds ahead of
 * `origin_server_ts`, in which case it is measured from `origin_server_ts` instead. Regardless of the basis,
 * the remaining lifetime is capped at 2 minutes.
 *
 * @param content The notification content.
 * @param originServerTs The `origin_server_ts` of the notification event.
 * @param now The current time in milliseconds since the epoch. Defaults to `Date.now()`.
 * @returns The timestamp (in milliseconds since the epoch) at which the notification expires.
 */
export function getCallNotificationExpiry(
    content: Pick<IRTCNotificationContent, "sender_ts" | "lifetime">,
    originServerTs: number,
    now: number = Date.now(),
): number {
    const basis =
        content.sender_ts - originServerTs > RTC_NOTIFICATION_MAX_SENDER_TS_AHEAD_MS
            ? originServerTs
            : content.sender_ts;
    return Math.min(basis + content.lifetime, now + RTC_NOTIFICATION_MAX_LIFETIME_MS);
}

/**
 * The subset of a notification event that {@link parseCallNotificationContent} needs.
 */
type RTCNotificationEvent = Pick<
    MatrixEvent,
    "getContent" | "getId" | "getSender" | "getTs" | "getType" | "unstableStickyInfo"
>;

/**
 * Whether the content marks a withdrawn sticky event (MSC4354), i.e. it is empty apart from the sticky key.
 */
function isWithdrawal(content: IContent): boolean {
    return Object.keys(content).every((key) => key === "msc4354_sticky_key");
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * Looks up a membership event by ID in the room's timeline and sticky event map.
 *
 * @returns The event, or `undefined` if it isn't available locally.
 */
function findMembershipEvent(room: RTCNotificationValidationContext["room"], eventId: string): MatrixEvent | undefined {
    const timelineEvent = room.findEventById(eventId);
    if (timelineEvent) return timelineEvent;

    // Sticky member events that arrived outside of the timeline aren't found by `findEventById`.
    for (const stickyEvent of room._unstable_getStickyEvents()) {
        if (stickyEvent.getId() === eventId) return stickyEvent;
    }
    return undefined;
}

/**
 * Determines the ID of the slot that a notification invites to.
 *
 * Notifications predating the `slot_id` property instead carry an `m.reference` relation to the sender's
 * membership event. For those, the slot is read off that membership event, which therefore has to be
 * available locally. This is normally the case, since a notification is only valid while the session it
 * invites to is live, but it does mean such a notification can't be evaluated from the event alone.
 *
 * @throws if the slot can't be determined.
 * @returns A promise resolving to the slot ID.
 */
async function resolveSlotId(content: IContent, room: RTCNotificationValidationContext["room"]): Promise<string> {
    if (typeof content["slot_id"] === "string") {
        // Throws if the ID is malformed, e.g. because it contains more than one "#".
        slotIdToDescription(content["slot_id"]);
        return content["slot_id"];
    }
    if (content["slot_id"] !== undefined) throw new Error("Invalid slot_id");

    const relation = content["m.relates_to"];
    const membershipEventId = relation?.rel_type === RelationType.Reference ? relation.event_id : undefined;
    if (typeof membershipEventId !== "string") {
        throw new Error("Missing slot_id and no m.reference relation to derive it from");
    }

    const membershipEvent = findMembershipEvent(room, membershipEventId);
    if (!membershipEvent) {
        throw new Error(`Missing slot_id and referenced event ${membershipEventId} is not available locally`);
    }

    try {
        return (await CallMembership.parseFromEvent(membershipEvent)).slotId;
    } catch (cause) {
        throw new Error(`Missing slot_id and referenced event ${membershipEventId} is not a valid membership`, {
            cause,
        });
    }
}

/**
 * Parses the content of a received `org.matrix.msc4075.rtc.notification` event.
 *
 * This checks that the content matches the schema of MSC4075, caps `lifetime` to 2 minutes and applies
 * the rules for receiving invites from MSC4075.
 * The notification is only considered valid if all of the following hold:
 * - It wasn't sent by the receiving user.
 * - It is the current entry in the room's sticky event map for its sender and slot and isn't a withdrawal.
 * - The slot it refers to exists and is open.
 * - Its lifetime hasn't elapsed (see {@link getCallNotificationExpiry}).
 * - Its `m.mentions` target the receiving user, either directly or via a room mention that the sender is
 *   allowed to trigger.
 * - The receiving user has no joined `m.rtc.member` event for the slot in the sticky event map.
 * - Any left `m.rtc.member` event of the receiving user for the slot predates the notification.
 * - The receiving user has no sticky decline event referencing the notification.
 *
 * @param event The notification event.
 * @param context The context needed to evaluate the receiving rules.
 * @throws if the content is malformed or the notification isn't valid.
 * @returns A promise resolving to the parsed content.
 */
export async function parseCallNotificationContent(
    event: RTCNotificationEvent,
    context: RTCNotificationValidationContext,
): Promise<IRTCNotificationContent> {
    if (event.getType() !== EventType.RTCNotification) {
        throw new Error(`Event ${event.getId()} is not an ${EventType.RTCNotification} event`);
    }

    const content = event.getContent();
    if (isWithdrawal(content)) {
        throw new Error("Notification was withdrawn");
    }

    const slotId = await resolveSlotId(content, context.room);
    // The sticky key is only validated when present. A notification predating it can still be valid, and one
    // carrying the wrong key is filed under that key in the sticky event map, so the lookup below rejects it.
    if (content["msc4354_sticky_key"] !== undefined && content["msc4354_sticky_key"] !== slotId) {
        throw new Error("msc4354_sticky_key must be equal to slot_id");
    }
    if (!isNonNegativeInteger(content["sender_ts"])) {
        throw new Error("Missing or invalid sender_ts");
    }
    if (!isNonNegativeInteger(content["lifetime"])) {
        throw new Error("Missing or invalid lifetime");
    }

    const mentions = content["m.mentions"];
    if (typeof mentions !== "object" || mentions === null) {
        throw new Error("Missing or malformed m.mentions");
    }
    if (mentions.room !== undefined && typeof mentions.room !== "boolean") {
        throw new Error("malformed m.mentions.room");
    }
    if (
        mentions.user_ids !== undefined &&
        (!Array.isArray(mentions.user_ids) || !mentions.user_ids.every((userId) => typeof userId === "string"))
    ) {
        throw new Error("malformed m.mentions.user_ids");
    }
    if (mentions.room !== true && !mentions.user_ids?.length) {
        throw new Error("m.mentions must target either the room or at least one user");
    }

    const parsed = {
        ...content,
        slot_id: slotId,
        lifetime: Math.min(content["lifetime"], RTC_NOTIFICATION_MAX_LIFETIME_MS),
    } as IRTCNotificationContent;

    await checkCallNotificationReceivingRules(parsed, event, context);

    return parsed;
}

/**
 * Applies the MSC4075 rules for receiving invites to an already schema-validated notification.
 * @throws if any of the rules is violated.
 */
async function checkCallNotificationReceivingRules(
    content: IRTCNotificationContent,
    event: RTCNotificationEvent,
    { room, userId, now = Date.now() }: RTCNotificationValidationContext,
): Promise<void> {
    const eventId = event.getId();
    const sender = event.getSender();
    if (eventId === undefined || sender === undefined) {
        throw new Error("Notification event is missing its event ID or sender");
    }
    const originServerTs = event.getTs();
    const slotId = content.slot_id;

    if (sender === userId) {
        throw new Error("Notification was sent by the receiving user");
    }

    // A notification that wasn't delivered as a sticky event can't be superseded or withdrawn, so there is
    // nothing to check. It isn't in the sticky event map either, which is why this can't be checked blindly.
    if (event.unstableStickyInfo !== undefined) {
        if (room._unstable_getKeyedStickyEvent(sender, event.getType(), slotId)?.getId() !== eventId) {
            throw new Error("Notification is not the current sticky event for its sender and slot");
        }
    }

    // `isSlotClosed` returns undefined when no slot event exists at all, which is just as disqualifying.
    if (isSlotClosed(room, slotIdToDescription(slotId)) !== false) {
        throw new Error(`Slot ${slotId} does not exist or is not open`);
    }
    const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS);

    if (now >= getCallNotificationExpiry(content, originServerTs, now)) {
        throw new Error("Notification has expired");
    }

    const mentions = content["m.mentions"];
    const mentionsUser = mentions.user_ids?.includes(userId) ?? false;
    const mentionsRoom = mentions.room === true && (roomState?.mayTriggerNotifOfType("room", sender) ?? false);
    if (!mentionsUser && !mentionsRoom) {
        throw new Error("Notification does not mention the receiving user");
    }

    for (const membershipEvent of ownMembershipEvents(room, userId)) {
        const membershipContent = membershipEvent.getContent();
        if (isLeftMembershipContent(membershipContent)) {
            // Left memberships carry no application data, so the only slot they can be attributed to is the
            // one in `slot_id`. Those predating that property are assumed to belong to this slot, to avoid
            // re-notifying for a session that the user already left.
            const isForSlot = membershipContent.slot_id === undefined || membershipContent.slot_id === slotId;
            if (isForSlot && membershipEvent.getTs() >= originServerTs) {
                throw new Error(`Receiving user left slot ${slotId} after the notification was sent`);
            }
        } else if (await isJoinedToSlot(membershipEvent, slotId, now)) {
            throw new Error(`Receiving user is already joined to slot ${slotId}`);
        }
    }

    if (hasDeclined(room, userId, eventId)) {
        throw new Error("Receiving user declined the notification");
    }
}

/**
 * Yields the receiving user's own MatrixRTC membership events, from both the sticky event map and the legacy
 * member state events. Sessions that don't use sticky events keep membership in state, so both have to be
 * consulted to tell whether the user is in a session.
 *
 * @yields the user's own `m.rtc.member` and `m.call.member` events.
 */
function* ownMembershipEvents(room: RTCNotificationValidationContext["room"], userId: string): Iterable<MatrixEvent> {
    for (const stickyEvent of room._unstable_getStickyEvents()) {
        if (stickyEvent.getType() === EventType.RTCMembership && stickyEvent.getSender() === userId) {
            yield stickyEvent;
        }
    }

    const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    for (const stateEvent of roomState?.getStateEvents(EventType.GroupCallMemberPrefix) ?? []) {
        if (stateEvent.getSender() === userId) yield stateEvent;
    }
}

/**
 * Whether the given membership event places its sender in the given slot, i.e. it is a valid, unexpired
 * membership for that slot.
 */
async function isJoinedToSlot(membershipEvent: MatrixEvent, slotId: string, now: number): Promise<boolean> {
    let membership: CallMembership;
    try {
        membership = await CallMembership.parseFromEvent(membershipEvent);
    } catch {
        // Not a membership we understand, so it doesn't place the user anywhere.
        return false;
    }
    if (membership.slotId !== slotId) return false;

    // Legacy memberships go stale when the client that sent them disappears without leaving. Honouring an
    // expired one would suppress notifications for hours.
    const expiry = membership.getAbsoluteExpiry();
    return expiry === undefined || expiry > now;
}

/**
 * Whether the receiving user has declined the given notification.
 *
 * Declines are looked up both through their `m.reference` relation and in the sticky event map. Relations
 * cover declines that couldn't be sent as sticky events, but only see events that reached the timeline. A
 * sticky decline delivered after a gappy or initial sync arrives via the sticky section instead, so it is
 * only in the map.
 */
function hasDeclined(room: RTCNotificationValidationContext["room"], userId: string, eventId: string): boolean {
    const declines = room
        .getUnfilteredTimelineSet()
        .relations.getChildEventsForEvent(eventId, RelationType.Reference, EventType.RTCDecline);
    if (declines?.getRelations().some((decline) => decline.getSender() === userId)) return true;

    // Declines are keyed on the event ID of the notification they decline.
    return room._unstable_getKeyedStickyEvent(userId, EventType.RTCDecline, eventId) !== undefined;
}

/**
 * Interface for `org.matrix.msc4075.rtc.notification` events.
 * Don't cast event content to this directly. Use `parseCallNotificationContent` instead to validate the content first.
 */
export interface IRTCNotificationContent extends RelationEvent {
    /**
     * The `state_key` of the `m.rtc.slot` event that the notification refers to.
     *
     * Notifications predating this property omit it. `parseCallNotificationContent` fills it in from the
     * referenced membership event, so the parsed content always carries it.
     */
    "slot_id": string;
    /**
     * The users targeted by the notification. Must either mention the room or at least one user.
     */
    "m.mentions": IMentions;
    /**
     * @deprecated Not part of MSC4075 anymore. How to present a notification is up to the receiving client.
     */
    "notification_type"?: RTCNotificationType;
    /**
     * @deprecated Not part of MSC4075 anymore. The initial intent of the calling user.
     */
    "m.call.intent"?: RTCCallIntent;
    /**
     * The timestamp (in milliseconds since the epoch) at which the sending client created the event.
     */
    "sender_ts": number;
    /**
     * The time (in milliseconds) that the notification is valid for, measured from `sender_ts`.
     */
    "lifetime": number;
    /**
     * The sticky key as per MSC4354. Must be equal to `slot_id`.
     *
     * Optional because notifications predating MSC4354 omit it.
     */
    "msc4354_sticky_key"?: string;
}

/**
 * MSC4310 decline event content for `org.matrix.msc4310.rtc.decline`.
 * Sent as a standard m.reference relation to an `org.matrix.msc4075.rtc.notification` event.
 */
export interface IRTCDeclineContent extends RelationEvent {
    /**
     * The sticky key as per MSC4354. Must be equal to the event ID of the notification being declined.
     *
     * Optional because servers without MSC4354 support can't deliver the decline as a sticky event. Such a
     * decline still counts, but only for devices that receive it directly, since it isn't re-delivered after
     * a gappy or initial sync.
     */
    msc4354_sticky_key?: string;
}

export enum Status {
    Disconnected = "Disconnected",
    Connecting = "Connecting",
    Connected = "Connected",
    Disconnecting = "Disconnecting",
    Unknown = "Unknown",
}

/**
 * A type collecting call encryption statistics for a session.
 */
export type Statistics = {
    counters: {
        /**
         * The number of times we have sent a room event containing encryption keys.
         */
        roomEventEncryptionKeysSent: number;
        /**
         * The number of times we have received a room event containing encryption keys.
         */
        roomEventEncryptionKeysReceived: number;
    };
    totals: {
        /**
         * The total age (in milliseconds) of all room events containing encryption keys that we have received.
         * We track the total age so that we can later calculate the average age of all keys received.
         */
        roomEventEncryptionKeysReceivedTotalAge: number;
    };
};

export const isMyMembership = (m: CallMembership, userId: string, deviceId: string): boolean =>
    m.sender === userId && m.deviceId === deviceId;

/**
 *  A RTC transport is a JSON object that describes how to connect to a RTC member.
 */
export interface Transport {
    type: string;
    [key: string]: unknown;
}

/**
 * Event content for `org.matrix.msc4143.rtc.slot` state events.
 */
export interface RtcSlotEventContent<T extends string = string> {
    status: "open" | "closed";
    application?: RtcSlotApplicationContent<T>;
    encryption?: RtcSlotEncryptionContent;
}

/**
 * Content of the `application` object within `org.matrix.msc4143.rtc.slot` events.
 */
export interface RtcSlotApplicationContent<T extends string = string> {
    type: T;
    // Other application specific keys.
    [key: string]: unknown;
}

export const RTC_SLOT_ENCRYPTION_PER_MEMBER = "org.matrix.msc4143.per_member";

/**
 * Content of the `encryption` object within `org.matrix.msc4143.rtc.slot` events.
 */
export interface RtcSlotEncryptionContent {
    type: typeof RTC_SLOT_ENCRYPTION_PER_MEMBER;
    // Other encryption-mechanism specific keys.
    [key: string]: unknown;
}

/**
 * The session description is used to identify a session. Used in the state event.
 */
export interface SlotDescription {
    /**
     * The application type. e.g. "m.call".
     */
    application: string;
    /**
     * The application-specific slot ID. e.g. "ROOM".
     */
    id: string;
}
