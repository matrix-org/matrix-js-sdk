/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { EventType, GroupCallIntent, GroupCallType, Room, RoomMember } from '../../../src';
import { GroupCall } from "../../../src/webrtc/groupCall";
import { MatrixClient } from "../../../src/client";
import { MockAudioContext, MockMediaHandler } from '../../test-utils/webrtc';

const FAKE_SELF_USER_ID = "@me:test.dummy";
const FAKE_SELF_DEVICE_ID = "AAAAAA";
const FAKE_SELF_SESSION_ID = "1";
const FAKE_ROOM_ID = "!fake:test.dummy";

describe('Group Call', function() {
    beforeEach(function() {
        // @ts-ignore Mock
        global.AudioContext = MockAudioContext;
    });

    it("sends state event to room when creating", async () => {
        const mockSendState = jest.fn();

        const mockClient = {
            sendStateEvent: mockSendState,
            groupCallEventHandler: {
                groupCalls: new Map(),
            },
        } as unknown as MatrixClient;

        const room = new Room(FAKE_ROOM_ID, mockClient, FAKE_SELF_USER_ID);
        const groupCall = new GroupCall(mockClient, room, GroupCallType.Video, false, GroupCallIntent.Prompt);

        await groupCall.create();

        expect(mockSendState.mock.calls[0][0]).toEqual(FAKE_ROOM_ID);
        expect(mockSendState.mock.calls[0][1]).toEqual(EventType.GroupCallPrefix);
        expect(mockSendState.mock.calls[0][2]["m.type"]).toEqual(GroupCallType.Video);
        expect(mockSendState.mock.calls[0][2]["m.intent"]).toEqual(GroupCallIntent.Prompt);
    });

    it("sends member state event to room on enter", async () => {
        const mockSendState = jest.fn();
        const mockMediaHandler = new MockMediaHandler();

        const mockClient = {
            sendStateEvent: mockSendState,
            groupCallEventHandler: {
                groupCalls: new Map(),
            },
            callEventHandler: {
                calls: new Map(),
            },
            mediaHandler: mockMediaHandler,
            getMediaHandler: () => mockMediaHandler,
            getUserId: () => FAKE_SELF_USER_ID,
            getDeviceId: () => FAKE_SELF_DEVICE_ID,
            getSessionId: () => FAKE_SELF_SESSION_ID,
            emit: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
        } as unknown as MatrixClient;

        const room = new Room(FAKE_ROOM_ID, mockClient, FAKE_SELF_USER_ID);
        const groupCall = new GroupCall(mockClient, room, GroupCallType.Video, false, GroupCallIntent.Prompt);

        room.currentState.members[FAKE_SELF_USER_ID] = {
            userId: FAKE_SELF_USER_ID,
        } as unknown as RoomMember;

        await groupCall.create();

        try {
            await groupCall.enter();

            expect(mockSendState.mock.lastCall[0]).toEqual(FAKE_ROOM_ID);
            expect(mockSendState.mock.lastCall[1]).toEqual(EventType.GroupCallMemberPrefix);
            expect(mockSendState.mock.lastCall[2]['m.calls'].length).toEqual(1);
            expect(mockSendState.mock.lastCall[2]['m.calls'][0]["m.call_id"]).toEqual(groupCall.groupCallId);
            expect(mockSendState.mock.lastCall[2]['m.calls'][0]['m.devices'].length).toEqual(1);
            expect(mockSendState.mock.lastCall[2]['m.calls'][0]['m.devices'][0].device_id).toEqual(FAKE_SELF_DEVICE_ID);
        } finally {
            groupCall.leave();
        }
    });
});
