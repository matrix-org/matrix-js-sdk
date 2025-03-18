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

import { EventType, type MatrixClient, type MatrixEvent, type Room } from "../../../src";
import { CallMembership, type SessionMembershipData } from "../../../src/matrixrtc/CallMembership";
import { secureRandomString } from "../../../src/randomstring";

type MembershipData = SessionMembershipData[] | SessionMembershipData | {};

export const membershipTemplate: SessionMembershipData = {
    application: "m.call",
    call_id: "",
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

export function makeMockRoom(membershipData: MembershipData): Room {
    const roomId = secureRandomString(8);
    // Caching roomState here so it does not get recreated when calling `getLiveTimeline.getState()`
    const roomState = makeMockRoomState(membershipData, roomId);
    const room = {
        roomId: roomId,
        hasMembershipState: jest.fn().mockReturnValue(true),
        getLiveTimeline: jest.fn().mockReturnValue({
            getState: jest.fn().mockReturnValue(roomState),
        }),
        getVersion: jest.fn().mockReturnValue("default"),
    } as unknown as Room;
    return room;
}

export function makeMockRoomState(membershipData: MembershipData, roomId: string) {
    const events = Array.isArray(membershipData)
        ? membershipData.map((m) => mockRTCEvent(m, roomId))
        : [mockRTCEvent(membershipData, roomId)];
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

export function mockRTCEvent(membershipData: MembershipData, roomId: string, customSender?: string): MatrixEvent {
    const sender = customSender ?? "@mock:user.example";
    return {
        getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
        getContent: jest.fn().mockReturnValue(membershipData),
        getSender: jest.fn().mockReturnValue(sender),
        getTs: jest.fn().mockReturnValue(Date.now()),
        getRoomId: jest.fn().mockReturnValue(roomId),
        isDecryptionFailure: jest.fn().mockReturnValue(false),
    } as unknown as MatrixEvent;
}
export function mockCallMembership(membershipData: MembershipData, roomId: string, sender?: string): CallMembership {
    return new CallMembership(mockRTCEvent(membershipData, roomId, sender), membershipData);
}
