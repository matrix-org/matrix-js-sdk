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
import type { IContent, IMentions } from "../matrix.ts";
import type { RelationEvent } from "../types.ts";
import type { CallMembership } from "./CallMembership.ts";

export type ParticipantId = string;

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
    key: Uint8Array;
    participantId: ParticipantId;
    keyIndex: number;
    creationTS: number;
};

/**
 * The information about the key used to encrypt video streams.
 */
export type OutboundEncryptionSession = {
    key: Uint8Array;
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
 * This will check if the content has all the expected fields to be a valid IRTCNotificationContent.
 * It will also cap the lifetime to 90000ms (1.5 min) if a higher value is provided.
 * @param content
 * @throws if the content is invalid
 * @returns a parsed IRTCNotificationContent
 */
export function parseCallNotificationContent(content: IContent): IRTCNotificationContent {
    if (content["m.mentions"] && typeof content["m.mentions"] !== "object") {
        throw new Error("malformed m.mentions");
    }
    if (typeof content["notification_type"] !== "string") {
        throw new Error("Missing or invalid notification_type");
    }
    if (typeof content["sender_ts"] !== "number") {
        throw new Error("Missing or invalid sender_ts");
    }
    if (typeof content["lifetime"] !== "number") {
        throw new Error("Missing or invalid lifetime");
    }

    if (content["relation"] && content["relation"]["rel_type"] !== "m.reference") {
        throw new Error("Invalid relation");
    }
    if (content["m.call.intent"] && typeof content["m.call.intent"] !== "string") {
        throw new Error("Invalid m.call.intent");
    }

    const cappedLifetime = content["lifetime"] >= 90000 ? 90000 : content["lifetime"];
    return { ...content, lifetime: cappedLifetime } as IRTCNotificationContent;
}

/**
 * Interface for `org.matrix.msc4075.rtc.notification` events.
 * Don't cast event content to this directly. Use `parseCallNotificationContent` instead to validate the content first.
 */
export interface IRTCNotificationContent extends RelationEvent {
    "m.mentions"?: IMentions;
    "notification_type": RTCNotificationType;
    /**
     * The initial intent of the calling user.
     */
    "m.call.intent"?: RTCCallIntent;
    "sender_ts": number;
    "lifetime": number;
}

/**
 * MSC4310 decline event content for `org.matrix.msc4310.rtc.decline`.
 * Sent as a standard m.reference relation to an `org.matrix.msc4075.rtc.notification` event.
 */
export interface IRTCDeclineContent extends RelationEvent {}

export enum Status {
    Disconnected = "Disconnected",
    Connecting = "Connecting",
    ConnectingFailed = "ConnectingFailed",
    Connected = "Connected",
    Reconnecting = "Reconnecting",
    Disconnecting = "Disconnecting",
    Stuck = "Stuck",
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
