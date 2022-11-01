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

import {
    EventType,
    GroupCallIntent,
    GroupCallType,
    MatrixCall,
    MatrixEvent,
    Room,
    RoomMember,
} from '../../../src';
import { GroupCall, GroupCallEvent, GroupCallState } from "../../../src/webrtc/groupCall";
import { MatrixClient } from "../../../src/client";
import {
    installWebRTCMocks,
    MockCallFeed,
    MockCallMatrixClient,
    MockMediaStream,
    MockMediaStreamTrack,
    MockRTCPeerConnection,
} from '../../test-utils/webrtc';
import { SDPStreamMetadataKey, SDPStreamMetadataPurpose } from "../../../src/webrtc/callEventTypes";
import { sleep } from "../../../src/utils";
import { CallEventHandlerEvent } from '../../../src/webrtc/callEventHandler';
import { CallFeed } from '../../../src/webrtc/callFeed';
import { CallEvent, CallState } from '../../../src/webrtc/call';
import { flushPromises } from '../../test-utils/flushPromises';

const FAKE_ROOM_ID = "!fake:test.dummy";
const FAKE_CONF_ID = "fakegroupcallid";

const FAKE_USER_ID_1 = "@alice:test.dummy";
const FAKE_DEVICE_ID_1 = "@AAAAAA";
const FAKE_SESSION_ID_1 = "alice1";
const FAKE_USER_ID_2 = "@bob:test.dummy";
const FAKE_DEVICE_ID_2 = "@BBBBBB";
const FAKE_SESSION_ID_2 = "bob1";
const FAKE_USER_ID_3 = "@charlie:test.dummy";
const FAKE_STATE_EVENTS = [
    {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
        }),
        getStateKey: () => FAKE_USER_ID_1,
        getRoomId: () => FAKE_ROOM_ID,
    },
    {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
            ["m.calls"]: [{
                ["m.call_id"]: FAKE_CONF_ID,
                ["m.devices"]: [{
                    device_id: FAKE_DEVICE_ID_2,
                    feeds: [],
                }],
            }],
        }),
        getStateKey: () => FAKE_USER_ID_2,
        getRoomId: () => FAKE_ROOM_ID,
    }, {
        getContent: () => ({
            ["m.expires_ts"]: Date.now() + ONE_HOUR,
            ["m.calls"]: [{
                ["m.call_id"]: FAKE_CONF_ID,
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
        FAKE_CONF_ID,
    );

    await groupCall.create();
    await groupCall.enter();

    return groupCall;
};

class MockCall {
    constructor(public roomId: string, public groupCallId: string) {
    }

    public state = CallState.Ringing;
    public opponentUserId = FAKE_USER_ID_1;
    public callId = "1";
    public localUsermediaFeed = {
        setAudioVideoMuted: jest.fn<void, [boolean, boolean]>(),
        stream: new MockMediaStream("stream"),
    };
    public remoteUsermediaFeed?: CallFeed;
    public remoteScreensharingFeed?: CallFeed;

    public reject = jest.fn<void, []>();
    public answerWithCallFeeds = jest.fn<void, [CallFeed[]]>();
    public hangup = jest.fn<void, []>();

    public sendMetadataUpdate = jest.fn<void, []>();

    public on = jest.fn();
    public removeListener = jest.fn();

    public getOpponentMember(): Partial<RoomMember> {
        return {
            userId: this.opponentUserId,
        };
    }

    public typed(): MatrixCall { return this as unknown as MatrixCall; }
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

        it("does not initialize local call feed, if it already is", async () => {
            room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;

            await groupCall.initLocalCallFeed();
            jest.spyOn(groupCall, "initLocalCallFeed");
            await groupCall.enter();

            expect(groupCall.initLocalCallFeed).not.toHaveBeenCalled();

            groupCall.leave();
        });

        it("stops initializing local call feed when leaving", async () => {
            const initPromise = groupCall.initLocalCallFeed();
            groupCall.leave();
            await expect(initPromise).rejects.toBeDefined();
            expect(groupCall.state).toBe(GroupCallState.LocalCallFeedUninitialized);
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
                    { keepAlive: false },
                );
            } finally {
                groupCall.leave();
            }
        });

        it("sends member state event to room on leave", async () => {
            room.currentState.members[FAKE_USER_ID_1] = {
                userId: FAKE_USER_ID_1,
            } as unknown as RoomMember;

            await groupCall.create();
            await groupCall.enter();
            mockSendState.mockClear();

            groupCall.leave();
            expect(mockSendState).toHaveBeenCalledWith(
                FAKE_ROOM_ID,
                EventType.GroupCallMemberPrefix,
                expect.objectContaining({ "m.calls": [] }),
                FAKE_USER_ID_1,
                { keepAlive: true }, // Request should outlive the window
            );
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

        it("disables audio stream when audio is set to muted", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                await groupCall.setMicrophoneMuted(true);

                expect(groupCall.isMicrophoneMuted()).toEqual(true);
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

        it("retains state of local user media stream when updated", async () => {
            try {
                await groupCall.create();

                await groupCall.initLocalCallFeed();

                const oldStream = groupCall.localCallFeed?.stream as unknown as MockMediaStream;

                // arbitrary values, important part is that they're the same afterwards
                await groupCall.setLocalVideoMuted(true);
                await groupCall.setMicrophoneMuted(false);

                const newStream = await mockClient.getMediaHandler().getUserMediaStream(true, true);

                groupCall.updateLocalUsermediaStream(newStream);

                expect(groupCall.localCallFeed?.stream).toBe(newStream);

                expect(groupCall.isLocalVideoMuted()).toEqual(true);
                expect(groupCall.isMicrophoneMuted()).toEqual(false);

                expect(oldStream.isStopped).toEqual(true);
            } finally {
                groupCall.leave();
            }
        });

        describe("call feeds changing", () => {
            let call: MockCall;
            const currentFeed = new MockCallFeed(FAKE_USER_ID_1, new MockMediaStream("current"));
            const newFeed = new MockCallFeed(FAKE_USER_ID_1, new MockMediaStream("new"));

            beforeEach(async () => {
                jest.spyOn(currentFeed, "dispose");
                jest.spyOn(newFeed, "measureVolumeActivity");

                jest.spyOn(groupCall, "emit");

                call = new MockCall(room.roomId, groupCall.groupCallId);

                await groupCall.create();
            });

            it("ignores changes, if we can't get user id of opponent", async () => {
                const call = new MockCall(room.roomId, groupCall.groupCallId);
                jest.spyOn(call, "getOpponentMember").mockReturnValue({ userId: undefined });

                // @ts-ignore Mock
                expect(() => groupCall.onCallFeedsChanged(call)).toThrowError();
            });

            describe("usermedia feeds", () => {
                it("adds new usermedia feed", async () => {
                    call.remoteUsermediaFeed = newFeed.typed();
                    // @ts-ignore Mock
                    groupCall.onCallFeedsChanged(call);

                    expect(groupCall.userMediaFeeds).toStrictEqual([newFeed]);
                });

                it("replaces usermedia feed", async () => {
                    groupCall.userMediaFeeds = [currentFeed.typed()];

                    call.remoteUsermediaFeed = newFeed.typed();
                    // @ts-ignore Mock
                    groupCall.onCallFeedsChanged(call);

                    expect(groupCall.userMediaFeeds).toStrictEqual([newFeed]);
                });

                it("removes usermedia feed", async () => {
                    groupCall.userMediaFeeds = [currentFeed.typed()];

                    // @ts-ignore Mock
                    groupCall.onCallFeedsChanged(call);

                    expect(groupCall.userMediaFeeds).toHaveLength(0);
                });
            });

            describe("screenshare feeds", () => {
                it("adds new screenshare feed", async () => {
                    call.remoteScreensharingFeed = newFeed.typed();
                    // @ts-ignore Mock
                    groupCall.onCallFeedsChanged(call);

                    expect(groupCall.screenshareFeeds).toStrictEqual([newFeed]);
                });

                it("replaces screenshare feed", async () => {
                    groupCall.screenshareFeeds = [currentFeed.typed()];

                    call.remoteScreensharingFeed = newFeed.typed();
                    // @ts-ignore Mock
                    groupCall.onCallFeedsChanged(call);

                    expect(groupCall.screenshareFeeds).toStrictEqual([newFeed]);
                });

                it("removes screenshare feed", async () => {
                    groupCall.screenshareFeeds = [currentFeed.typed()];

                    // @ts-ignore Mock
                    groupCall.onCallFeedsChanged(call);

                    expect(groupCall.screenshareFeeds).toHaveLength(0);
                });
            });

            describe("feed replacing", () => {
                it("replaces usermedia feed", async () => {
                    groupCall.userMediaFeeds = [currentFeed.typed()];

                    // @ts-ignore Mock
                    groupCall.replaceUserMediaFeed(currentFeed, newFeed);

                    const newFeeds = [newFeed];

                    expect(groupCall.userMediaFeeds).toStrictEqual(newFeeds);
                    expect(currentFeed.dispose).toHaveBeenCalled();
                    expect(newFeed.measureVolumeActivity).toHaveBeenCalledWith(true);
                    expect(groupCall.emit).toHaveBeenCalledWith(GroupCallEvent.UserMediaFeedsChanged, newFeeds);
                });

                it("replaces screenshare feed", async () => {
                    groupCall.screenshareFeeds = [currentFeed.typed()];

                    // @ts-ignore Mock
                    groupCall.replaceScreenshareFeed(currentFeed, newFeed);

                    const newFeeds = [newFeed];

                    expect(groupCall.screenshareFeeds).toStrictEqual(newFeeds);
                    expect(currentFeed.dispose).toHaveBeenCalled();
                    expect(newFeed.measureVolumeActivity).toHaveBeenCalledWith(true);
                    expect(groupCall.emit).toHaveBeenCalledWith(GroupCallEvent.ScreenshareFeedsChanged, newFeeds);
                });
            });
        });

        describe("PTT calls", () => {
            beforeEach(async () => {
                // replace groupcall with a PTT one
                groupCall = new GroupCall(mockClient, room, GroupCallType.Video, true, GroupCallIntent.Prompt);

                await groupCall.create();

                await groupCall.initLocalCallFeed();
            });

            afterEach(() => {
                jest.useRealTimers();

                groupCall.leave();
            });

            it("starts with mic muted in PTT calls", async () => {
                expect(groupCall.isMicrophoneMuted()).toEqual(true);
            });

            it("re-mutes microphone after transmit timeout in PTT mode", async () => {
                jest.useFakeTimers();

                await groupCall.setMicrophoneMuted(false);
                expect(groupCall.isMicrophoneMuted()).toEqual(false);

                jest.advanceTimersByTime(groupCall.pttMaxTransmitTime + 100);

                expect(groupCall.isMicrophoneMuted()).toEqual(true);
            });

            it("timer is cleared when mic muted again in PTT mode", async () => {
                jest.useFakeTimers();

                await groupCall.setMicrophoneMuted(false);
                expect(groupCall.isMicrophoneMuted()).toEqual(false);

                // 'talk' for half the allowed time
                jest.advanceTimersByTime(groupCall.pttMaxTransmitTime / 2);

                await groupCall.setMicrophoneMuted(true);
                await groupCall.setMicrophoneMuted(false);

                // we should still be unmuted after almost the full timeout duration
                // if not, the timer for the original talking session must have fired
                jest.advanceTimersByTime(groupCall.pttMaxTransmitTime - 100);

                expect(groupCall.isMicrophoneMuted()).toEqual(false);
            });

            it("sends metadata updates before unmuting in PTT mode", async () => {
                const mockCall = new MockCall(FAKE_ROOM_ID, groupCall.groupCallId);
                groupCall.calls.push(mockCall as unknown as MatrixCall);

                let metadataUpdateResolve: () => void;
                const metadataUpdatePromise = new Promise<void>(resolve => {
                    metadataUpdateResolve = resolve;
                });
                mockCall.sendMetadataUpdate = jest.fn().mockReturnValue(metadataUpdatePromise);

                const mutePromise = groupCall.setMicrophoneMuted(false);
                // we should still be muted at this point because the metadata update hasn't sent
                expect(groupCall.isMicrophoneMuted()).toEqual(true);
                expect(mockCall.localUsermediaFeed.setAudioVideoMuted).not.toHaveBeenCalled();
                metadataUpdateResolve!();

                await mutePromise;

                expect(mockCall.localUsermediaFeed.setAudioVideoMuted).toHaveBeenCalled();
                expect(groupCall.isMicrophoneMuted()).toEqual(false);
            });

            it("sends metadata updates after muting in PTT mode", async () => {
                const mockCall = new MockCall(FAKE_ROOM_ID, groupCall.groupCallId);
                groupCall.calls.push(mockCall as unknown as MatrixCall);

                // the call starts muted, so unmute to get in the right state to test
                await groupCall.setMicrophoneMuted(false);
                mockCall.localUsermediaFeed.setAudioVideoMuted.mockReset();

                let metadataUpdateResolve: () => void;
                const metadataUpdatePromise = new Promise<void>(resolve => {
                    metadataUpdateResolve = resolve;
                });
                mockCall.sendMetadataUpdate = jest.fn().mockReturnValue(metadataUpdatePromise);

                const mutePromise = groupCall.setMicrophoneMuted(true);
                // we should be muted at this point, before the metadata update has been sent
                expect(groupCall.isMicrophoneMuted()).toEqual(true);
                expect(mockCall.localUsermediaFeed.setAudioVideoMuted).toHaveBeenCalled();
                metadataUpdateResolve!();

                await mutePromise;

                expect(groupCall.isMicrophoneMuted()).toEqual(true);
            });
        });
    });

    describe('Placing calls', function() {
        let groupCall1: GroupCall;
        let groupCall2: GroupCall;
        let client1: MockCallMatrixClient;
        let client2: MockCallMatrixClient;

        beforeEach(function() {
            MockRTCPeerConnection.resetInstances();

            client1 = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );

            client2 = new MockCallMatrixClient(
                FAKE_USER_ID_2, FAKE_DEVICE_ID_2, FAKE_SESSION_ID_2,
            );

            // Inject the state events directly into each client when sent
            const fakeSendStateEvents = (
                roomId: string, eventType: EventType, content: any, statekey: string,
            ) => {
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
                        client2Room.currentState.events.set(eventType, subMap);
                    }
                    // since we cheat & use the same maps for each, we can
                    // just add it once.
                    subMap.set(statekey, fakeEvent);

                    groupCall1.onMemberStateChanged(fakeEvent);
                    groupCall2.onMemberStateChanged(fakeEvent);
                }
                return Promise.resolve({ "event_id": "foo" });
            };

            client1.sendStateEvent.mockImplementation(fakeSendStateEvents);
            client2.sendStateEvent.mockImplementation(fakeSendStateEvents);

            const client1Room = new Room(FAKE_ROOM_ID, client1.typed(), FAKE_USER_ID_1);

            const client2Room = new Room(FAKE_ROOM_ID, client2.typed(), FAKE_USER_ID_2);

            groupCall1 = new GroupCall(
                client1.typed(), client1Room, GroupCallType.Video, false, GroupCallIntent.Prompt, FAKE_CONF_ID,
            );

            groupCall2 = new GroupCall(
                client2.typed(), client2Room, GroupCallType.Video, false, GroupCallIntent.Prompt, FAKE_CONF_ID,
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
            groupCall1.leave();
            groupCall2.leave();
            jest.useRealTimers();

            MockRTCPeerConnection.resetInstances();
        });

        it("Places a call to a peer", async function() {
            await groupCall1.create();

            try {
                const toDeviceProm = new Promise<void>(resolve => {
                    client1.sendToDevice.mockImplementation(() => {
                        resolve();
                        return Promise.resolve({});
                    });
                });

                await Promise.all([groupCall1.enter(), groupCall2.enter()]);

                MockRTCPeerConnection.triggerAllNegotiations();

                await toDeviceProm;

                expect(client1.sendToDevice.mock.calls[0][0]).toBe("m.call.invite");

                const toDeviceCallContent = client1.sendToDevice.mock.calls[0][1];
                expect(Object.keys(toDeviceCallContent).length).toBe(1);
                expect(Object.keys(toDeviceCallContent)[0]).toBe(FAKE_USER_ID_2);

                const toDeviceBobDevices = toDeviceCallContent[FAKE_USER_ID_2];
                expect(Object.keys(toDeviceBobDevices).length).toBe(1);
                expect(Object.keys(toDeviceBobDevices)[0]).toBe(FAKE_DEVICE_ID_2);

                const bobDeviceMessage = toDeviceBobDevices[FAKE_DEVICE_ID_2];
                expect(bobDeviceMessage.conf_id).toBe(FAKE_CONF_ID);
            } finally {
                await Promise.all([groupCall1.leave(), groupCall2.leave()]);
            }
        });

        it("Retries calls", async function() {
            jest.useFakeTimers();
            await groupCall1.create();

            try {
                const toDeviceProm = new Promise<void>(resolve => {
                    client1.sendToDevice.mockImplementation(() => {
                        resolve();
                        return Promise.resolve({});
                    });
                });

                await Promise.all([groupCall1.enter(), groupCall2.enter()]);

                MockRTCPeerConnection.triggerAllNegotiations();

                await toDeviceProm;

                expect(client1.sendToDevice).toHaveBeenCalled();

                const oldCall = groupCall1.getCallByUserId(client2.userId);
                oldCall!.emit(CallEvent.Hangup, oldCall!);

                client1.sendToDevice.mockClear();

                const toDeviceProm2 = new Promise<void>(resolve => {
                    client1.sendToDevice.mockImplementation(() => {
                        resolve();
                        return Promise.resolve({});
                    });
                });

                jest.advanceTimersByTime(groupCall1.retryCallInterval + 500);

                // when we placed the call, we could await on enter which waited for the call to
                // be made. We don't have that luxury now, so first have to wait for the call
                // to even be created...
                let newCall: MatrixCall | undefined;
                while (
                    (newCall = groupCall1.getCallByUserId(client2.userId)) === undefined ||
                    newCall.peerConn === undefined ||
                    newCall.callId == oldCall!.callId
                ) {
                    await flushPromises();
                }
                const mockPc = newCall.peerConn as unknown as MockRTCPeerConnection;

                // ...then wait for it to be ready to negotiate
                await mockPc.readyToNegotiate;

                MockRTCPeerConnection.triggerAllNegotiations();

                // ...and then finally we can wait for the invite to be sent
                await toDeviceProm2;

                expect(client1.sendToDevice).toHaveBeenCalledWith(EventType.CallInvite, expect.objectContaining({}));
            } finally {
                await Promise.all([groupCall1.leave(), groupCall2.leave()]);
            }
        });

        it("Updates call mute status correctly on call state change", async function() {
            await groupCall1.create();

            try {
                const toDeviceProm = new Promise<void>(resolve => {
                    client1.sendToDevice.mockImplementation(() => {
                        resolve();
                        return Promise.resolve({});
                    });
                });

                await Promise.all([groupCall1.enter(), groupCall2.enter()]);

                MockRTCPeerConnection.triggerAllNegotiations();

                await toDeviceProm;

                groupCall1.setMicrophoneMuted(false);
                groupCall1.setLocalVideoMuted(false);

                const call = groupCall1.getCallByUserId(client2.userId)!;
                call.isMicrophoneMuted = jest.fn().mockReturnValue(true);
                call.setMicrophoneMuted = jest.fn();
                call.isLocalVideoMuted = jest.fn().mockReturnValue(true);
                call.setLocalVideoMuted = jest.fn();

                call.emit(CallEvent.State, CallState.Connected);

                expect(call.setMicrophoneMuted).toHaveBeenCalledWith(false);
                expect(call.setLocalVideoMuted).toHaveBeenCalledWith(false);
            } finally {
                await Promise.all([groupCall1.leave(), groupCall2.leave()]);
            }
        });
    });

    describe("muting", () => {
        let mockClient: MatrixClient;
        let room: Room;

        beforeEach(() => {
            const typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );
            mockClient = typedMockClient as unknown as MatrixClient;

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_1);
            room.currentState.getStateEvents = jest.fn().mockImplementation((type: EventType, userId: string) => {
                return type === EventType.GroupCallMemberPrefix
                    ? FAKE_STATE_EVENTS.find(e => e.getStateKey() === userId) || FAKE_STATE_EVENTS
                    : { getContent: () => ([]) };
            });
            room.getMember = jest.fn().mockImplementation((userId) => ({ userId }));
        });

        describe("local muting", () => {
            it("should mute local audio when calling setMicrophoneMuted()", async () => {
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                groupCall.localCallFeed!.setAudioVideoMuted = jest.fn();
                const setAVMutedArray = groupCall.calls.map(call => {
                    call.localUsermediaFeed!.setAudioVideoMuted = jest.fn();
                    return call.localUsermediaFeed!.setAudioVideoMuted;
                });
                const tracksArray = groupCall.calls.reduce((acc: MediaStreamTrack[], call: MatrixCall) => {
                    acc.push(...call.localUsermediaStream!.getAudioTracks());
                    return acc;
                }, []);
                const sendMetadataUpdateArray = groupCall.calls.map(call => {
                    call.sendMetadataUpdate = jest.fn();
                    return call.sendMetadataUpdate;
                });

                await groupCall.setMicrophoneMuted(true);

                groupCall.localCallFeed!.stream.getAudioTracks().forEach(track => expect(track.enabled).toBe(false));
                expect(groupCall.localCallFeed!.setAudioVideoMuted).toHaveBeenCalledWith(true, null);
                setAVMutedArray.forEach(f => expect(f).toHaveBeenCalledWith(true, null));
                tracksArray.forEach(track => expect(track.enabled).toBe(false));
                sendMetadataUpdateArray.forEach(f => expect(f).toHaveBeenCalled());

                groupCall.terminate();
            });

            it("should mute local video when calling setLocalVideoMuted()", async () => {
                const groupCall = await createAndEnterGroupCall(mockClient, room);

                groupCall.localCallFeed!.setAudioVideoMuted = jest.fn();
                const setAVMutedArray = groupCall.calls.map(call => {
                    call.localUsermediaFeed!.setAudioVideoMuted = jest.fn();
                    call.localUsermediaFeed!.isVideoMuted = jest.fn().mockReturnValue(true);
                    return call.localUsermediaFeed!.setAudioVideoMuted;
                });
                const tracksArray = groupCall.calls.reduce((acc: MediaStreamTrack[], call: MatrixCall) => {
                    acc.push(...call.localUsermediaStream!.getVideoTracks());
                    return acc;
                }, []);
                const sendMetadataUpdateArray = groupCall.calls.map(call => {
                    call.sendMetadataUpdate = jest.fn();
                    return call.sendMetadataUpdate;
                });

                await groupCall.setLocalVideoMuted(true);

                groupCall.localCallFeed!.stream.getVideoTracks().forEach(track => expect(track.enabled).toBe(false));
                expect(groupCall.localCallFeed!.setAudioVideoMuted).toHaveBeenCalledWith(null, true);
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

                const feed = groupCall.getUserMediaFeedByUserId(call.invitee!);
                expect(feed!.isAudioMuted()).toBe(true);
                expect(feed!.isVideoMuted()).toBe(false);

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

                const feed = groupCall.getUserMediaFeedByUserId(call.invitee!);
                expect(feed!.isAudioMuted()).toBe(false);
                expect(feed!.isVideoMuted()).toBe(true);

                groupCall.terminate();
            });
        });
    });

    describe("incoming calls", () => {
        let mockClient: MatrixClient;
        let room: Room;
        let groupCall: GroupCall;

        beforeEach(async () => {
            // we are bob here because we're testing incoming calls, and since alice's user id
            // is lexicographically before Bob's, the spec requires that she calls Bob.
            const typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_2, FAKE_DEVICE_ID_2, FAKE_SESSION_ID_2,
            );
            mockClient = typedMockClient as unknown as MatrixClient;

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_2);
            room.getMember = jest.fn().mockImplementation((userId) => ({ userId }));

            groupCall = await createAndEnterGroupCall(mockClient, room);
        });

        afterEach(() => {
            groupCall.leave();
        });

        it("ignores incoming calls for other rooms", async () => {
            const mockCall = new MockCall("!someotherroom.fake.dummy", groupCall.groupCallId);

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).not.toHaveBeenCalled();
            expect(mockCall.answerWithCallFeeds).not.toHaveBeenCalled();
        });

        it("rejects incoming calls for the wrong group call", async () => {
            const mockCall = new MockCall(room.roomId, "not " + groupCall.groupCallId);

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).toHaveBeenCalled();
        });

        it("ignores incoming calls not in the ringing state", async () => {
            const mockCall = new MockCall(room.roomId, groupCall.groupCallId);
            mockCall.state = CallState.Connected;

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).not.toHaveBeenCalled();
            expect(mockCall.answerWithCallFeeds).not.toHaveBeenCalled();
        });

        it("answers calls for the right room & group call ID", async () => {
            const mockCall = new MockCall(room.roomId, groupCall.groupCallId);

            mockClient.emit(CallEventHandlerEvent.Incoming, mockCall as unknown as MatrixCall);

            expect(mockCall.reject).not.toHaveBeenCalled();
            expect(mockCall.answerWithCallFeeds).toHaveBeenCalled();
            expect(groupCall.calls).toEqual([mockCall]);
        });

        it("replaces calls if it already has one with the same user", async () => {
            const oldMockCall = new MockCall(room.roomId, groupCall.groupCallId);
            const newMockCall = new MockCall(room.roomId, groupCall.groupCallId);
            newMockCall.callId = "not " + oldMockCall.callId;

            mockClient.emit(CallEventHandlerEvent.Incoming, oldMockCall as unknown as MatrixCall);
            mockClient.emit(CallEventHandlerEvent.Incoming, newMockCall as unknown as MatrixCall);

            expect(oldMockCall.hangup).toHaveBeenCalled();
            expect(newMockCall.answerWithCallFeeds).toHaveBeenCalled();
            expect(groupCall.calls).toEqual([newMockCall]);
        });

        it("starts to process incoming calls when we've entered", async () => {
            // First we leave the call since we have already entered
            groupCall.leave();

            const call = new MockCall(room.roomId, groupCall.groupCallId);
            mockClient.callEventHandler!.calls = new Map<string, MatrixCall>([
                [call.callId, call.typed()],
            ]);
            await groupCall.enter();

            expect(call.answerWithCallFeeds).toHaveBeenCalled();
        });
    });

    describe("screensharing", () => {
        let typedMockClient: MockCallMatrixClient;
        let mockClient: MatrixClient;
        let room: Room;
        let groupCall: GroupCall;

        beforeEach(async () => {
            typedMockClient = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );
            mockClient = typedMockClient.typed();

            room = new Room(FAKE_ROOM_ID, mockClient, FAKE_USER_ID_1);
            room.getMember = jest.fn().mockImplementation((userId) => ({ userId }));
            room.currentState.getStateEvents = jest.fn().mockImplementation((type: EventType, userId: string) => {
                return type === EventType.GroupCallMemberPrefix
                    ? FAKE_STATE_EVENTS.find(e => e.getStateKey() === userId) || FAKE_STATE_EVENTS
                    : { getContent: () => ([]) };
            });

            groupCall = await createAndEnterGroupCall(mockClient, room);
        });

        it("sending screensharing stream", async () => {
            const onNegotiationNeededArray = groupCall.calls.map(call => {
                // @ts-ignore Mock
                call.gotLocalOffer = jest.fn();
                // @ts-ignore Mock
                return call.gotLocalOffer;
            });

            let enabledResult;
            enabledResult = await groupCall.setScreensharingEnabled(true);
            expect(enabledResult).toEqual(true);
            expect(typedMockClient.mediaHandler.getScreensharingStream).toHaveBeenCalled();
            MockRTCPeerConnection.triggerAllNegotiations();

            expect(groupCall.screenshareFeeds).toHaveLength(1);
            groupCall.calls.forEach(c => {
                expect(c.getLocalFeeds().find(f => f.purpose === SDPStreamMetadataPurpose.Screenshare)).toBeDefined();
            });
            onNegotiationNeededArray.forEach(f => expect(f).toHaveBeenCalled());

            // Enabling it again should do nothing
            typedMockClient.mediaHandler.getScreensharingStream.mockClear();
            enabledResult = await groupCall.setScreensharingEnabled(true);
            expect(enabledResult).toEqual(true);
            expect(typedMockClient.mediaHandler.getScreensharingStream).not.toHaveBeenCalled();

            // Should now be able to disable it
            enabledResult = await groupCall.setScreensharingEnabled(false);
            expect(enabledResult).toEqual(false);
            expect(groupCall.screenshareFeeds).toHaveLength(0);

            groupCall.terminate();
        });

        it("receiving screensharing stream", async () => {
            // It takes a bit of time for the calls to get created
            await sleep(10);

            const call = groupCall.calls[0];
            call.getOpponentMember = () => ({ userId: call.invitee }) as RoomMember;
            call.onNegotiateReceived({
                getContent: () => ({
                    [SDPStreamMetadataKey]: {
                        "screensharing_stream": {
                            purpose: SDPStreamMetadataPurpose.Screenshare,
                        },
                    },
                    description: {
                        type: "offer",
                        sdp: "...",
                    },
                }),
            } as MatrixEvent);
            // @ts-ignore Mock
            call.pushRemoteFeed(new MockMediaStream("screensharing_stream", [
                new MockMediaStreamTrack("video_track", "video"),
            ]));

            expect(groupCall.screenshareFeeds).toHaveLength(1);
            expect(groupCall.getScreenshareFeedByUserId(call.invitee!)).toBeDefined();

            groupCall.terminate();
        });

        it("cleans up screensharing when terminating", async () => {
            // @ts-ignore Mock
            jest.spyOn(groupCall, "removeScreenshareFeed");
            jest.spyOn(mockClient.getMediaHandler(), "stopScreensharingStream");

            await groupCall.setScreensharingEnabled(true);

            const screensharingFeed = groupCall.localScreenshareFeed;

            groupCall.terminate();

            expect(mockClient.getMediaHandler()!.stopScreensharingStream).toHaveBeenCalledWith(
                screensharingFeed!.stream,
            );
            // @ts-ignore Mock
            expect(groupCall.removeScreenshareFeed).toHaveBeenCalledWith(screensharingFeed);
            expect(groupCall.localScreenshareFeed).toBeUndefined();
        });
    });

    describe("active speaker events", () => {
        let room: Room;
        let groupCall: GroupCall;
        let mediaFeed1: CallFeed;
        let mediaFeed2: CallFeed;
        let onActiveSpeakerEvent: jest.Mock<void, []>;

        beforeEach(async () => {
            jest.useFakeTimers();

            const mockClient = new MockCallMatrixClient(
                FAKE_USER_ID_1, FAKE_DEVICE_ID_1, FAKE_SESSION_ID_1,
            );

            room = new Room(FAKE_ROOM_ID, mockClient.typed(), FAKE_USER_ID_1);
            groupCall = await createAndEnterGroupCall(mockClient.typed(), room);

            mediaFeed1 = new CallFeed({
                client: mockClient.typed(),
                roomId: FAKE_ROOM_ID,
                userId: FAKE_USER_ID_2,
                stream: (new MockMediaStream("foo", [])).typed(),
                purpose: SDPStreamMetadataPurpose.Usermedia,
                audioMuted: false,
                videoMuted: true,
            });
            groupCall.userMediaFeeds.push(mediaFeed1);

            mediaFeed2 = new CallFeed({
                client: mockClient.typed(),
                roomId: FAKE_ROOM_ID,
                userId: FAKE_USER_ID_3,
                stream: (new MockMediaStream("foo", [])).typed(),
                purpose: SDPStreamMetadataPurpose.Usermedia,
                audioMuted: false,
                videoMuted: true,
            });
            groupCall.userMediaFeeds.push(mediaFeed2);

            onActiveSpeakerEvent = jest.fn();
            groupCall.on(GroupCallEvent.ActiveSpeakerChanged, onActiveSpeakerEvent);
        });

        afterEach(() => {
            groupCall.off(GroupCallEvent.ActiveSpeakerChanged, onActiveSpeakerEvent);

            jest.useRealTimers();
        });

        it("fires active speaker events when a user is speaking", async () => {
            mediaFeed1.speakingVolumeSamples = [100, 100];
            mediaFeed2.speakingVolumeSamples = [0, 0];

            jest.runOnlyPendingTimers();
            expect(groupCall.activeSpeaker).toEqual(FAKE_USER_ID_2);
            expect(onActiveSpeakerEvent).toHaveBeenCalledWith(FAKE_USER_ID_2);

            mediaFeed1.speakingVolumeSamples = [0, 0];
            mediaFeed2.speakingVolumeSamples = [100, 100];

            jest.runOnlyPendingTimers();
            expect(groupCall.activeSpeaker).toEqual(FAKE_USER_ID_3);
            expect(onActiveSpeakerEvent).toHaveBeenCalledWith(FAKE_USER_ID_3);
        });
    });

    describe("creating group calls", () => {
        let client: MatrixClient;

        beforeEach(() => {
            client = new MatrixClient({ baseUrl: "base_url" });

            jest.spyOn(client, "sendStateEvent").mockResolvedValue({} as any);
        });

        afterEach(() => {
            client.stopClient();
        });

        it("throws when there already is a call", async () => {
            jest.spyOn(client, "getRoom").mockReturnValue(new Room("room_id", client, "my_user_id"));

            await client.createGroupCall(
                "room_id",
                GroupCallType.Video,
                false,
                GroupCallIntent.Prompt,
            );

            await expect(client.createGroupCall(
                "room_id",
                GroupCallType.Video,
                false,
                GroupCallIntent.Prompt,
            )).rejects.toThrow("room_id already has an existing group call");
        });

        it("throws if the room doesn't exist", async () => {
            await expect(client.createGroupCall(
                "room_id",
                GroupCallType.Video,
                false,
                GroupCallIntent.Prompt,
            )).rejects.toThrow("Cannot find room room_id");
        });

        describe("correctly passes parameters", () => {
            beforeEach(() => {
                jest.spyOn(client, "getRoom").mockReturnValue(new Room("room_id", client, "my_user_id"));
            });

            it("correctly passes voice ptt room call", async () => {
                const groupCall = await client.createGroupCall(
                    "room_id",
                    GroupCallType.Voice,
                    true,
                    GroupCallIntent.Room,
                );

                expect(groupCall.type).toBe(GroupCallType.Voice);
                expect(groupCall.isPtt).toBe(true);
                expect(groupCall.intent).toBe(GroupCallIntent.Room);
            });

            it("correctly passes voice ringing call", async () => {
                const groupCall = await client.createGroupCall(
                    "room_id",
                    GroupCallType.Voice,
                    false,
                    GroupCallIntent.Ring,
                );

                expect(groupCall.type).toBe(GroupCallType.Voice);
                expect(groupCall.isPtt).toBe(false);
                expect(groupCall.intent).toBe(GroupCallIntent.Ring);
            });

            it("correctly passes video prompt call", async () => {
                const groupCall = await client.createGroupCall(
                    "room_id",
                    GroupCallType.Video,
                    false,
                    GroupCallIntent.Prompt,
                );

                expect(groupCall.type).toBe(GroupCallType.Video);
                expect(groupCall.isPtt).toBe(false);
                expect(groupCall.intent).toBe(GroupCallIntent.Prompt);
            });
        });
    });
});
