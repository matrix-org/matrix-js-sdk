/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { type Mocked } from "vitest";

import {
    ConnectionError,
    createClient,
    EventStatus,
    type MatrixClient,
    type MatrixEvent,
    MsgType,
    PendingEventOrdering,
    Room,
} from "../../src/matrix";
import { type CryptoBackend } from "../../src/common-crypto/CryptoBackend";
import { flushPromises } from "../test-utils/flushPromises";

const userId = "@me:server";
const roomId = "!room:server";
const otherRoomId = "!other:server";

/**
 * Tests that events are sent in the order they were queued, even when encrypting or sending them fails.
 *
 * @see https://github.com/element-hq/element-web/issues/31451
 */
describe("MatrixClient event send ordering", () => {
    let client: MatrixClient;
    let room: Room;
    let mockCrypto: Mocked<CryptoBackend>;

    /** The bodies of the events, in the order the "server" accepted them. */
    let sentBodies: string[];
    /** Overrides for the response to `/send` for an event, keyed by the event's body. */
    let sendResponses: Record<string, () => Promise<Response>>;
    /** Overrides for encrypting an event, keyed by the event's body. */
    let encryptOverrides: Record<string, () => Promise<void>>;

    const bodyOf = (event: MatrixEvent): string => event.getContent().body;

    function makeRoom(id: string): Room {
        const newRoom = new Room(id, client, userId, { pendingEventOrdering: PendingEventOrdering.Detached });
        newRoom.hasEncryptionStateEvent = () => true;
        client.store.storeRoom(newRoom);
        return newRoom;
    }

    function send(body: string, toRoomId = roomId): Promise<unknown> {
        return client.sendMessage(toRoomId, { msgtype: MsgType.Text, body }).catch(() => {
            // failures are checked via the event status
        });
    }

    /** Resend all unsent events in the room, as element-web's "Resend all" does. */
    function resendAll(): Promise<unknown> {
        return Promise.all(
            room
                .getPendingEvents()
                .filter((ev) => ev.status === EventStatus.NOT_SENT)
                .map((ev) => client.resendEvent(ev, room)),
        );
    }

    async function flush(): Promise<void> {
        for (let i = 0; i < 5; i++) await flushPromises();
    }

    beforeEach(() => {
        vi.useFakeTimers();
        sentBodies = [];
        sendResponses = {};
        encryptOverrides = {};

        const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
            if (!url.toString().includes("/send/")) return new Response("{}", { status: 200 });

            const content = JSON.parse(init!.body as string);
            const body: string = content.ciphertext ?? content.body;
            if (sendResponses[body]) return sendResponses[body]();
            sentBodies.push(body);
            return new Response(JSON.stringify({ event_id: `$${body}` }), { status: 200 });
        });

        client = createClient({
            baseUrl: "https://server",
            userId,
            accessToken: "token",
            deviceId: "DEVICE",
            fetchFn: fetchFn as typeof fetch,
        });
        room = makeRoom(roomId);

        mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
            encryptEvent: vi.fn(async (event: MatrixEvent) => {
                await encryptOverrides[bodyOf(event)]?.();
                // A fake encryption, which keeps the body visible to the fake server
                event.makeEncrypted("m.room.encrypted", { ciphertext: bodyOf(event) }, "curve25519", "ed25519");
            }),
            stop: vi.fn(),
        } as unknown as Mocked<CryptoBackend>;
        client["cryptoBackend"] = mockCrypto;
    });

    afterEach(() => {
        client.stopClient();
        vi.useRealTimers();
    });

    it("only encrypts an event once the events queued before it have been sent", async () => {
        const sendA = Promise.withResolvers<Response>();
        sendResponses["A"] = () => sendA.promise;

        void send("A");
        void send("B");
        await flush();

        expect(mockCrypto.encryptEvent.mock.calls.map(([ev]) => bodyOf(ev))).toEqual(["A"]);
        expect(room.getPendingEvents()[1].status).toBe(EventStatus.QUEUED);

        delete sendResponses["A"];
        sendA.resolve(new Response(JSON.stringify({ event_id: "$A" }), { status: 200 }));
        await flush();

        expect(mockCrypto.encryptEvent.mock.calls.map(([ev]) => bodyOf(ev))).toEqual(["A", "B"]);
        expect(sentBodies).toEqual(["B"]);
    });

    it("sends events in order when sending an earlier event hits a connection error", async () => {
        sendResponses["A"] = () => {
            delete sendResponses["A"];
            return Promise.reject(new TypeError("Failed to fetch"));
        };

        void send("A");
        void send("B");
        void send("C");
        await flush();
        expect(sentBodies).toEqual([]);

        // the scheduler retries after a backoff, rather than giving up and letting later events overtake
        await vi.advanceTimersByTimeAsync(2000);
        await flush();
        expect(sentBodies).toEqual(["A", "B", "C"]);
    });

    it("sends events in order when encrypting an earlier event hits a connection error", async () => {
        encryptOverrides["A"] = async () => {
            delete encryptOverrides["A"];
            throw new ConnectionError("failed to share room key");
        };

        void send("A");
        void send("B");
        await flush();
        expect(sentBodies).toEqual([]);

        await vi.advanceTimersByTimeAsync(2000);
        await flush();
        expect(sentBodies).toEqual(["A", "B"]);
    });

    it("fails the events queued behind an event which cannot be encrypted, and resends them in order", async () => {
        encryptOverrides["A"] = async () => {
            throw new Error("unverified devices");
        };

        void send("A");
        void send("B");
        await flush();

        // errors which did not come from the network are not retried
        expect(room.getPendingEvents().map((ev) => ev.status)).toEqual([EventStatus.NOT_SENT, EventStatus.NOT_SENT]);
        expect(sentBodies).toEqual([]);

        delete encryptOverrides["A"];
        await resendAll();
        expect(sentBodies).toEqual(["A", "B"]);
    });

    it("fails the queued events once retries are exhausted, and resends them in order", async () => {
        sendResponses["A"] = () => Promise.reject(new TypeError("Failed to fetch"));

        void send("A");
        void send("B");
        await flush();
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(16000);
            await flush();
        }

        expect(room.getPendingEvents().map((ev) => ev.status)).toEqual([EventStatus.NOT_SENT, EventStatus.NOT_SENT]);
        expect(sentBodies).toEqual([]);
        // B was never encrypted, but A was, so on resend A goes straight to the server whilst B is encrypted
        expect(mockCrypto.encryptEvent.mock.calls.map(([ev]) => bodyOf(ev))).toEqual(["A"]);

        delete sendResponses["A"];
        await resendAll();
        expect(sentBodies).toEqual(["A", "B"]);
    });

    it("can cancel an event whilst it is waiting to be retried", async () => {
        encryptOverrides["A"] = async () => {
            throw new ConnectionError("failed to share room key");
        };

        void send("A");
        void send("B");
        await flush();

        const [eventA] = room.getPendingEvents();
        client.cancelPendingEvent(eventA);
        expect(eventA.status).toBe(EventStatus.CANCELLED);

        await vi.advanceTimersByTimeAsync(2000);
        await flush();
        expect(sentBodies).toEqual(["B"]);
    });

    it("resolves the send promise of a queued event when it is cancelled", async () => {
        const sendA = Promise.withResolvers<Response>();
        sendResponses["A"] = () => sendA.promise;

        void send("A");
        let bSettled = false;
        void send("B").then(() => (bSettled = true));
        await flush();

        const [, eventB] = room.getPendingEvents();
        expect(eventB.status).toBe(EventStatus.QUEUED);
        client.cancelPendingEvent(eventB);
        await flush();
        expect(bSettled).toBe(true);

        void send("C");
        delete sendResponses["A"];
        sendA.resolve(new Response(JSON.stringify({ event_id: "$A" }), { status: 200 }));
        await flush();
        expect(sentBodies).toEqual(["C"]);
        expect(client["queuedEventCancellers"].size).toBe(0);
    });

    it("can cancel an event whilst it is being encrypted at the head of the queue", async () => {
        const encryptA = Promise.withResolvers<void>();
        encryptOverrides["A"] = () => encryptA.promise;

        let aSettled = false;
        void send("A").then(() => (aSettled = true));
        void send("B");
        await flush();

        const [eventA] = room.getPendingEvents();
        expect(eventA.status).toBe(EventStatus.ENCRYPTING);
        client.cancelPendingEvent(eventA);
        await flush();
        expect(aSettled).toBe(true);

        // the cancelled event failing to encrypt must not cause the events behind it to fail
        encryptA.reject(new Error("unverified devices"));
        await flush();
        expect(sentBodies).toEqual(["B"]);
        // B stays pending until its remote echo arrives
        expect(room.getPendingEvents().map((ev) => [bodyOf(ev), ev.status])).toEqual([["B", EventStatus.SENT]]);
    });

    it("does not hold up events in other rooms", async () => {
        makeRoom(otherRoomId);
        encryptOverrides["A"] = () => new Promise(() => {}); // never finishes encrypting

        void send("A");
        void send("B", otherRoomId);
        await flush();

        expect(sentBodies).toEqual(["B"]);
    });
});
