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

import { EventType, MatrixEvent, Room } from "../../../src";
import { CallMembershipData, SessionMembershipData } from "../../../src/matrixrtc/CallMembership";
import { randomString } from "../../../src/randomstring";

type MembershipData = CallMembershipData[] | SessionMembershipData;

export function makeMockRoom(membershipData: MembershipData): Room {
    const roomId = randomString(8);
    // Caching roomState here so it does not get recreated when calling `getLiveTimeline.getState()`
    const roomState = makeMockRoomState(membershipData, roomId);
    return {
        roomId: roomId,
        hasMembershipState: jest.fn().mockReturnValue(true),
        getLiveTimeline: jest.fn().mockReturnValue({
            getState: jest.fn().mockReturnValue(roomState),
        }),
        getVersion: jest.fn().mockReturnValue("default"),
    } as unknown as Room;
}

export function makeMockRoomState(membershipData: MembershipData, roomId: string) {
    const event = mockRTCEvent(membershipData, roomId);
    return {
        on: jest.fn(),
        off: jest.fn(),
        getStateEvents: (_: string, stateKey: string) => {
            if (stateKey !== undefined) return event;
            return [event];
        },
        events: new Map([
            [
                event.getType(),
                {
                    size: () => true,
                    has: (_stateKey: string) => true,
                    get: (_stateKey: string) => event,
                    values: () => [event],
                },
            ],
        ]),
    };
}

export function mockRTCEvent(membershipData: MembershipData, roomId: string): MatrixEvent {
    return {
        getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
        getContent: jest.fn().mockReturnValue(
            !Array.isArray(membershipData)
                ? membershipData
                : {
                      memberships: membershipData,
                  },
        ),
        getSender: jest.fn().mockReturnValue("@mock:user.example"),
        getTs: jest.fn().mockReturnValue(Date.now()),
        getRoomId: jest.fn().mockReturnValue(roomId),
        sender: {
            userId: "@mock:user.example",
        },
    } as unknown as MatrixEvent;
}
