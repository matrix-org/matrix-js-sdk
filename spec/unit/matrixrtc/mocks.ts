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

import { EventEmitter } from "stream";
import { type Mocked } from "jest-mock";

import { EventType, type Room, RoomEvent, type MatrixClient, type MatrixEvent } from "../../../src";
import { CallMembership } from "../../../src/matrixrtc/CallMembership";
import { secureRandomString } from "../../../src/randomstring";
import {
    DefaultCallApplicationDescription,
    RtcSlotEventContent,
    SlotDescription,
    slotDescriptionToId,
} from "../../../src/matrixrtc";
import { mkMatrixEvent } from "../../../src/testing";
import type { SessionMembershipData } from "../../../src/matrixrtc/membership/legacy";
import type { RtcMembershipData } from "../../../src/matrixrtc/membership/rtc";

export type MembershipData = (SessionMembershipData | RtcMembershipData | {}) & { user_id: string };

export const testStickyDurationMs = 10000;

export const sessionMembershipTemplate: SessionMembershipData & { user_id: string } = {
    application: "m.call",
    call_id: "",
    user_id: "@mock:user.example",
    device_id: "AAAAAAA",
    scope: "m.room",
    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
    foci_preferred: [
        {
            livekit_alias: "!alias:something.org",
            livekit_service_url: "https://livekit-jwt.something.io",
            type: "livekit",
        },
        {
            livekit_alias: "!alias:something.org",
            livekit_service_url: "https://livekit-jwt.something.dev",
            type: "livekit",
        },
    ],
};

export const rtcMembershipTemplate: RtcMembershipData & { user_id: string; __test_sticky_expiry?: number } = {
    slot_id: "m.call#",
    application: {
        "type": "m.call",
        "m.call.id": "",
    },
    user_id: "@mock:user.example",
    member: {
        claimed_user_id: "@mock:user.example",
        claimed_device_id: "AAAAAAA",
        id: "ea2MaingeeMo",
    },
    sticky_key: "ea2MaingeeMo",
    rtc_transports: [
        {
            livekit_alias: "!alias:something.org",
            livekit_service_url: "https://livekit-jwt.something.io",
            type: "livekit",
        },
        {
            livekit_alias: "!alias:something.org",
            livekit_service_url: "https://livekit-jwt.something.dev",
            type: "livekit",
        },
    ],
    versions: [],
};

export type MockClient = Pick<
    MatrixClient,
    | "getUserId"
    | "getDeviceId"
    | "sendEvent"
    | "sendStateEvent"
    | "_unstable_sendDelayedStateEvent"
    | "_unstable_updateDelayedEvent"
    | "_unstable_sendStickyEvent"
    | "_unstable_sendStickyDelayedEvent"
    | "cancelPendingEvent"
>;
/**
 * Mocks a object that has all required methods for a MatrixRTC session client.
 */
export function makeMockClient(userId: string, deviceId: string): MockClient {
    return {
        getDeviceId: () => deviceId,
        getUserId: () => userId,
        sendEvent: jest.fn(),
        sendStateEvent: jest.fn(),
        cancelPendingEvent: jest.fn(),
        _unstable_updateDelayedEvent: jest.fn(),
        _unstable_sendDelayedStateEvent: jest.fn(),
        _unstable_sendStickyEvent: jest.fn(),
        _unstable_sendStickyDelayedEvent: jest.fn(),
    };
}

export function makeMockRoom(
    membershipData: MembershipData[],
    useStickyEvents = false,
    slotDescription = DefaultCallApplicationDescription,
    addRTCSlot = useStickyEvents,
): Mocked<Room & { emitTimelineEvent: (event: MatrixEvent) => void }> {
    const roomId = secureRandomString(8);
    // Caching roomState here so it does not get recreated when calling `getLiveTimeline.getState()`
    const roomState = makeMockRoomState(
        useStickyEvents ? [] : membershipData,
        roomId,
        addRTCSlot ? slotDescription : undefined,
    );
    const ts = Date.now();
    const room = Object.assign(new EventEmitter(), {
        roomId: roomId,
        hasMembershipState: jest.fn().mockReturnValue(true),
        getLiveTimeline: jest.fn().mockReturnValue({
            getState: jest.fn().mockReturnValue(roomState),
        }),
        getVersion: jest.fn().mockReturnValue("default"),
        _unstable_getStickyEvents: jest
            .fn()
            .mockImplementation(() =>
                useStickyEvents
                    ? membershipData.map((m) =>
                          mockRTCEvent(
                              m,
                              roomId,
                              (m as typeof rtcMembershipTemplate).__test_sticky_expiry ?? testStickyDurationMs,
                              ts,
                          ),
                      )
                    : [],
            ) as any,
    });
    return Object.assign(room, {
        emitTimelineEvent: (event: MatrixEvent) =>
            room.emit(RoomEvent.Timeline, event, room, undefined, false, {} as any),
    }) as unknown as Mocked<Room & { emitTimelineEvent: (event: MatrixEvent) => void }>;
}

function makeMockRoomState(membershipData: MembershipData[], roomId: string, slotDescription?: SlotDescription) {
    const events = membershipData.map((m) => mockRTCEvent(m, roomId));
    const keysAndEvents = events.map((e) => {
        const data = e.getContent() as SessionMembershipData;
        return [`_${e.sender?.userId}_${data.device_id}`];
    });
    let slotEvent: MatrixEvent | undefined;

    if (slotDescription) {
        // Add a slot
        const stateKey = slotDescriptionToId(slotDescription);
        slotEvent = mkMatrixEvent({
            stateKey: stateKey,
            roomId,
            sender: "@anyadmin:example.org",
            type: EventType.RTCSlot,
            content: {
                application: {
                    type: slotDescription.application,
                },
                slot_id: slotDescriptionToId(slotDescription),
            } satisfies RtcSlotEventContent,
        });
    }

    return {
        on: jest.fn(),
        off: jest.fn(),
        getStateEvents: (type: string, stateKey: string) => {
            if (slotEvent && type === EventType.RTCSlot && stateKey === slotEvent.getStateKey()) return slotEvent;
            if (type !== EventType.GroupCallMemberPrefix) return null;
            if (stateKey !== undefined) return keysAndEvents.find(([k]) => k === stateKey)?.[1];
            return events;
        },
        events: new Map([
            [
                EventType.GroupCallMemberPrefix,
                {
                    size: () => true,
                    has: (stateKey: string) => keysAndEvents.find(([k]) => k === stateKey),
                    get: (stateKey: string) => keysAndEvents.find(([k]) => k === stateKey)?.[1],
                    values: () => events,
                },
            ],
            ...(slotEvent
                ? [
                      [
                          EventType.RTCSlot,
                          {
                              size: () => true,
                              has: (stateKey: string) => slotEvent.getStateKey() === stateKey,
                              get: (stateKey: string) => (slotEvent.getStateKey() === stateKey ? slotEvent : undefined),
                              values: () => [slotEvent],
                          },
                      ],
                  ]
                : []),
        ] as any),
    };
}

export function mockRoomState(room: Room, membershipData: MembershipData[], slotDescription?: SlotDescription): void {
    room.getLiveTimeline().getState = jest
        .fn()
        .mockReturnValue(makeMockRoomState(membershipData, room.roomId, slotDescription));
}

export function makeMockEvent(
    type: string,
    sender: string,
    roomId: string | undefined,
    content: any,
    timestamp?: number,
    stateKey?: string,
): MatrixEvent {
    return {
        getType: jest.fn().mockReturnValue(type),
        getContent: jest.fn().mockReturnValue(content),
        getSender: jest.fn().mockReturnValue(sender),
        getTs: jest.fn().mockReturnValue(timestamp ?? Date.now()),
        getRoomId: jest.fn().mockReturnValue(roomId),
        getId: jest.fn().mockReturnValue(secureRandomString(8)),
        getStateKey: jest.fn().mockReturnValue(stateKey),
        isDecryptionFailure: jest.fn().mockReturnValue(false),
    } as unknown as MatrixEvent;
}

export function mockRTCEvent(
    { user_id: sender, ...membershipData }: MembershipData,
    roomId: string,
    stickyDuration?: number,
    timestamp?: number,
): MatrixEvent {
    return {
        ...makeMockEvent(
            stickyDuration !== undefined ? EventType.RTCMembership : EventType.GroupCallMemberPrefix,
            sender,
            roomId,
            membershipData,
            timestamp,
            !stickyDuration && "device_id" in membershipData ? `_${sender}_${membershipData.device_id}` : "",
        ),
        unstableStickyExpiresAt: stickyDuration ? Date.now() + stickyDuration : undefined,
    } as unknown as MatrixEvent;
}

export function mockCallMembership(membershipData: MembershipData, roomId: string): CallMembership {
    return new CallMembership(mockRTCEvent(membershipData, roomId), membershipData);
}

export function makeKey(id: number, key: string): { key: string; index: number } {
    return {
        key: key,
        index: id,
    };
}
