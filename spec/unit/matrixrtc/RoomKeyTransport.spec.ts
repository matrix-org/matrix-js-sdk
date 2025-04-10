/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { makeMockEvent, makeMockRoom, membershipTemplate, makeKey } from "./mocks";
import { RoomKeyTransport } from "../../../src/matrixrtc/RoomKeyTransport";
import { KeyTransportEvents } from "../../../src/matrixrtc/IKeyTransport";
import { EventType, MatrixClient, RoomEvent } from "../../../src";
import { type IRoomTimelineData, MatrixEvent, type Room } from "../../../src";
import type { Mocked } from "jest-mock";
import type { Logger } from "../../../src/logger.ts";

describe("RoomKeyTransport", () => {
    let client: MatrixClient;
    let room: Room & {
        emitTimelineEvent: (event: MatrixEvent) => void;
    };
    let transport: RoomKeyTransport;
    let mockLogger: Mocked<Logger>;

    const onCallEncryptionMock = jest.fn();
    beforeEach(() => {
        onCallEncryptionMock.mockReset();
        mockLogger = {
            debug: jest.fn(),
            warn: jest.fn(),
            info: jest.fn(),
        } as unknown as Mocked<Logger>;

        const statistics = {
            counters: {
                roomEventEncryptionKeysSent: 0,
                roomEventEncryptionKeysReceived: 0,
            },
            totals: {
                roomEventEncryptionKeysReceivedTotalAge: 0,
            },
        };
        room = makeMockRoom([membershipTemplate]);
        client = new MatrixClient({ baseUrl: "base_url" });
        client.matrixRTC.start();
        transport = new RoomKeyTransport(room, client, statistics, {
            getChild: jest.fn().mockReturnValue(mockLogger),
        } as unknown as Mocked<Logger>);
        transport.on(KeyTransportEvents.ReceivedKeys, (...p) => {
            onCallEncryptionMock(...p);
        });
        transport.start();
    });

    afterEach(() => {
        client.stopClient();
        client.matrixRTC.stop();
        transport.stop();
    });

    it("Calls onCallEncryption on encryption keys event", async () => {
        client.decryptEventIfNeeded = () => Promise.resolve();
        const timelineEvent = makeMockEvent(EventType.CallEncryptionKeysPrefix, "@mock:user.example", "!room:id", {
            call_id: "",
            keys: [makeKey(0, "testKey")],
            sent_ts: Date.now(),
            device_id: "AAAAAAA",
        });
        room.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);
        await new Promise(process.nextTick);
        expect(onCallEncryptionMock).toHaveBeenCalled();
    });

    describe("event decryption", () => {
        it("Retries decryption and processes success", async () => {
            jest.useFakeTimers();
            let isDecryptionFailure = true;
            client.decryptEventIfNeeded = jest
                .fn()
                .mockReturnValueOnce(Promise.resolve())
                .mockImplementation(() => {
                    isDecryptionFailure = false;
                    return Promise.resolve();
                });

            const timelineEvent = Object.assign(
                makeMockEvent(EventType.CallEncryptionKeysPrefix, "@mock:user.example", "!room:id", {
                    call_id: "",
                    keys: [makeKey(0, "testKey")],
                    sent_ts: Date.now(),
                    device_id: "AAAAAAA",
                }),
                { isDecryptionFailure: jest.fn().mockImplementation(() => isDecryptionFailure) },
            );
            room.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);

            expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
            expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);

            // should retry after one second:
            await jest.advanceTimersByTimeAsync(1500);

            expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
            expect(onCallEncryptionMock).toHaveBeenCalledTimes(1);
            jest.useRealTimers();
        });

        it("Retries decryption and processes failure", async () => {
            try {
                jest.useFakeTimers();
                const onCallEncryptionMock = jest.fn();
                client.decryptEventIfNeeded = jest.fn().mockReturnValue(Promise.resolve());

                const timelineEvent = Object.assign(
                    makeMockEvent(EventType.CallEncryptionKeysPrefix, "@mock:user.example", "!room:id", {
                        call_id: "",
                        keys: [makeKey(0, "testKey")],
                        sent_ts: Date.now(),
                        device_id: "AAAAAAA",
                    }),
                    { isDecryptionFailure: jest.fn().mockReturnValue(true) },
                );

                room.emit(RoomEvent.Timeline, timelineEvent, undefined, undefined, false, {} as IRoomTimelineData);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);

                // should retry after one second:
                await jest.advanceTimersByTimeAsync(1500);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);

                // doesn't retry again:
                await jest.advanceTimersByTimeAsync(1500);

                expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
                expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe("malformed events", () => {
        const MALFORMED_EVENT = [
            // empty content
            new MatrixEvent({
                type: EventType.CallEncryptionKeysPrefix,
                sender: "@alice:example.com",
                content: {},
            }),
            // no sender
            new MatrixEvent({
                type: EventType.CallEncryptionKeysPrefix,
                content: {
                    call_id: "",
                    keys: [makeKey(0, "testKey")],
                    sent_ts: Date.now(),
                    device_id: "AAAAAAA",
                },
            }),
            // Call_id not empty string
            new MatrixEvent({
                type: EventType.CallEncryptionKeysPrefix,
                sender: "@alice:example.com",
                content: {
                    call_id: "FOO",
                    keys: [makeKey(0, "testKey")],
                    sent_ts: Date.now(),
                    device_id: "AAAAAAA",
                },
            }),
            // Various Malformed keys
            new MatrixEvent({
                type: EventType.CallEncryptionKeysPrefix,
                sender: "@alice:example.com",
                content: {
                    call_id: "",
                    keys: "FOO",
                    sent_ts: Date.now(),
                    device_id: "AAAAAAA",
                },
            }),
            new MatrixEvent({
                type: EventType.CallEncryptionKeysPrefix,
                sender: "@alice:example.com",
                content: {
                    call_id: "",
                    keys: [{ index: 0 }],
                    sent_ts: Date.now(),
                    device_id: "AAAAAAA",
                },
            }),
            new MatrixEvent({
                type: EventType.CallEncryptionKeysPrefix,
                sender: "@alice:example.com",
                content: {
                    call_id: "",
                    keys: [
                        {
                            key: "BASE64KEY",
                            index: "mcall",
                        },
                    ],
                    sent_ts: Date.now(),
                    device_id: "AAAAAAA",
                },
            }),
        ];

        test.each(MALFORMED_EVENT)("should warn on malformed event %j", (event) => {
            transport.onEncryptionEvent(event);
            expect(mockLogger.warn).toHaveBeenCalled();
            expect(onCallEncryptionMock).toHaveBeenCalledTimes(0);
        });
    });
});
