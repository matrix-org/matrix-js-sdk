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

import { EventType, Room } from "../../../src";
import { CallMembershipData } from "../../../src/matrixrtc/CallMembership";
import { randomString } from "../../../src/randomstring";

export function makeMockRoom(memberships: CallMembershipData[], localAge: number | undefined = undefined): Room {
    return {
        roomId: randomString(8),
        getLiveTimeline: jest.fn().mockReturnValue({
            getState: jest.fn().mockReturnValue(makeMockRoomState(memberships, localAge)),
        }),
    } as unknown as Room;
}

function makeMockRoomState(memberships: CallMembershipData[], localAge = 10) {
    return {
        getStateEvents: (_: string, stateKey: string) => {
            const event = {
                getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                getContent: jest.fn().mockReturnValue({
                    memberships: memberships,
                }),
                getSender: jest.fn().mockReturnValue("@mock:user.example"),
                getTs: jest.fn().mockReturnValue(1000),
                getLocalAge: jest.fn().mockReturnValue(localAge),
            };

            if (stateKey !== undefined) return event;
            return [event];
        },
    };
}
