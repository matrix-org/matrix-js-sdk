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
import type { IMentions } from "../matrix.ts";
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
export interface IRTCNotificationContent extends RelationEvent {
    "m.mentions": IMentions;
    "decline_reason"?: string;
    "notification_type": RTCNotificationType;
    "sender_ts": number;
    "lifetime": number;
}

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
