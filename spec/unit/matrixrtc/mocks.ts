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
import { CallMembershipData } from "../../../src/matrixrtc/CallMembership";
import { randomString } from "../../../src/randomstring";

export function makeMockRoom(memberships: CallMembershipData[], localAge: number | null = null): Room {
    const roomId = randomString(8);
    // Caching roomState here so it does not get recreated when calling `getLiveTimeline.getState()`
    const roomState = makeMockRoomState(memberships, roomId, localAge);
    return {
        roomId: roomId,
        hasMembershipState: jest.fn().mockReturnValue(true),
        getLiveTimeline: jest.fn().mockReturnValue({
            getState: jest.fn().mockReturnValue(roomState),
        }),
    } as unknown as Room;
}

export function makeMockRoomState(memberships: CallMembershipData[], roomId: string, localAge: number | null = null) {
    const event = mockRTCEvent(memberships, roomId, localAge);
    return {
        on: jest.fn(),
        off: jest.fn(),
        getStateEvents: (_: string, stateKey: string) => {
            if (stateKey !== undefined) return event;
            return [event];
        },
    };
}

export function mockRTCEvent(memberships: CallMembershipData[], roomId: string, localAge: number | null): MatrixEvent {
    return {
        getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
        getContent: jest.fn().mockReturnValue({
            memberships: memberships,
        }),
        getSender: jest.fn().mockReturnValue("@mock:user.example"),
        getTs: jest.fn().mockReturnValue(1000),
        localTimestamp: Date.now() - (localAge ?? 10),
        getRoomId: jest.fn().mockReturnValue(roomId),
        sender: {
            userId: "@mock:user.example",
        },
    } as unknown as MatrixEvent;
}
