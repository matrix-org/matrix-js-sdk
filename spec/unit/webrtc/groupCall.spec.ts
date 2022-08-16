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
import {
    MockAudioContext,
    MockMediaHandler,
    MockMediaStream,
    MockMediaStreamTrack,
    MockRTCPeerConnection,
} from '../../test-utils/webrtc';
import { SDPStreamMetadataKey, SDPStreamMetadataPurpose } from "../../../src/webrtc/callEventTypes";
import { sleep } from "../../../src/utils";
import { ReEmitter } from "../../../src/ReEmitter";

const FAKE_SELF_USER_ID = "@me:test.dummy";
const FAKE_SELF_DEVICE_ID = "AAAAAA";
const FAKE_SELF_SESSION_ID = "1";
const FAKE_ROOM_ID = "!fake:test.dummy";
const GROUP_CALL_ID = "group_call_id";
const FAKE_STATE_EVENTS = [
    {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
        }),
        getStateKey: () => FAKE_SELF_USER_ID,
        getRoomId: () => FAKE_ROOM_ID,
    },
    {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
            ["m.calls"]: [{
                ["m.call_id"]: GROUP_CALL_ID,
                ["m.devices"]: [{
                    device_id: "user2_device",
                    feeds: [],
                }],
            }],
        }),
        getStateKey: () => "user2",
        getRoomId: () => FAKE_ROOM_ID,
    }, {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
            ["m.calls"]: [{
                ["m.call_id"]: GROUP_CALL_ID,
                ["m.devices"]: [{
                    device_id: "user3_device",
                    feeds: [],
                }],
            }],
        }),
        getStateKey: () => "user3",
        getRoomId: () => FAKE_ROOM_ID,
    },
];

const ONE_HOUR = 1000 * 60 * 60;

const createAndEnterGroupCall = async (cli: MatrixClient, room: Room): Promise<GroupCall> => {
    const groupCall = new GroupCall(
        cli,
        room,
        GroupCallType.Video,
        false,
        GroupCallIntent.Prompt,
        GROUP_CALL_ID,
    );

    await groupCall.create();
    await groupCall.enter();

    return groupCall;
};

describe('Group Call', function() {
    let mockClient: MatrixClient;
    let room: Room;

    beforeEach(function() {
        // @ts-ignore Mock
        global.AudioContext = MockAudioContext;

        global.window = {
            // @ts-ignore Mock
            RTCPeerConnection: MockRTCPeerConnection,
            // @ts-ignore Mock
            RTCSessionDescription: {},
            // @ts-ignore Mock
            RTCIceCandidate: {},
        };

        // @ts-ignore Mock
        global.document = {};

        const mockMediaHandler = new MockMediaHandler();

        mockClient = {
            sendStateEvent: jest.fn(),
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
            getTurnServers: () => [],
            isFallbackICEServerAllowed: () => true,
            getUseE2eForGroupCall: () => false,
            checkTurnServers: () => true,
            sendToDevice: jest.fn(),
            reEmitter: new ReEmitter(mockClient),
            emit: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
        } as unknown as MatrixClient;

        room = new Room(FAKE_ROOM_ID, mockClient, FAKE_SELF_USER_ID);
        room.currentState.getStateEvents = jest.fn().mockImplementation((type: EventType, userId: string) => {
            return type === EventType.GroupCallMemberPrefix
                ? FAKE_STATE_EVENTS.find(e => e.getStateKey() === userId) || FAKE_STATE_EVENTS
                : { getContent: () => ([]) };
        });
        room.getMember = jest.fn().mockImplementation((userId) => ({ userId }));
    });

    it("sends state event to room when creating", async () => {
        const mockSendState = mockClient.sendStateEvent as jest.Mock;

        const groupCall = new GroupCall(mockClient, room, GroupCallType.Video, false, GroupCallIntent.Prompt);

        await groupCall.create();

        expect(mockSendState.mock.calls[0][0]).toEqual(FAKE_ROOM_ID);
        expect(mockSendState.mock.calls[0][1]).toEqual(EventType.GroupCallPrefix);
        expect(mockSendState.mock.calls[0][2]["m.type"]).toEqual(GroupCallType.Video);
        expect(mockSendState.mock.calls[0][2]["m.intent"]).toEqual(GroupCallIntent.Prompt);
    });

    it("sends member state event to room on enter", async () => {
        const groupCall = new GroupCall(mockClient, room, GroupCallType.Video, false, GroupCallIntent.Prompt);

        room.currentState.members[FAKE_SELF_USER_ID] = {
            userId: FAKE_SELF_USER_ID,
        } as unknown as RoomMember;

        await groupCall.create();

        try {
            await groupCall.enter();

            const mockSendState = mockClient.sendStateEvent as jest.Mock;

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

    describe("muting", () => {
        describe("local muting", () => {
            it("should mute local audio when calling setMicrophoneMuted()", async () => {
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                groupCall.localCallFeed.setAudioVideoMuted = jest.fn();
                const setAVMutedArray = groupCall.calls.map(call => {
                    call.localUsermediaFeed.setAudioVideoMuted = jest.fn();
                    return call.localUsermediaFeed.setAudioVideoMuted;
                });
                const tracksArray = groupCall.calls.reduce((acc, call) => {
                    acc.push(...call.localUsermediaStream.getAudioTracks());
                    return acc;
                }, []);
                const sendMetadataUpdateArray = groupCall.calls.map(call => {
                    call.sendMetadataUpdate = jest.fn();
                    return call.sendMetadataUpdate;
                });

                await groupCall.setMicrophoneMuted(true);

                groupCall.localCallFeed.stream.getAudioTracks().forEach(track => expect(track.enabled).toBe(false));
                expect(groupCall.localCallFeed.setAudioVideoMuted).toHaveBeenCalledWith(true, null);
                setAVMutedArray.forEach(f => expect(f).toHaveBeenCalledWith(true, null));
                tracksArray.forEach(track => expect(track.enabled).toBe(false));
                sendMetadataUpdateArray.forEach(f => expect(f).toHaveBeenCalled());

                groupCall.terminate();
            });

            it("should mute local video when calling setLocalVideoMuted()", async () => {
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                groupCall.localCallFeed.setAudioVideoMuted = jest.fn();
                const setAVMutedArray = groupCall.calls.map(call => {
                    call.localUsermediaFeed.setAudioVideoMuted = jest.fn();
                    return call.localUsermediaFeed.setAudioVideoMuted;
                });
                const tracksArray = groupCall.calls.reduce((acc, call) => {
                    acc.push(...call.localUsermediaStream.getVideoTracks());
                    return acc;
                }, []);
                const sendMetadataUpdateArray = groupCall.calls.map(call => {
                    call.sendMetadataUpdate = jest.fn();
                    return call.sendMetadataUpdate;
                });

                await groupCall.setLocalVideoMuted(true);

                groupCall.localCallFeed.stream.getVideoTracks().forEach(track => expect(track.enabled).toBe(false));
                expect(groupCall.localCallFeed.setAudioVideoMuted).toHaveBeenCalledWith(null, true);
                setAVMutedArray.forEach(f => expect(f).toHaveBeenCalledWith(null, true));
                tracksArray.forEach(track => expect(track.enabled).toBe(false));
                sendMetadataUpdateArray.forEach(f => expect(f).toHaveBeenCalled());

                groupCall.terminate();
            });
        });

        describe("remote muting", () => {
            const getMetadataEvent = (audio: boolean, video: boolean): MatrixEvent => ({
                getContent: () => ({
                    [SDPStreamMetadataKey]: {
                        stream: {
                            purpose: SDPStreamMetadataPurpose.Usermedia,
                            audio_muted: audio,
                            video_muted: video,
                        },
                    },
                }),
            } as MatrixEvent);

            it("should mute remote feed's audio after receiving metadata with video audio", async () => {
                const metadataEvent = getMetadataEvent(true, false);
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                // It takes a bit of time for the calls to get created
                await sleep(10);

                const call = groupCall.calls[0];
                call.getOpponentMember = () => ({ userId: call.invitee }) as RoomMember;
                // @ts-ignore Mock
                call.pushRemoteFeed(new MockMediaStream("stream", [
                    new MockMediaStreamTrack("audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ]));
                call.onSDPStreamMetadataChangedReceived(metadataEvent);

                const feed = groupCall.getUserMediaFeedByUserId(call.invitee);
                expect(feed.isAudioMuted()).toBe(true);
                expect(feed.isVideoMuted()).toBe(false);

                groupCall.terminate();
            });

            it("should mute remote feed's video after receiving metadata with video muted", async () => {
                const metadataEvent = getMetadataEvent(false, true);
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                // It takes a bit of time for the calls to get created
                await sleep(10);

                const call = groupCall.calls[0];
                call.getOpponentMember = () => ({ userId: call.invitee }) as RoomMember;
                // @ts-ignore Mock
                call.pushRemoteFeed(new MockMediaStream("stream", [
                    new MockMediaStreamTrack("audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ]));
                call.onSDPStreamMetadataChangedReceived(metadataEvent);

                const feed = groupCall.getUserMediaFeedByUserId(call.invitee);
                expect(feed.isAudioMuted()).toBe(false);
                expect(feed.isVideoMuted()).toBe(true);

                groupCall.terminate();
            });
        });
    });
});
