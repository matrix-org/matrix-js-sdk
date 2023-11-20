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
    // If makeMockRoom is used instead of one of the other functions in this file,
    // we store the localTimestamp so that subsequent calls calculate the expiration based on the localTimestamp
    // using Date.now(). So, jest.advanceTimersByTime() can be used to simulate the passage of time.

    // The actual time of the underlying mocked events will be: localTimestamp ?? localAge ?? 0
    const localTimestamp = Date.now() - (localAge ?? 10);
    return {
        roomId: roomId,
        getLiveTimeline: jest.fn().mockReturnValue({
            // When setting up `makeMockRoomState` we always want to use the localTimestamp instead of localAge.
            getState: jest.fn().mockReturnValue(makeMockRoomState(memberships, roomId, null, localTimestamp)),
        }),
    } as unknown as Room;
}

export function makeMockRoomState(
    memberships: CallMembershipData[],
    roomId: string,
    /**`localAge` is ignored if localTimestamp is present.*/
    localAge: number | null = null,
    localTimestamp: number | null = null,
) {
    return {
        getStateEvents: (_: string, stateKey: string) => {
            // If localTimestamp is present mockRTCEvent does not recompute
            // the localTimestamp based on Date.now() when `getStateEvents` is called.
            const event = mockRTCEvent(memberships, roomId, localAge, localTimestamp);

            if (stateKey !== undefined) return event;
            return [event];
        },
    };
}

export function mockRTCEvent(
    memberships: CallMembershipData[],
    roomId: string,
    /**`localAge` is ignored if localTimestamp is present.*/
    localAge: number | null,
    localTimestamp: number | null = null,
): MatrixEvent {
    const _localTimestamp = localTimestamp ?? Date.now() - (localAge ?? 10);

    return {
        getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
        getContent: jest.fn().mockReturnValue({
            memberships: memberships,
        }),
        getSender: jest.fn().mockReturnValue("@mock:user.example"),
        getTs: jest.fn().mockReturnValue(1000),
        localTimestamp: _localTimestamp,
        getRoomId: jest.fn().mockReturnValue(roomId),
        sender: {
            userId: "@mock:user.example",
        },
    } as unknown as MatrixEvent;
}
