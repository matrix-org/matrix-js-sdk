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

import { mocked } from "jest-mock";

import {
    ClientEvent,
    GroupCall,
    GroupCallIntent,
    GroupCallState,
    GroupCallType,
    IContent,
    MatrixEvent,
    Room,
    RoomState,
} from "../../../src";
import { SyncState } from "../../../src/sync";
import { GroupCallTerminationReason } from "../../../src/webrtc/groupCall";
import { GroupCallEventHandler, GroupCallEventHandlerEvent } from "../../../src/webrtc/groupCallEventHandler";
import { flushPromises } from "../../test-utils/flushPromises";
import {
    makeMockGroupCallMemberStateEvent,
    makeMockGroupCallStateEvent,
    MockCallMatrixClient,
} from "../../test-utils/webrtc";

const FAKE_USER_ID = "@alice:test.dummy";
const FAKE_DEVICE_ID = "AAAAAAA";
const FAKE_SESSION_ID = "session1";
const FAKE_ROOM_ID = "!roomid:test.dummy";
const FAKE_GROUP_CALL_ID = "fakegroupcallid";

describe('Group Call Event Handler', function() {
    let groupCallEventHandler: GroupCallEventHandler;
    let mockClient: MockCallMatrixClient;
    let mockRoom: Room;

    beforeEach(() => {
        mockClient = new MockCallMatrixClient(
            FAKE_USER_ID, FAKE_DEVICE_ID, FAKE_SESSION_ID,
        );
        groupCallEventHandler = new GroupCallEventHandler(mockClient.typed());

        mockRoom = {
            roomId: FAKE_ROOM_ID,
            currentState: {
                getStateEvents: jest.fn().mockReturnValue([makeMockGroupCallStateEvent(
                    FAKE_ROOM_ID, FAKE_GROUP_CALL_ID,
                )]),
            },
        } as unknown as Room;

        (mockClient as any).getRoom = jest.fn().mockReturnValue(mockRoom);
    });

    describe("reacts to state changes", () => {
        it("terminates call", async () => {
            await groupCallEventHandler.start();
            mockClient.emitRoomState(
                makeMockGroupCallStateEvent(FAKE_ROOM_ID, FAKE_GROUP_CALL_ID),
                { roomId: FAKE_ROOM_ID } as unknown as RoomState,
            );

            const groupCall = groupCallEventHandler.groupCalls.get(FAKE_ROOM_ID)!;

            expect(groupCall.state).toBe(GroupCallState.LocalCallFeedUninitialized);

            mockClient.emitRoomState(
                makeMockGroupCallStateEvent(
                    FAKE_ROOM_ID, FAKE_GROUP_CALL_ID, {
                        "m.type": GroupCallType.Video,
                        "m.intent": GroupCallIntent.Prompt,
                        "m.terminated": GroupCallTerminationReason.CallEnded,
                    },
                ),
                {
                    roomId: FAKE_ROOM_ID,
                } as unknown as RoomState,
            );

            expect(groupCall.state).toBe(GroupCallState.Ended);
        });
    });

    it("waits until client starts syncing", async () => {
        mockClient.getSyncState.mockReturnValue(null);
        let isStarted = false;
        (async () => {
            await groupCallEventHandler.start();
            isStarted = true;
        })();

        const setSyncState = async (newState: SyncState) => {
            const oldState = mockClient.getSyncState();
            mockClient.getSyncState.mockReturnValue(newState);
            mockClient.emit(ClientEvent.Sync, newState, oldState, undefined);
            await flushPromises();
        };

        await flushPromises();
        expect(isStarted).toEqual(false);

        await setSyncState(SyncState.Prepared);
        expect(isStarted).toEqual(false);

        await setSyncState(SyncState.Syncing);
        expect(isStarted).toEqual(true);
    });

    it("finds existing group calls when started", async () => {
        const mockClientEmit = mockClient.emit = jest.fn();

        mockClient.getRooms.mockReturnValue([mockRoom]);
        await groupCallEventHandler.start();

        expect(mockClientEmit).toHaveBeenCalledWith(
            GroupCallEventHandlerEvent.Incoming,
            expect.objectContaining({
                groupCallId: FAKE_GROUP_CALL_ID,
            }),
        );

        groupCallEventHandler.stop();
    });

    it("can wait until a room is ready for group calls", async () => {
        await groupCallEventHandler.start();

        const prom = groupCallEventHandler.waitUntilRoomReadyForGroupCalls(FAKE_ROOM_ID);
        let resolved = false;

        (async () => {
            await prom;
            resolved = true;
        })();

        expect(resolved).toEqual(false);
        mockClient.emit(ClientEvent.Room, mockRoom);

        await prom;
        expect(resolved).toEqual(true);

        groupCallEventHandler.stop();
    });

    it("fires events for incoming calls", async () => {
        const onIncomingGroupCall = jest.fn();
        mockClient.on(GroupCallEventHandlerEvent.Incoming, onIncomingGroupCall);
        await groupCallEventHandler.start();

        mockClient.emitRoomState(
            makeMockGroupCallStateEvent(
                FAKE_ROOM_ID, FAKE_GROUP_CALL_ID,
            ),
            {
                roomId: FAKE_ROOM_ID,
            } as unknown as RoomState,
        );

        expect(onIncomingGroupCall).toHaveBeenCalledWith(expect.objectContaining({
            groupCallId: FAKE_GROUP_CALL_ID,
        }));

        mockClient.off(GroupCallEventHandlerEvent.Incoming, onIncomingGroupCall);
    });

    it("handles data channel", async () => {
        await groupCallEventHandler.start();

        const dataChannelOptions = {
            "maxPacketLifeTime": "life_time",
            "maxRetransmits": "retransmits",
            "ordered": "ordered",
            "protocol": "protocol",
        };

        mockClient.emitRoomState(
            makeMockGroupCallStateEvent(
                FAKE_ROOM_ID,
                FAKE_GROUP_CALL_ID,
                {
                    "m.type": GroupCallType.Video,
                    "m.intent": GroupCallIntent.Prompt,
                    "dataChannelsEnabled": true,
                    dataChannelOptions,
                },
            ),
            {
                roomId: FAKE_ROOM_ID,
            } as unknown as RoomState,
        );

        // @ts-ignore Mock dataChannelsEnabled is private
        expect(groupCallEventHandler.groupCalls.get(FAKE_ROOM_ID)?.dataChannelsEnabled).toBe(true);
        // @ts-ignore Mock dataChannelOptions is private
        expect(groupCallEventHandler.groupCalls.get(FAKE_ROOM_ID)?.dataChannelOptions).toStrictEqual(
            dataChannelOptions,
        );
    });

    it("sends member events to group calls", async () => {
        await groupCallEventHandler.start();

        const mockGroupCall = {
            onMemberStateChanged: jest.fn(),
        };

        groupCallEventHandler.groupCalls.set(FAKE_ROOM_ID, mockGroupCall as unknown as GroupCall);

        const mockStateEvent = makeMockGroupCallMemberStateEvent(FAKE_ROOM_ID, FAKE_GROUP_CALL_ID);

        mockClient.emitRoomState(
            mockStateEvent,
            {
                roomId: FAKE_ROOM_ID,
            } as unknown as RoomState,
        );

        expect(mockGroupCall.onMemberStateChanged).toHaveBeenCalledWith(mockStateEvent);
    });

    describe("ignoring invalid group call state events", () => {
        let mockClientEmit: jest.Func;

        beforeEach(() => {
            mockClientEmit = mockClient.emit = jest.fn();
        });

        afterEach(() => {
            groupCallEventHandler.stop();

            jest.clearAllMocks();
        });

        const setupCallAndStart = async (content?: IContent) => {
            mocked(mockRoom.currentState.getStateEvents).mockReturnValue([
                makeMockGroupCallStateEvent(
                    FAKE_ROOM_ID,
                    FAKE_GROUP_CALL_ID,
                    content,
                ),
            ] as unknown as MatrixEvent);
            mockClient.getRooms.mockReturnValue([mockRoom]);
            await groupCallEventHandler.start();
        };

        it("ignores terminated calls", async () => {
            await setupCallAndStart({
                "m.type": GroupCallType.Video,
                "m.intent": GroupCallIntent.Prompt,
                "m.terminated": GroupCallTerminationReason.CallEnded,
            });

            expect(mockClientEmit).not.toHaveBeenCalledWith(
                GroupCallEventHandlerEvent.Incoming,
                expect.objectContaining({
                    groupCallId: FAKE_GROUP_CALL_ID,
                }),
            );
        });

        it("ignores calls with invalid type", async () => {
            await setupCallAndStart({
                "m.type": "fake_type",
                "m.intent": GroupCallIntent.Prompt,
            });

            expect(mockClientEmit).not.toHaveBeenCalledWith(
                GroupCallEventHandlerEvent.Incoming,
                expect.objectContaining({
                    groupCallId: FAKE_GROUP_CALL_ID,
                }),
            );
        });

        it("ignores calls with invalid intent", async () => {
            await setupCallAndStart({
                "m.type": GroupCallType.Video,
                "m.intent": "fake_intent",
            });

            expect(mockClientEmit).not.toHaveBeenCalledWith(
                GroupCallEventHandlerEvent.Incoming,
                expect.objectContaining({
                    groupCallId: FAKE_GROUP_CALL_ID,
                }),
            );
        });

        it("ignores calls without a room", async () => {
            mockClient.getRoom.mockReturnValue(undefined);

            await setupCallAndStart();

            expect(mockClientEmit).not.toHaveBeenCalledWith(
                GroupCallEventHandlerEvent.Incoming,
                expect.objectContaining({
                    groupCallId: FAKE_GROUP_CALL_ID,
                }),
            );
        });
    });
});
