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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    ClientEvent,
    EventTimeline,
    EventType,
    IRoomTimelineData,
    MatrixClient,
    MatrixEvent,
    RoomEvent,
} from "../../../src";
import { RoomStateEvent } from "../../../src/models/room-state";
import { MatrixRTCSessionManagerEvents } from "../../../src/matrixrtc/MatrixRTCSessionManager";
import { makeMockRoom, makeMockRoomState, membershipTemplate } from "./mocks";
import { mocked } from "../../test-utils";

describe("MatrixRTCSessionManager", () => {
    let client: MatrixClient;

    beforeEach(async () => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.matrixRTC.start();
    });

    afterEach(() => {
        client.stopClient();
        client.matrixRTC.stop();
    });

    it("Fires event when session starts", () => {
        const onStarted = vi.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);

        try {
            const room1 = makeMockRoom([membershipTemplate]);
            vi.spyOn(client, "getRooms").mockReturnValue([room1]);

            client.emit(ClientEvent.Room, room1);
            expect(onStarted).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
        } finally {
            client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
        }
    });

    it("Fires event when session ends", () => {
        const onEnded = vi.fn();
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
        const room1 = makeMockRoom(membershipTemplate);
        vi.spyOn(client, "getRooms").mockReturnValue([room1]);
        vi.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);

        mocked(room1.getLiveTimeline).mockReturnValue({
            getState: vi.fn().mockReturnValue(makeMockRoomState([{}], room1.roomId)),
        });

        const roomState = room1.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
        const membEvent = roomState.getStateEvents("")[0];

        client.emit(RoomStateEvent.Events, membEvent, roomState, null);

        expect(onEnded).toHaveBeenCalledWith(room1.roomId, client.matrixRTC.getActiveRoomSession(room1));
    });

    it("Calls onCallEncryption on encryption keys event", async () => {
        const room1 = makeMockRoom([membershipTemplate]);
        vi.spyOn(client, "getRooms").mockReturnValue([room1]);
        vi.spyOn(client, "getRoom").mockReturnValue(room1);

        client.emit(ClientEvent.Room, room1);
        const onCallEncryptionMock = vi.fn();
        client.matrixRTC.getRoomSession(room1).onCallEncryption = onCallEncryptionMock;
        client.decryptEventIfNeeded = () => Promise.resolve();
        const timelineEvent = {
            getType: vi.fn().mockReturnValue(EventType.CallEncryptionKeysPrefix),
            getContent: vi.fn().mockReturnValue({}),
            getSender: vi.fn().mockReturnValue("@mock:user.example"),
            getRoomId: vi.fn().mockReturnValue("!room:id"),
            isDecryptionFailure: vi.fn().mockReturnValue(false),
            sender: {
                userId: "@mock:user.example",
            },
        } as unknown as MatrixEvent;
        client.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);
        await new Promise(process.nextTick);
        expect(onCallEncryptionMock).toHaveBeenCalled();
    });

    describe("event decryption", () => {
        it("Retries decryption and processes success", async () => {
            try {
                vi.useFakeTimers();
                const room1 = makeMockRoom([membershipTemplate]);
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);
                vi.spyOn(client, "getRoom").mockReturnValue(room1);

                client.emit(ClientEvent.Room, room1);
                const onCallEncryptionMock = vi.fn();
                client.matrixRTC.getRoomSession(room1).onCallEncryption = onCallEncryptionMock;
                let isDecryptionFailure = true;
                client.decryptEventIfNeeded = vi
                    .fn()
                    .mockReturnValueOnce(Promise.resolve())
                    .mockImplementation(() => {
                        isDecryptionFailure = false;
                        return Promise.resolve();
                    });
                const timelineEvent = {
                    getType: vi.fn().mockReturnValue(EventType.CallEncryptionKeysPrefix),
                    getContent: vi.fn().mockReturnValue({}),
                    getSender: vi.fn().mockReturnValue("@mock:user.example"),
                    getRoomId: vi.fn().mockReturnValue("!room:id"),
                    isDecryptionFailure: vi.fn().mockImplementation(() => isDecryptionFailure),
                    getId: vi.fn().mockReturnValue("event_id"),
                    sender: {
                        userId: "@mock:user.example",
                    },
                } as unknown as MatrixEvent;
                client.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);

                // should retry after one second:
                await vi.advanceTimersByTimeAsync(1500);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("Retries decryption and processes failure", async () => {
            try {
                vi.useFakeTimers();
                const room1 = makeMockRoom([membershipTemplate]);
                vi.spyOn(client, "getRooms").mockReturnValue([room1]);
                vi.spyOn(client, "getRoom").mockReturnValue(room1);

                client.emit(ClientEvent.Room, room1);
                const onCallEncryptionMock = vi.fn();
                client.matrixRTC.getRoomSession(room1).onCallEncryption = onCallEncryptionMock;
                client.decryptEventIfNeeded = vi.fn().mockReturnValue(Promise.resolve());
                const timelineEvent = {
                    getType: vi.fn().mockReturnValue(EventType.CallEncryptionKeysPrefix),
                    getContent: vi.fn().mockReturnValue({}),
                    getSender: vi.fn().mockReturnValue("@mock:user.example"),
                    getRoomId: vi.fn().mockReturnValue("!room:id"),
                    isDecryptionFailure: vi.fn().mockReturnValue(true), // always fail
                    getId: vi.fn().mockReturnValue("event_id"),
                    sender: {
                        userId: "@mock:user.example",
                    },
                } as unknown as MatrixEvent;
                client.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);

                // should retry after one second:
                await vi.advanceTimersByTimeAsync(1500);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);

                // doesn't retry again:
                await vi.advanceTimersByTimeAsync(1500);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
