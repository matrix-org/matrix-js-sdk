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

import { EventType, GroupCallIntent, GroupCallType, MatrixEvent, Room, RoomMember } from '../../../src';
import { GroupCall } from "../../../src/webrtc/groupCall";
import { MatrixClient } from "../../../src/client";
import { installWebRTCMocks, MockMediaHandler, MockRTCPeerConnection } from '../../test-utils/webrtc';
import { ReEmitter } from '../../../src/ReEmitter';
import { TypedEventEmitter } from '../../../src/models/typed-event-emitter';
import { MediaHandler } from '../../../src/webrtc/mediaHandler';

const FAKE_ROOM_ID = "!fake:test.dummy";
const FAKE_CONF_ID = "fakegroupcallid";

const FAKE_USER_ID_1 = "@alice:test.dummy";
const FAKE_DEVICE_ID_1 = "@AAAAAA";
const FAKE_SESSION_ID_1 = "alice1";
const FAKE_USER_ID_2 = "@bob:test.dummy";
const FAKE_DEVICE_ID_2 = "@BBBBBB";
const FAKE_SESSION_ID_2 = "bob1";

class MockCallMatrixClient {
    public mediaHandler: MediaHandler = new MockMediaHandler() as unknown as MediaHandler;

    constructor(public userId: string, public deviceId: string, public sessionId: string) {
    }

    groupCallEventHandler = {
        groupCalls: new Map(),
    };

    callEventHandler = {
        calls: new Map(),
    };

    sendStateEvent = jest.fn();

    getMediaHandler() { return this.mediaHandler; }

    getUserId() { return this.userId; }

    getDeviceId() { return this.deviceId; }
    getSessionId() { return this.sessionId; }

    emit = jest.fn();
    on = jest.fn();
    removeListener = jest.fn();
    getTurnServers = () => [];
    isFallbackICEServerAllowed = () => false;
    reEmitter = new ReEmitter(new TypedEventEmitter());
    getUseE2eForGroupCall = () => false;
    checkTurnServers = () => null;
}

describe('Group Call', function() {
    beforeEach(function() {
        installWebRTCMocks();
    });

    describe('Basic functionality', function() {
        let mockSendState: jest.Mock;
        let mockClient: MatrixClient;
        let room: Room;
        let groupCall: GroupCall;

        beforeEach(function() {
            const typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );
            mockSendState = typedMockClient.sendStateEvent;

            mockClient = typedMockClient as unknown as MatrixClient;

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_1);
            groupCall = new GroupCall(mockClient, room, GroupCallType.Video, false, GroupCallIntent.Prompt);
        });

        it("sends state event to room when creating", async () => {
            await groupCall.create();

            expect(mockSendState).toHaveBeenCalledWith(
                FAKE_ROOM_ID, EventType.GroupCallPrefix, expect.objectContaining({
                    "m.type": GroupCallType.Video,
                    "m.intent": GroupCallIntent.Prompt,
                }),
                groupCall.groupCallId,
            );
        });

        it("sends member state event to room on enter", async () => {
            room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;

            await groupCall.create();

            try {
                await groupCall.enter();

                expect(mockSendState).toHaveBeenCalledWith(
                    FAKE_ROOM_ID,
                    EventType.GroupCallMemberPrefix,
                    expect.objectContaining({
                        "m.calls": [
                            expect.objectContaining({
                                "m.call_id": groupCall.groupCallId,
                                "m.devices": [
                                    expect.objectContaining({
                                        device_id: FAKE_DEVICE_ID_1,
                                    }),
                                ],
                            }),
                        ],
                    }),
                    FAKE_USER_ID_1,
                );
            } finally {
                groupCall.leave();
            }
        });

        it("starts with mic unmuted in regular calls", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                expect(groupCall.isMicrophoneMuted()).toEqual(false);
            } finally {
                groupCall.leave();
            }
        });

        it("starts with mic muted in PTT calls", async () => {
            try {
                // replace groupcall with a PTT one for this test
                // we will probably want a dedicated test suite for PTT calls, so when we do,
                // this can go in there instead.
                groupCall = new GroupCall(mockClient, room, GroupCallType.Video, true, GroupCallIntent.Prompt);

                await groupCall.create();

                await groupCall.initLocalCallFeed();

                expect(groupCall.isMicrophoneMuted()).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });

        it("disables audio stream when audio is set to muted", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                await groupCall.setMicrophoneMuted(true);

                expect(groupCall.isMicrophoneMuted()).toEqual(true);

                expect(mockSendState.mock.lastCall[0]).toEqual(FAKE_ROOM_ID);
            } finally {
                groupCall.leave();
            }
        });

        it("starts with video unmuted in regular calls", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                expect(groupCall.isLocalVideoMuted()).toEqual(false);
            } finally {
                groupCall.leave();
            }
        });

        it("disables video stream when video is set to muted", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                await groupCall.setLocalVideoMuted(true);

                expect(groupCall.isLocalVideoMuted()).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });
    });

    describe('Placing calls', function() {
        let groupCall1: GroupCall;
        let groupCall2: GroupCall;
        let client1: MatrixClient;
        let client2: MatrixClient;

        beforeEach(function() {
            MockRTCPeerConnection.resetInstances();

            client1 = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            ) as unknown as MatrixClient;

            client2 = new MockCallMatrixClient(
                FAKE_USER_ID_2, FAKE_DEVICE_ID_2, FAKE_SESSION_ID_2,
            ) as unknown as MatrixClient;

            client1.sendStateEvent = client2.sendStateEvent = (roomId, eventType, content, statekey) => {
                if (eventType === EventType.GroupCallMemberPrefix) {
                    const fakeEvent = {
                        getContent: () => content,
                        getRoomId: () => FAKE_ROOM_ID,
                        getStateKey: () => statekey,
                    } as unknown as MatrixEvent;

                    let subMap = client1Room.currentState.events.get(eventType);
                    if (!subMap) {
                        subMap = new Map<string, MatrixEvent>();
                        client1Room.currentState.events.set(eventType, subMap);
                        // since we cheat & use the same maps for each, we can
                        // just add it once.
                        client2Room.currentState.events.set(eventType, subMap);
                    }
                    subMap.set(statekey, fakeEvent);

                    groupCall1.onMemberStateChanged(fakeEvent);
                    groupCall2.onMemberStateChanged(fakeEvent);
                }
                return Promise.resolve(null);
            };

            const client1Room = new Room(FAKE_ROOM_ID, client1, FAKE_USER_ID_1);

            const client2Room = new Room(FAKE_ROOM_ID, client2, FAKE_USER_ID_2);

            groupCall1 = new GroupCall(
                client1, client1Room, GroupCallType.Video, false, GroupCallIntent.Prompt, FAKE_CONF_ID,
            );

            groupCall2 = new GroupCall(
                client2, client2Room, GroupCallType.Video, false, GroupCallIntent.Prompt, FAKE_CONF_ID,
            );

            client1Room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;
            client1Room.currentState.members[FAKE_USER_ID_2] = {
                userId: FAKE_USER_ID_2,
            } as unknown as RoomMember;

            client2Room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;
            client2Room.currentState.members[FAKE_USER_ID_2] = {
                userId: FAKE_USER_ID_2,
            } as unknown as RoomMember;
        });

        afterEach(function() {
            MockRTCPeerConnection.resetInstances();
        });

        it("Places a call to a peer", async function() {
            await groupCall1.create();

            try {
                // keep this as its own variable so we have it typed as a mock
                // rather than its type in the client object
                const mockSendToDevice = jest.fn<Promise<{}>, [
                    eventType: string,
                    contentMap: { [userId: string]: { [deviceId: string]: Record<string, any> } },
                    txnId?: string,
                ]>();

                const toDeviceProm = new Promise<void>(resolve => {
                    mockSendToDevice.mockImplementation(() => {
                        resolve();
                        return Promise.resolve({});
                    });
                });

                client1.sendToDevice = mockSendToDevice;

                await groupCall1.enter();

                await groupCall2.enter();

                MockRTCPeerConnection.triggerAllNegotiations();

                await toDeviceProm;

                expect(mockSendToDevice.mock.calls[0][0]).toBe("m.call.invite");

                const toDeviceCallContent = mockSendToDevice.mock.calls[0][1];
                expect(Object.keys(toDeviceCallContent).length).toBe(1);
                expect(Object.keys(toDeviceCallContent)[0]).toBe(FAKE_USER_ID_2);

                const toDeviceBobDevices = toDeviceCallContent[FAKE_USER_ID_2];
                expect(Object.keys(toDeviceBobDevices).length).toBe(1);
                expect(Object.keys(toDeviceBobDevices)[0]).toBe(FAKE_DEVICE_ID_2);

                const bobDeviceMessage = toDeviceBobDevices[FAKE_DEVICE_ID_2];
                expect(bobDeviceMessage.conf_id).toBe(FAKE_CONF_ID);
            } finally {
                await groupCall1.leave();

                await groupCall2.leave();
            }
        });
    });
});
