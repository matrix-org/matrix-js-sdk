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

import 'fake-indexeddb/auto';
import 'jest-localstorage-mock';

import { IndexedDBStore, IStateEventWithRoomId, MemoryStore } from "../../../src";
import { emitPromise } from "../../test-utils/test-utils";
import { LocalIndexedDBStoreBackend } from "../../../src/store/indexeddb-local-backend";

describe("IndexedDBStore", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    const roomId = "!room:id";
    it("should degrade to MemoryStore on IDB errors", async () => {
        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
        });
        await store.startup();

        const member1: IStateEventWithRoomId = {
            room_id: roomId,
            event_id: "!ev1:id",
            sender: "@user1:id",
            state_key: "@user1:id",
            type: "m.room.member",
            origin_server_ts: 123,
            content: {},
        };
        const member2: IStateEventWithRoomId = {
            room_id: roomId,
            event_id: "!ev2:id",
            sender: "@user2:id",
            state_key: "@user2:id",
            type: "m.room.member",
            origin_server_ts: 123,
            content: {},
        };

        expect(await store.getOutOfBandMembers(roomId)).toBe(null);
        await store.setOutOfBandMembers(roomId, [member1]);
        expect(await store.getOutOfBandMembers(roomId)).toHaveLength(1);

        // Simulate a broken IDB
        (store.backend as LocalIndexedDBStoreBackend)["db"].transaction = (): IDBTransaction => {
            const err = new Error("Failed to execute 'transaction' on 'IDBDatabase': " +
                "The database connection is closing.");
            err.name = "InvalidStateError";
            throw err;
        };

        expect(await store.getOutOfBandMembers(roomId)).toHaveLength(1);
        await Promise.all([
            emitPromise(store["emitter"], "degraded"),
            store.setOutOfBandMembers(roomId, [member1, member2]),
        ]);
        expect(await store.getOutOfBandMembers(roomId)).toHaveLength(2);
    });

    it("should use MemoryStore methods for pending events if no localStorage", async () => {
        jest.spyOn(MemoryStore.prototype, "setPendingEvents");
        jest.spyOn(MemoryStore.prototype, "getPendingEvents");

        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage: undefined,
        });

        const events = [{ type: "test" }];
        await store.setPendingEvents(roomId, events);
        expect(MemoryStore.prototype.setPendingEvents).toHaveBeenCalledWith(roomId, events);
        await expect(store.getPendingEvents(roomId)).resolves.toEqual(events);
        expect(MemoryStore.prototype.getPendingEvents).toHaveBeenCalledWith(roomId);
    });

    it("should persist pending events to localStorage if available", async () => {
        jest.spyOn(MemoryStore.prototype, "setPendingEvents");
        jest.spyOn(MemoryStore.prototype, "getPendingEvents");

        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
        });

        await expect(store.getPendingEvents(roomId)).resolves.toEqual([]);
        const events = [{ type: "test" }];
        await store.setPendingEvents(roomId, events);
        expect(MemoryStore.prototype.setPendingEvents).not.toHaveBeenCalled();
        await expect(store.getPendingEvents(roomId)).resolves.toEqual(events);
        expect(MemoryStore.prototype.getPendingEvents).not.toHaveBeenCalled();
        expect(localStorage.getItem("mx_pending_events_" + roomId)).toBe(JSON.stringify(events));
        await store.setPendingEvents(roomId, []);
        expect(localStorage.getItem("mx_pending_events_" + roomId)).toBeNull();
    });
});
