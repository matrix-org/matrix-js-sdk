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

import { EventType, type Room, RoomEvent, type MatrixClient, type MatrixEvent } from "../../../src";
import { CallMembership, type SessionMembershipData } from "../../../src/matrixrtc/CallMembership";
import { secureRandomString } from "../../../src/randomstring";

export type MembershipData = (SessionMembershipData | {}) & { user_id: string };

export const membershipTemplate: SessionMembershipData & { user_id: string } = {
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

export type MockClient = Pick<
    MatrixClient,
    | "getUserId"
    | "getDeviceId"
    | "sendEvent"
    | "sendStateEvent"
    | "_unstable_sendDelayedStateEvent"
    | "_unstable_updateDelayedEvent"
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
    };
}

export function makeMockRoom(
    membershipData: MembershipData[],
): Room & { emitTimelineEvent: (event: MatrixEvent) => void } {
    const roomId = secureRandomString(8);
    // Caching roomState here so it does not get recreated when calling `getLiveTimeline.getState()`
    const roomState = makeMockRoomState(membershipData, roomId);
    const room = Object.assign(new EventEmitter(), {
        roomId: roomId,
        hasMembershipState: jest.fn().mockReturnValue(true),
        getLiveTimeline: jest.fn().mockReturnValue({
            getState: jest.fn().mockReturnValue(roomState),
        }),
        getVersion: jest.fn().mockReturnValue("default"),
    }) as unknown as Room;
    return Object.assign(room, {
        emitTimelineEvent: (event: MatrixEvent) =>
            room.emit(RoomEvent.Timeline, event, room, undefined, false, {} as any),
    });
}

function makeMockRoomState(membershipData: MembershipData[], roomId: string) {
    const events = membershipData.map((m) => mockRTCEvent(m, roomId));
    const keysAndEvents = events.map((e) => {
        const data = e.getContent() as SessionMembershipData;
        return [`_${e.sender?.userId}_${data.device_id}`];
    });

    return {
        on: jest.fn(),
        off: jest.fn(),
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
    room.getLiveTimeline().getState = jest.fn().mockReturnValue(makeMockRoomState(membershipData, room.roomId));
}

export function makeMockEvent(
    type: string,
    sender: string,
    roomId: string | undefined,
    content: any,
    timestamp?: number,
): MatrixEvent {
    return {
        getType: jest.fn().mockReturnValue(type),
        getContent: jest.fn().mockReturnValue(content),
        getSender: jest.fn().mockReturnValue(sender),
        getTs: jest.fn().mockReturnValue(timestamp ?? Date.now()),
        getRoomId: jest.fn().mockReturnValue(roomId),
        getId: jest.fn().mockReturnValue(secureRandomString(8)),
        isDecryptionFailure: jest.fn().mockReturnValue(false),
    } as unknown as MatrixEvent;
}

export function mockRTCEvent({ user_id: sender, ...membershipData }: MembershipData, roomId: string): MatrixEvent {
    return makeMockEvent(EventType.GroupCallMemberPrefix, sender, roomId, membershipData);
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
