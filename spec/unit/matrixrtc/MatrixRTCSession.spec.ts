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

import { EventTimeline, EventType, MatrixClient, MatrixError, MatrixEvent, Room } from "../../../src";
import { CallMembershipData } from "../../../src/matrixrtc/CallMembership";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "../../../src/matrixrtc/MatrixRTCSession";
import { EncryptionKeysEventContent } from "../../../src/matrixrtc/types";
import { randomString } from "../../../src/randomstring";
import { makeMockRoom, makeMockRoomState, mockRTCEvent } from "./mocks";

const membershipTemplate: CallMembershipData = {
    call_id: "",
    scope: "m.room",
    application: "m.call",
    device_id: "AAAAAAA",
    expires: 60 * 60 * 1000,
    membershipID: "bloop",
};

const mockFocus = { type: "mock" };

describe("MatrixRTCSession", () => {
    let client: MatrixClient;
    let sess: MatrixRTCSession | undefined;

    beforeEach(() => {
        client = new MatrixClient({ baseUrl: "base_url" });
        client.getUserId = jest.fn().mockReturnValue("@alice:example.org");
        client.getDeviceId = jest.fn().mockReturnValue("AAAAAAA");
    });

    afterEach(() => {
        client.stopClient();
        client.matrixRTC.stop();
        if (sess) sess.stop();
        sess = undefined;
    });

    it("Creates a room-scoped session from room state", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);

        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships.length).toEqual(1);
        expect(sess?.memberships[0].callId).toEqual("");
        expect(sess?.memberships[0].scope).toEqual("m.room");
        expect(sess?.memberships[0].application).toEqual("m.call");
        expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
        expect(sess?.memberships[0].membershipID).toEqual("bloop");
        expect(sess?.memberships[0].isExpired()).toEqual(false);
        expect(sess?.callId).toEqual("");
    });

    it("ignores expired memberships events", () => {
        const expiredMembership = Object.assign({}, membershipTemplate);
        expiredMembership.expires = 1000;
        expiredMembership.device_id = "EXPIRED";
        const mockRoom = makeMockRoom([membershipTemplate, expiredMembership], 10000);

        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships.length).toEqual(1);
        expect(sess?.memberships[0].deviceId).toEqual("AAAAAAA");
    });

    it("honours created_ts", () => {
        const expiredMembership = Object.assign({}, membershipTemplate);
        expiredMembership.created_ts = 500;
        expiredMembership.expires = 1000;
        const mockRoom = makeMockRoom([expiredMembership]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships[0].getAbsoluteExpiry()).toEqual(1500);
    });

    it("returns empty session if no membership events are present", () => {
        const mockRoom = makeMockRoom([]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess?.memberships).toHaveLength(0);
    });

    it("safely ignores events with no memberships section", () => {
        const mockRoom = {
            roomId: randomString(8),
            getLiveTimeline: jest.fn().mockReturnValue({
                getState: jest.fn().mockReturnValue({
                    getStateEvents: (_type: string, _stateKey: string) => [
                        {
                            getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                            getContent: jest.fn().mockReturnValue({}),
                            getSender: jest.fn().mockReturnValue("@mock:user.example"),
                            getTs: jest.fn().mockReturnValue(1000),
                            getLocalAge: jest.fn().mockReturnValue(0),
                        },
                    ],
                }),
            }),
        };
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom as unknown as Room);
        expect(sess.memberships).toHaveLength(0);
    });

    it("safely ignores events with junk memberships section", () => {
        const mockRoom = {
            roomId: randomString(8),
            getLiveTimeline: jest.fn().mockReturnValue({
                getState: jest.fn().mockReturnValue({
                    getStateEvents: (_type: string, _stateKey: string) => [
                        {
                            getType: jest.fn().mockReturnValue(EventType.GroupCallMemberPrefix),
                            getContent: jest.fn().mockReturnValue({ memberships: "i am a fish" }),
                            getSender: jest.fn().mockReturnValue("@mock:user.example"),
                            getTs: jest.fn().mockReturnValue(1000),
                            getLocalAge: jest.fn().mockReturnValue(0),
                        },
                    ],
                }),
            }),
        };
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom as unknown as Room);
        expect(sess.memberships).toHaveLength(0);
    });

    it("ignores memberships with no expires_ts", () => {
        const expiredMembership = Object.assign({}, membershipTemplate);
        (expiredMembership.expires as number | undefined) = undefined;
        const mockRoom = makeMockRoom([expiredMembership]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess.memberships).toHaveLength(0);
    });

    it("ignores memberships with no device_id", () => {
        const testMembership = Object.assign({}, membershipTemplate);
        (testMembership.device_id as string | undefined) = undefined;
        const mockRoom = makeMockRoom([testMembership]);
        const sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess.memberships).toHaveLength(0);
    });

    it("ignores memberships with no call_id", () => {
        const testMembership = Object.assign({}, membershipTemplate);
        (testMembership.call_id as string | undefined) = undefined;
        const mockRoom = makeMockRoom([testMembership]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess.memberships).toHaveLength(0);
    });

    it("ignores memberships with no scope", () => {
        const testMembership = Object.assign({}, membershipTemplate);
        (testMembership.scope as string | undefined) = undefined;
        const mockRoom = makeMockRoom([testMembership]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess.memberships).toHaveLength(0);
    });

    it("ignores anything that's not a room-scoped call (for now)", () => {
        const testMembership = Object.assign({}, membershipTemplate);
        testMembership.scope = "m.user";
        const mockRoom = makeMockRoom([testMembership]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        expect(sess.memberships).toHaveLength(0);
    });

    describe("getOldestMembership", () => {
        it("returns the oldest membership event", () => {
            const mockRoom = makeMockRoom([
                Object.assign({}, membershipTemplate, { device_id: "foo", created_ts: 3000 }),
                Object.assign({}, membershipTemplate, { device_id: "old", created_ts: 1000 }),
                Object.assign({}, membershipTemplate, { device_id: "bar", created_ts: 2000 }),
            ]);

            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            expect(sess.getOldestMembership()!.deviceId).toEqual("old");
        });
    });

    describe("joining", () => {
        let mockRoom: Room;
        let sendStateEventMock: jest.Mock;
        let sendEventMock: jest.Mock;

        beforeEach(() => {
            sendStateEventMock = jest.fn();
            sendEventMock = jest.fn();
            client.sendStateEvent = sendStateEventMock;
            client.sendEvent = sendEventMock;

            mockRoom = makeMockRoom([]);
            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        });

        afterEach(() => {
            // stop the timers
            sess!.leaveRoomSession();
        });

        it("starts un-joined", () => {
            expect(sess!.isJoined()).toEqual(false);
        });

        it("shows joined once join is called", () => {
            sess!.joinRoomSession([mockFocus]);
            expect(sess!.isJoined()).toEqual(true);
        });

        it("sends a membership event when joining a call", () => {
            sess!.joinRoomSession([mockFocus]);

            expect(client.sendStateEvent).toHaveBeenCalledWith(
                mockRoom!.roomId,
                EventType.GroupCallMemberPrefix,
                {
                    memberships: [
                        {
                            application: "m.call",
                            scope: "m.room",
                            call_id: "",
                            device_id: "AAAAAAA",
                            expires: 3600000,
                            foci_active: [{ type: "mock" }],
                            membershipID: expect.stringMatching(".*"),
                        },
                    ],
                },
                "@alice:example.org",
            );
        });

        it("does nothing if join called when already joined", () => {
            sess!.joinRoomSession([mockFocus]);

            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);

            sess!.joinRoomSession([mockFocus]);
            expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
        });

        it("renews membership event before expiry time", async () => {
            jest.useFakeTimers();
            let resolveFn: ((_roomId: string, _type: string, val: Record<string, any>) => void) | undefined;

            const eventSentPromise = new Promise<Record<string, any>>((r) => {
                resolveFn = (_roomId: string, _type: string, val: Record<string, any>) => {
                    r(val);
                };
            });
            try {
                const sendStateEventMock = jest.fn().mockImplementation(resolveFn);
                client.sendStateEvent = sendStateEventMock;

                sess!.joinRoomSession([mockFocus]);

                const eventContent = await eventSentPromise;

                // definitely should have renewed by 1 second before the expiry!
                const timeElapsed = 60 * 60 * 1000 - 1000;
                mockRoom.getLiveTimeline().getState(EventTimeline.FORWARDS)!.getStateEvents = jest
                    .fn()
                    .mockReturnValue(mockRTCEvent(eventContent.memberships, mockRoom.roomId, timeElapsed));

                const eventReSentPromise = new Promise<Record<string, any>>((r) => {
                    resolveFn = (_roomId: string, _type: string, val: Record<string, any>) => {
                        r(val);
                    };
                });

                sendStateEventMock.mockReset().mockImplementation(resolveFn);

                jest.setSystemTime(Date.now() + timeElapsed);
                jest.advanceTimersByTime(timeElapsed);
                await eventReSentPromise;

                expect(sendStateEventMock).toHaveBeenCalledWith(
                    mockRoom.roomId,
                    EventType.GroupCallMemberPrefix,
                    {
                        memberships: [
                            {
                                application: "m.call",
                                scope: "m.room",
                                call_id: "",
                                device_id: "AAAAAAA",
                                expires: 3600000 * 2,
                                foci_active: [{ type: "mock" }],
                                created_ts: 1000,
                                membershipID: expect.stringMatching(".*"),
                            },
                        ],
                    },
                    "@alice:example.org",
                );
            } finally {
                jest.useRealTimers();
            }
        });

        it("creates a key when joining", () => {
            sess!.joinRoomSession([mockFocus], true);
            const keys = sess?.getKeysForParticipant("@alice:example.org", "AAAAAAA");
            expect(keys).toHaveLength(1);

            const allKeys = sess!.getEncryptionKeys();
            expect(allKeys).toBeTruthy();
            expect(Array.from(allKeys)).toHaveLength(1);
        });

        it("sends keys when joining", async () => {
            const eventSentPromise = new Promise((resolve) => {
                sendEventMock.mockImplementation(resolve);
            });

            sess!.joinRoomSession([mockFocus], true);

            await eventSentPromise;

            expect(sendEventMock).toHaveBeenCalledWith(expect.stringMatching(".*"), "io.element.call.encryption_keys", {
                call_id: "",
                device_id: "AAAAAAA",
                keys: [
                    {
                        index: 0,
                        key: expect.stringMatching(".*"),
                    },
                ],
            });
        });

        it("retries key sends", async () => {
            jest.useFakeTimers();
            let firstEventSent = false;

            try {
                const eventSentPromise = new Promise<void>((resolve) => {
                    sendEventMock.mockImplementation(() => {
                        if (!firstEventSent) {
                            jest.advanceTimersByTime(10000);

                            firstEventSent = true;
                            const e = new Error() as MatrixError;
                            e.data = {};
                            throw e;
                        } else {
                            resolve();
                        }
                    });
                });

                sess!.joinRoomSession([mockFocus], true);
                jest.advanceTimersByTime(10000);

                await eventSentPromise;

                expect(sendEventMock).toHaveBeenCalledTimes(2);
            } finally {
                jest.useRealTimers();
            }
        });

        it("cancels key send event that fail", async () => {
            const eventSentinel = {} as unknown as MatrixEvent;

            client.cancelPendingEvent = jest.fn();
            sendEventMock.mockImplementation(() => {
                const e = new Error() as MatrixError;
                e.data = {};
                e.event = eventSentinel;
                throw e;
            });

            sess!.joinRoomSession([mockFocus], true);

            expect(client.cancelPendingEvent).toHaveBeenCalledWith(eventSentinel);
        });

        it("Re-sends key if a new member joins", async () => {
            jest.useFakeTimers();
            try {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

                const keysSentPromise1 = new Promise((resolve) => {
                    sendEventMock.mockImplementation(resolve);
                });

                sess.joinRoomSession([mockFocus], true);
                await keysSentPromise1;

                sendEventMock.mockClear();
                jest.advanceTimersByTime(10000);

                const keysSentPromise2 = new Promise((resolve) => {
                    sendEventMock.mockImplementation(resolve);
                });

                const onMembershipsChanged = jest.fn();
                sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

                const member2 = Object.assign({}, membershipTemplate, {
                    device_id: "BBBBBBB",
                });

                mockRoom.getLiveTimeline().getState = jest
                    .fn()
                    .mockReturnValue(makeMockRoomState([membershipTemplate, member2], mockRoom.roomId, undefined));
                sess.onMembershipUpdate();

                await keysSentPromise2;

                expect(sendEventMock).toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it("Rotates key if a member leaves", async () => {
            jest.useFakeTimers();
            try {
                const member2 = Object.assign({}, membershipTemplate, {
                    device_id: "BBBBBBB",
                });
                const mockRoom = makeMockRoom([membershipTemplate, member2]);
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

                const onMyEncryptionKeyChanged = jest.fn();
                sess.on(
                    MatrixRTCSessionEvent.EncryptionKeyChanged,
                    (_key: Uint8Array, _idx: number, participantId: string) => {
                        if (participantId === `${client.getUserId()}:${client.getDeviceId()}`) {
                            onMyEncryptionKeyChanged();
                        }
                    },
                );

                const keysSentPromise1 = new Promise<EncryptionKeysEventContent>((resolve) => {
                    sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                });

                sess.joinRoomSession([mockFocus], true);
                const firstKeysPayload = await keysSentPromise1;
                expect(firstKeysPayload.keys).toHaveLength(1);

                sendEventMock.mockClear();

                const keysSentPromise2 = new Promise<EncryptionKeysEventContent>((resolve) => {
                    sendEventMock.mockImplementation((_roomId, _evType, payload) => resolve(payload));
                });

                mockRoom.getLiveTimeline().getState = jest
                    .fn()
                    .mockReturnValue(makeMockRoomState([membershipTemplate], mockRoom.roomId, undefined));
                sess.onMembershipUpdate();

                jest.advanceTimersByTime(10000);

                const secondKeysPayload = await keysSentPromise2;

                expect(secondKeysPayload.keys).toHaveLength(2);
                expect(onMyEncryptionKeyChanged).toHaveBeenCalledTimes(2);
            } finally {
                jest.useRealTimers();
            }
        });

        it("Doesn't re-send key immediately", async () => {
            const realSetImmediate = setImmediate;
            jest.useFakeTimers();
            try {
                const mockRoom = makeMockRoom([membershipTemplate]);
                sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

                const keysSentPromise1 = new Promise((resolve) => {
                    sendEventMock.mockImplementation(resolve);
                });

                sess.joinRoomSession([mockFocus], true);
                await keysSentPromise1;

                sendEventMock.mockClear();

                const onMembershipsChanged = jest.fn();
                sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

                const member2 = Object.assign({}, membershipTemplate, {
                    device_id: "BBBBBBB",
                });

                mockRoom.getLiveTimeline().getState = jest
                    .fn()
                    .mockReturnValue(makeMockRoomState([membershipTemplate, member2], mockRoom.roomId, undefined));
                sess.onMembershipUpdate();

                await new Promise((resolve) => {
                    realSetImmediate(resolve);
                });

                expect(sendEventMock).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it("Does not emits if no membership changes", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

        const onMembershipsChanged = jest.fn();
        sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
        sess.onMembershipUpdate();

        expect(onMembershipsChanged).not.toHaveBeenCalled();
    });

    it("Emits on membership changes", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

        const onMembershipsChanged = jest.fn();
        sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

        mockRoom.getLiveTimeline().getState = jest
            .fn()
            .mockReturnValue(makeMockRoomState([], mockRoom.roomId, undefined));
        sess.onMembershipUpdate();

        expect(onMembershipsChanged).toHaveBeenCalled();
    });

    it("emits an event at the time a membership event expires", () => {
        jest.useFakeTimers();
        try {
            const membership = Object.assign({}, membershipTemplate);
            const mockRoom = makeMockRoom([membership], 0);

            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
            const membershipObject = sess.memberships[0];

            const onMembershipsChanged = jest.fn();
            sess.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);

            jest.advanceTimersByTime(61 * 1000 * 1000);

            expect(onMembershipsChanged).toHaveBeenCalledWith([membershipObject], []);
            expect(sess?.memberships.length).toEqual(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it("prunes expired memberships on update", () => {
        jest.useFakeTimers();
        try {
            client.sendStateEvent = jest.fn();

            const mockMemberships = [
                Object.assign({}, membershipTemplate, {
                    device_id: "OTHERDEVICE",
                    expires: 1000,
                }),
            ];
            const mockRoomNoExpired = makeMockRoom(mockMemberships, 0);

            sess = MatrixRTCSession.roomSessionForRoom(client, mockRoomNoExpired);

            // sanity check
            expect(sess.memberships).toHaveLength(1);
            expect(sess.memberships[0].deviceId).toEqual("OTHERDEVICE");

            jest.advanceTimersByTime(10000);

            sess.joinRoomSession([mockFocus]);

            expect(client.sendStateEvent).toHaveBeenCalledWith(
                mockRoomNoExpired!.roomId,
                EventType.GroupCallMemberPrefix,
                {
                    memberships: [
                        {
                            application: "m.call",
                            scope: "m.room",
                            call_id: "",
                            device_id: "AAAAAAA",
                            expires: 3600000,
                            foci_active: [mockFocus],
                            membershipID: expect.stringMatching(".*"),
                        },
                    ],
                },
                "@alice:example.org",
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it("fills in created_ts for other memberships on update", () => {
        client.sendStateEvent = jest.fn();

        const mockRoom = makeMockRoom([
            Object.assign({}, membershipTemplate, {
                device_id: "OTHERDEVICE",
            }),
        ]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);

        sess.joinRoomSession([mockFocus]);

        expect(client.sendStateEvent).toHaveBeenCalledWith(
            mockRoom!.roomId,
            EventType.GroupCallMemberPrefix,
            {
                memberships: [
                    {
                        application: "m.call",
                        scope: "m.room",
                        call_id: "",
                        device_id: "OTHERDEVICE",
                        expires: 3600000,
                        created_ts: 1000,
                        membershipID: expect.stringMatching(".*"),
                    },
                    {
                        application: "m.call",
                        scope: "m.room",
                        call_id: "",
                        device_id: "AAAAAAA",
                        expires: 3600000,
                        foci_active: [mockFocus],
                        membershipID: expect.stringMatching(".*"),
                    },
                ],
            },
            "@alice:example.org",
        );
    });

    it("collects keys from encryption events", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        sess.onCallEncryption({
            getType: jest.fn().mockReturnValue("io.element.call.encryption_keys"),
            getContent: jest.fn().mockReturnValue({
                device_id: "bobsphone",
                call_id: "",
                keys: [
                    {
                        index: 0,
                        key: "dGhpcyBpcyB0aGUga2V5",
                    },
                ],
            }),
            getSender: jest.fn().mockReturnValue("@bob:example.org"),
        } as unknown as MatrixEvent);

        const bobKeys = sess.getKeysForParticipant("@bob:example.org", "bobsphone")!;
        expect(bobKeys).toHaveLength(1);
        expect(bobKeys[0]).toEqual(Buffer.from("this is the key", "utf-8"));
    });

    it("collects keys at non-zero indices", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        sess.onCallEncryption({
            getType: jest.fn().mockReturnValue("io.element.call.encryption_keys"),
            getContent: jest.fn().mockReturnValue({
                device_id: "bobsphone",
                call_id: "",
                keys: [
                    {
                        index: 4,
                        key: "dGhpcyBpcyB0aGUga2V5",
                    },
                ],
            }),
            getSender: jest.fn().mockReturnValue("@bob:example.org"),
        } as unknown as MatrixEvent);

        const bobKeys = sess.getKeysForParticipant("@bob:example.org", "bobsphone")!;
        expect(bobKeys).toHaveLength(5);
        expect(bobKeys[0]).toBeFalsy();
        expect(bobKeys[1]).toBeFalsy();
        expect(bobKeys[2]).toBeFalsy();
        expect(bobKeys[3]).toBeFalsy();
        expect(bobKeys[4]).toEqual(Buffer.from("this is the key", "utf-8"));
    });

    it("ignores keys event for the local participant", () => {
        const mockRoom = makeMockRoom([membershipTemplate]);
        sess = MatrixRTCSession.roomSessionForRoom(client, mockRoom);
        sess.onCallEncryption({
            getType: jest.fn().mockReturnValue("io.element.call.encryption_keys"),
            getContent: jest.fn().mockReturnValue({
                device_id: client.getDeviceId(),
                call_id: "",
                keys: [
                    {
                        index: 4,
                        key: "dGhpcyBpcyB0aGUga2V5",
                    },
                ],
            }),
            getSender: jest.fn().mockReturnValue(client.getUserId()),
        } as unknown as MatrixEvent);

        const myKeys = sess.getKeysForParticipant(client.getUserId()!, client.getDeviceId()!)!;
        expect(myKeys).toBeFalsy();
    });
});
