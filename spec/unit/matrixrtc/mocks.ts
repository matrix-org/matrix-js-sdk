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

import { EventEmitter } from "stream";
import { type Mocked, type MockedObject } from "vitest";

import { EventType, type Room, RoomEvent, type MatrixClient, type MatrixEvent } from "../../../src";
import { CallMembership } from "../../../src/matrixrtc";
import { secureRandomString } from "../../../src/randomstring";
import { type RtcMembershipData, type SessionMembershipData } from "../../../src/matrixrtc/membershipData";
import { type CallMembershipIdentityParts } from "../../../src/matrixrtc/EncryptionManager";

export type MembershipData = (SessionMembershipData | RtcMembershipData | {}) & { user_id: string };

export const owmMemberIdentity: CallMembershipIdentityParts = {
    deviceId: "AAAAAAA",
    memberId: "@alice:example.org:AAAAAAA",
    userId: "@alice:example.org",
};

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

export const rtcMembershipTemplate: RtcMembershipData & { user_id: string } = {
    user_id: "@mock:user.example",
    application: {
        type: "m.call",
    },
    member: {
        id: "IDIDID",
        user_id: "@mock:user.example",
        device_id: "AAAAAAA",
    },
    slot_id: "m.call#ROOM",
    versions: [],
    rtc_transports: [
        {
            type: "livekit",
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
        },
    ],
    msc4354_sticky_key: "m.call#",
};

export type MockClient = MockedObject<
    Pick<
        MatrixClient,
        | "getUserId"
        | "getDeviceId"
        | "sendEvent"
        | "sendStateEvent"
        | "_unstable_sendDelayedStateEvent"
        | "_unstable_updateDelayedEvent"
        | "_unstable_cancelScheduledDelayedEvent"
        | "_unstable_restartScheduledDelayedEvent"
        | "_unstable_sendScheduledDelayedEvent"
        | "_unstable_sendStickyEvent"
        | "_unstable_sendStickyDelayedEvent"
        | "cancelPendingEvent"
    >
>;
/**
 * Mocks a object that has all required methods for a MatrixRTC session client.
 */
export function makeMockClient(userId: string, deviceId: string): MockClient {
    return {
        getDeviceId: vi.fn(() => deviceId),
        getUserId: vi.fn(() => userId),
        sendEvent: vi.fn(),
        sendStateEvent: vi.fn(),
        cancelPendingEvent: vi.fn(),
        _unstable_updateDelayedEvent: vi.fn(),
        _unstable_cancelScheduledDelayedEvent: vi.fn(),
        _unstable_restartScheduledDelayedEvent: vi.fn(),
        _unstable_sendScheduledDelayedEvent: vi.fn(),
        _unstable_sendDelayedStateEvent: vi.fn(),
        _unstable_sendStickyEvent: vi.fn(),
        _unstable_sendStickyDelayedEvent: vi.fn(),
    } as MockClient;
}

export function makeMockRoom(
    membershipData: MembershipData[],
    useStickyEvents = false,
): Mocked<Room & { emitTimelineEvent: (event: MatrixEvent) => void }> {
    const roomId = secureRandomString(8);
    // Caching roomState here so it does not get recreated when calling `getLiveTimeline.getState()`
    const roomState = makeMockRoomState(useStickyEvents ? [] : membershipData, roomId);
    const ts = Date.now();
    const room = Object.assign(new EventEmitter(), {
        roomId: roomId,
        hasMembershipState: vi.fn().mockReturnValue(true),
        getLiveTimeline: vi.fn().mockReturnValue({
            getState: vi.fn().mockReturnValue(roomState),
        }),
        getVersion: vi.fn().mockReturnValue("default"),
        _unstable_getStickyEvents: vi
            .fn()
            .mockImplementation(() =>
                useStickyEvents ? membershipData.map((m) => mockRTCEvent(m, roomId, 10000, ts)) : [],
            ) as any,
    });
    return Object.assign(room, {
        emitTimelineEvent: (event: MatrixEvent) =>
            room.emit(RoomEvent.Timeline, event, room, undefined, false, {} as any),
    }) as unknown as Mocked<Room & { emitTimelineEvent: (event: MatrixEvent) => void }>;
}

function makeMockRoomState(membershipData: MembershipData[], roomId: string) {
    const events = membershipData.map((m) => mockRTCEvent(m, roomId));
    const keysAndEvents = events.map((e) => {
        const data = e.getContent() as SessionMembershipData;
        return [`_${e.sender?.userId}_${data.device_id}`];
    });

    return {
        on: vi.fn(),
        off: vi.fn(),
        getStateEvents: (_: string, stateKey: string) => {
            if (stateKey !== undefined) return keysAndEvents.find(([k]) => k === stateKey)?.[1];
            return events;
        },
        events:
            events.length === 0
                ? new Map()
                : new Map([
                      [
                          EventType.GroupCallMemberPrefix,
                          {
                              size: () => true,
                              has: (stateKey: string) => keysAndEvents.find(([k]) => k === stateKey),
                              get: (stateKey: string) => keysAndEvents.find(([k]) => k === stateKey)?.[1],
                              values: () => events,
                          },
                      ],
                  ]),
    };
}

export function mockRoomState(room: Room, membershipData: MembershipData[]): void {
    room.getLiveTimeline().getState = vi.fn().mockReturnValue(makeMockRoomState(membershipData, room.roomId));
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
        getType: vi.fn().mockReturnValue(type),
        getContent: vi.fn().mockReturnValue(content),
        getSender: vi.fn().mockReturnValue(sender),
        getTs: vi.fn().mockReturnValue(timestamp ?? Date.now()),
        getRoomId: vi.fn().mockReturnValue(roomId),
        getId: vi.fn().mockReturnValue(secureRandomString(8)),
        getStateKey: vi.fn().mockReturnValue(stateKey),
        isDecryptionFailure: vi.fn().mockReturnValue(false),
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
        unstableStickyExpiresAt: stickyDuration,
    } as unknown as MatrixEvent;
}

export function mockCallMembership(
    membershipData: MembershipData,
    roomId: string,
    rtcBackendIdentity?: string,
): CallMembership {
    const ev = mockRTCEvent(membershipData, roomId);
    vi.mocked(ev.getContent).mockReturnValue(membershipData);
    const data = CallMembership.membershipDataFromMatrixEvent(ev);
    return new CallMembership(ev, data, rtcBackendIdentity ?? "xx");
}

export function makeKey(id: number, key: string): { key: string; index: number } {
    return {
        key: key,
        index: id,
    };
}
