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

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
    ClientEvent,
    ClientStoppedError,
    EventTimeline,
    EventType,
    MatrixClient,
    Room,
    RoomType,
    TimeoutError,
} from "../../src";
import { SyncState } from "../../src/sync";
import { MemoryStore } from "../../src/store/memory";
import { KnownMembership, type Membership } from "../../src/@types/membership";
import { type CryptoBackend } from "../../src/common-crypto/CryptoBackend";
import { mkEvent } from "../test-utils/test-utils";

describe("MatrixClient.hasEncryptedRooms", () => {
    const userId = "@alice:example.org";
    let client: MatrixClient;
    let store: MemoryStore;
    let roomIndex = 0;

    beforeEach(() => {
        vi.useFakeTimers();
        store = new MemoryStore();
        client = new MatrixClient({
            baseUrl: "https://my.home.server",
            accessToken: "my.access.token",
            fetchFn: (() => {}) as any, // NOP
            store,
            userId,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /**
     * Pretend that the initial sync has completed (or not).
     * @param state - The sync state to mock.
     */
    function mockSyncState(state: SyncState | null): void {
        vi.spyOn(client, "getSyncState").mockReturnValue(state);
    }

    /**
     * Install a mock crypto backend which considers exactly the given rooms encrypted.
     * @returns the `isEncryptionEnabledInRoom` mock, for call assertions.
     */
    function mockEncryptedRooms(...encryptedRooms: Room[]): Mock {
        const isEncryptionEnabledInRoom = vi
            .fn()
            .mockImplementation(async (roomId: string) => encryptedRooms.some((room) => room.roomId === roomId));
        client["cryptoBackend"] = { isEncryptionEnabledInRoom } as unknown as CryptoBackend;
        return isEncryptionEnabledInRoom;
    }

    /**
     * Build a `Room`, apply the requested state, and store it in the client's store.
     */
    function mkRoom({
        withEncryptionStateEvent = false,
        membership = KnownMembership.Join,
        space = false,
    }: {
        withEncryptionStateEvent?: boolean;
        membership?: Membership;
        space?: boolean;
    } = {}): Room {
        const roomId = `!room${roomIndex++}:example.org`;
        const room = new Room(roomId, client, userId);
        room.updateMyMembership(membership);

        const stateEvents = [
            mkEvent({
                type: EventType.RoomCreate,
                room: roomId,
                user: userId,
                content: { creator: userId, ...(space ? { type: RoomType.Space } : {}) },
                event: true,
            }),
        ];
        if (withEncryptionStateEvent) {
            stateEvents.push(
                mkEvent({
                    type: EventType.RoomEncryption,
                    room: roomId,
                    user: userId,
                    skey: "",
                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                    event: true,
                }),
            );
        }
        room.getLiveTimeline().getState(EventTimeline.FORWARDS)!.setStateEvents(stateEvents);

        store.storeRoom(room);
        return room;
    }

    describe("when the initial sync has completed", () => {
        beforeEach(() => {
            mockSyncState(SyncState.Syncing);
        });

        it("returns true when the crypto backend considers a joined room encrypted", async () => {
            mkRoom();
            const room = mkRoom();
            const isEncryptionEnabledInRoom = mockEncryptedRooms(room);

            await expect(client.hasEncryptedRooms(1000)).resolves.toBe(true);
            expect(isEncryptionEnabledInRoom).toHaveBeenCalledWith(room.roomId);
        });

        it("does not count a room as encrypted merely because it has an m.room.encryption state event", async () => {
            // The state event may be malformed or use an unsupported algorithm, so we trust
            // the crypto backend rather than just conditioning on the presence of the event.
            const room = mkRoom({ withEncryptionStateEvent: true });
            const isEncryptionEnabledInRoom = mockEncryptedRooms();

            await expect(client.hasEncryptedRooms(1000)).resolves.toBe(false);
            expect(isEncryptionEnabledInRoom).toHaveBeenCalledWith(room.roomId);
        });

        it("returns false when crypto is not initialized", async () => {
            mkRoom({ withEncryptionStateEvent: true });
            await expect(client.hasEncryptedRooms(1000)).resolves.toBe(false);
        });

        it("only considers joined, non-space rooms", async () => {
            const room1 = mkRoom();
            const room2 = mkRoom();
            const space = mkRoom({ space: true });
            const invited = mkRoom({ membership: KnownMembership.Invite });
            const left = mkRoom({ membership: KnownMembership.Leave });
            const knocked = mkRoom({ membership: KnownMembership.Knock });
            // Even though the backend would report the filtered-out rooms as encrypted, they must
            // neither be consulted nor counted.
            const isEncryptionEnabledInRoom = mockEncryptedRooms(space, invited, left, knocked);

            await expect(client.hasEncryptedRooms(1000)).resolves.toBe(false);
            expect(isEncryptionEnabledInRoom.mock.calls).toEqual([[room1.roomId], [room2.roomId]]);
        });
    });

    describe("when the initial sync has not completed", () => {
        beforeEach(() => {
            mockSyncState(null);
        });

        // Syncing matters in its own right: RoomWidgetClient never emits Prepared.
        it.each([SyncState.Prepared, SyncState.Syncing])(
            "waits for the initial sync and is resolved by the %s state",
            async (state) => {
                mockEncryptedRooms(mkRoom());

                const promise = client.hasEncryptedRooms(1000);
                client.emit(ClientEvent.Sync, state, null);
                await expect(promise).resolves.toBe(true);
            },
        );

        it("rejects with ClientStoppedError when the client is stopped while waiting", async () => {
            const promise = client.hasEncryptedRooms(1000);
            client.emit(ClientEvent.Sync, SyncState.Stopped, null);
            await expect(promise).rejects.toBeInstanceOf(ClientStoppedError);
        });

        it("keeps waiting through sync errors", async () => {
            mockEncryptedRooms(mkRoom());

            const promise = client.hasEncryptedRooms(1000);
            client.emit(ClientEvent.Sync, SyncState.Error, null);
            client.emit(ClientEvent.Sync, SyncState.Prepared, null);
            await expect(promise).resolves.toBe(true);
        });

        it("rejects with TimeoutError if the initial sync does not complete in time", async () => {
            mockEncryptedRooms(mkRoom());
            const baselineListeners = client.listenerCount(ClientEvent.Sync);

            const promise = client.hasEncryptedRooms(1000);
            await Promise.all([
                expect(promise).rejects.toBeInstanceOf(TimeoutError),
                vi.advanceTimersByTimeAsync(1000),
            ]);
            expect(client.listenerCount(ClientEvent.Sync)).toBe(baselineListeners);
        });

        it("cleans up its sync listener and timer once the sync has completed", async () => {
            const baselineListeners = client.listenerCount(ClientEvent.Sync);

            const promise = client.hasEncryptedRooms(1000);
            client.emit(ClientEvent.Sync, SyncState.Prepared, null);
            await expect(promise).resolves.toBe(false);

            expect(client.listenerCount(ClientEvent.Sync)).toBe(baselineListeners);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
