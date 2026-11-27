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

/**
 * @vitest-environment happy-dom
 */

import "fake-indexeddb/auto";
import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";

import { IndexedDBStore, type IStateEventWithRoomId, MatrixEvent, MemoryStore, User, UserEvent } from "../../../src";
import type { ISyncResponse } from "../../../src/sync-accumulator";
import { emitPromise } from "../../test-utils/test-utils";
import { LocalIndexedDBStoreBackend } from "../../../src/store/indexeddb-local-backend";
import { RemoteIndexedDBStoreBackend } from "../../../src/store/indexeddb-remote-backend";
import { IndexedDBStoreWorker } from "../../../src/store/indexeddb-store-worker";

describe("IndexedDBStore", () => {
    afterEach(() => {
        vi.clearAllMocks();
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

        // Simulate a broken IDB (non-recoverable error)
        (store.backend as LocalIndexedDBStoreBackend)["db"]!.transaction = (): IDBTransaction => {
            throw new TypeError("Failed to execute 'transaction' on 'IDBDatabase'");
        };

        expect(await store.getOutOfBandMembers(roomId)).toHaveLength(1);
        await Promise.all([
            emitPromise(store["emitter"], "degraded"),
            store.setOutOfBandMembers(roomId, [member1, member2]),
        ]);
        expect(await store.getOutOfBandMembers(roomId)).toHaveLength(2);
    });

    it("should degrade to local IDB backend if remote worker fails to start", async () => {
        const store = new IndexedDBStore({
            workerFactory: () => {
                const w = {
                    postMessage: vi.fn(),
                } as unknown as Worker;
                setTimeout(() => {
                    w.onerror!({ error: "IndexedDB worker failed to connect" } as ErrorEvent);
                }, 100);
                return w;
            },
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
        });

        expect(store.backend).toBeInstanceOf(RemoteIndexedDBStoreBackend);
        await store.startup();
        expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
    });

    it("should handle failed queries", async () => {
        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
        });
        await store.startup();

        // Simulate a failed query
        let txn: IDBRequest;
        (store.backend as LocalIndexedDBStoreBackend)["db"]!.transaction = (): IDBTransaction => {
            return {
                objectStore: (name: string) =>
                    ({
                        name,
                        openCursor: (query: unknown) => {
                            return (txn = {
                                error: new DOMException("Expected error"),
                            } as IDBRequest);
                        },
                    }) as IDBObjectStore,
            } as IDBTransaction;
        };

        // Call backend directly as otherwise the error is masked.
        const promise = store.backend.getClientOptions();
        // The function uses a Promise.then(() => trick to delay execution
        // so we need to wait before we can call the txn onerror handler.
        process.nextTick(() => {
            txn!.onerror!(new Event("we-ignore-this"));
        });

        await expect(() => promise).rejects.toThrow("selectQuery failed for client_options");
    });

    it("should clear the database and start afresh if the stored data cannot be read", async () => {
        const indexedDB = new IDBFactory();
        const dbName = "unreadable";

        // 1. Create a store with some saved sync data
        const firstStore = new IndexedDBStore({ indexedDB, dbName, localStorage });
        await firstStore.startup();
        await firstStore.setSyncData({ next_batch: "batch1", rooms: {} } as any);
        await firstStore.save(true);
        await firstStore.destroy();

        // 2. Make the saved sync data unreadable, as Chromium does when a large value's blob file is missing
        const loadSyncData = vi
            .spyOn(LocalIndexedDBStoreBackend.prototype as any, "loadSyncData")
            .mockRejectedValueOnce(new Error("selectQuery failed for sync"));
        onTestFinished(() => loadSyncData.mockRestore());

        // 3. Startup should succeed on a fresh database instead of failing every time
        const store = new IndexedDBStore({ indexedDB, dbName, localStorage });
        await store.startup();
        expect(loadSyncData).toHaveBeenCalledTimes(2);
        expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
        expect(await store.getSavedSync()).toBeNull();
        expect(await store.isNewlyCreated()).toBe(true);

        // 4. The fresh database is usable
        await store.setSyncData({ next_batch: "batch2", rooms: {} } as any);
        await store.save(true);
        expect(await store.getSavedSyncToken()).toBe("batch2");
    });

    it("should fail startup if the stored data still cannot be read after clearing", async () => {
        const indexedDB = new IDBFactory();
        const loadSyncData = vi
            .spyOn(LocalIndexedDBStoreBackend.prototype as any, "loadSyncData")
            .mockRejectedValue(new Error("selectQuery failed for sync"));
        onTestFinished(() => loadSyncData.mockRestore());

        const store = new IndexedDBStore({ indexedDB, dbName: "always-unreadable", localStorage });
        await expect(store.startup()).rejects.toThrow("selectQuery failed for sync");
        expect(loadSyncData).toHaveBeenCalledTimes(2);
    });

    it("Should load presence events on startup", async () => {
        // 1. Create idb database
        const indexedDB = new IDBFactory();
        const setupResolvers = Promise.withResolvers<Event>();
        const req = indexedDB.open("matrix-js-sdk:db3", 1);
        let db: IDBDatabase;
        req.onupgradeneeded = () => {
            db = req.result;
            db.createObjectStore("users", { keyPath: ["userId"] });
            db.createObjectStore("accountData", { keyPath: ["type"] });
            db.createObjectStore("sync", { keyPath: ["clobber"] });
        };
        req.onsuccess = setupResolvers.resolve;
        await setupResolvers.promise;

        // 2. Fill in user presence data
        const writeResolvers = Promise.withResolvers<Event>();
        const transaction = db!.transaction(["users"], "readwrite");
        const objectStore = transaction.objectStore("users");
        const request = objectStore.put({
            userId: "@alice:matrix.org",
            event: {
                content: {
                    presence: "online",
                },
                sender: "@alice:matrix.org",
                type: "m.presence",
            },
        });
        request.onsuccess = writeResolvers.resolve;
        await writeResolvers.promise;

        // 3. Close database
        req.result.close();

        // 2. Check if the code loads presence events
        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "db3",
            localStorage,
        });
        let userCreated = false;
        let presenceEventEmitted = false;
        store.setUserCreator((id: string) => {
            userCreated = true;
            const user = new User(id);
            user.on(UserEvent.Presence, () => {
                presenceEventEmitted = true;
            });
            return user;
        });
        await store.startup();
        expect(userCreated).toBe(true);
        expect(presenceEventEmitted).toBe(true);
    });

    it("should use MemoryStore methods for pending events if no localStorage", async () => {
        vi.spyOn(MemoryStore.prototype, "setPendingEvents");
        vi.spyOn(MemoryStore.prototype, "getPendingEvents");

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
        vi.spyOn(MemoryStore.prototype, "setPendingEvents");
        vi.spyOn(MemoryStore.prototype, "getPendingEvents");

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

    it("should resolve isNewlyCreated to true if no database existed initially", async () => {
        const store = new IndexedDBStore({
            indexedDB,
            dbName: "db1",
            localStorage,
        });
        await store.startup();

        await expect(store.isNewlyCreated()).resolves.toBeTruthy();
    });

    it("should resolve isNewlyCreated to false if database existed already", async () => {
        let store = new IndexedDBStore({
            indexedDB,
            dbName: "db2",
            localStorage,
        });
        await store.startup();

        store = new IndexedDBStore({
            indexedDB,
            dbName: "db2",
            localStorage,
        });
        await store.startup();

        await expect(store.isNewlyCreated()).resolves.toBeFalsy();
    });

    it("should resolve isNewlyCreated to false if database existed already but needs upgrade", async () => {
        const requestSuccessResolvers = Promise.withResolvers<Event>();
        // seed db3 to Version 1 so it forces a migration
        const req = indexedDB.open("matrix-js-sdk:db3", 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore("users", { keyPath: ["userId"] });
            db.createObjectStore("accountData", { keyPath: ["type"] });
            db.createObjectStore("sync", { keyPath: ["clobber"] });
        };
        req.onsuccess = requestSuccessResolvers.resolve;
        await requestSuccessResolvers.promise;
        req.result.close();

        const store = new IndexedDBStore({
            indexedDB,
            dbName: "db3",
            localStorage,
        });
        await store.startup();

        await expect(store.isNewlyCreated()).resolves.toBeFalsy();
    });

    it("should emit 'closed' if database is unexpectedly closed", async () => {
        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
        });
        await store.startup();

        const storeClosedResolvers = Promise.withResolvers<void>();
        store.on("closed", storeClosedResolvers.resolve);

        // @ts-ignore - private field access
        (store.backend as LocalIndexedDBStoreBackend).db!.onclose!({} as Event);
        await expect(storeClosedResolvers.promise).resolves.toBeUndefined();
    });

    it("should use remote backend if workerFactory passed", async () => {
        const workerPostMessageResolvers = Promise.withResolvers<void>();
        class MockWorker {
            postMessage(data: any) {
                if (data.command === "setupWorker") {
                    workerPostMessageResolvers.resolve();
                }
            }
        }

        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
            workerFactory: () => new MockWorker() as Worker,
        });
        store.startup();
        await expect(workerPostMessageResolvers.promise).resolves.toBeUndefined();
    });

    it("remote worker should pass closed event", async () => {
        const worker = new (class MockWorker {
            postMessage(data: any) {}
        })() as Worker;

        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
            workerFactory: () => worker,
        });
        store.startup();

        const storeClosedResolvers = Promise.withResolvers<void>();
        store.on("closed", storeClosedResolvers.resolve);
        (worker as any).onmessage({ data: { command: "closed" } });
        await expect(storeClosedResolvers.promise).resolves.toBeUndefined();
    });

    it("remote worker should pass command failures", async () => {
        const worker = new (class MockWorker {
            private onmessage!: (data: any) => void;
            postMessage(data: any) {
                if (data.command === "setupWorker" || data.command === "connect") {
                    this.onmessage({
                        data: {
                            command: "cmd_success",
                            seq: data.seq,
                        },
                    });
                    return;
                }

                this.onmessage({
                    data: {
                        command: "cmd_fail",
                        seq: data.seq,
                        error: new Error("Test"),
                    },
                });
            }
        })() as unknown as Worker;

        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
            workerFactory: () => worker,
        });
        await expect(store.startup()).rejects.toThrow("Test");
    });

    it("remote worker should terminate upon destroy call", async () => {
        const terminate = vi.fn();
        const worker = new (class MockWorker {
            private onmessage!: (data: any) => void;
            postMessage(data: any) {
                this.onmessage({
                    data: {
                        command: "cmd_success",
                        seq: data.seq,
                        result: [],
                    },
                });
            }
            public terminate = terminate;
        })() as unknown as Worker;

        const store = new IndexedDBStore({
            indexedDB: indexedDB,
            dbName: "database",
            localStorage,
            workerFactory: () => worker,
        });
        await store.startup();
        await store.destroy();
        expect(terminate).toHaveBeenCalled();
    });

    describe("aborted and closed-connection saves", () => {
        let idb: IDBFactory;
        const stores: IndexedDBStore[] = [];
        const member: IStateEventWithRoomId = {
            room_id: roomId,
            event_id: "$ev1",
            sender: "@alice:example.org",
            state_key: "@alice:example.org",
            type: "m.room.member",
            origin_server_ts: 123,
            content: {},
        };
        const syncResp = (nextBatch: string): ISyncResponse => ({
            next_batch: nextBatch,
            rooms: { join: {}, invite: {}, leave: {}, knock: {} },
            account_data: { events: [] },
        });
        const forceClose = (db: IDBDatabase) => (forceCloseDatabase as unknown as (d: IDBDatabase) => void)(db);
        const abortOnce = (proto: any, method: string, afterSuccess = false, errorName?: string) => {
            const orig = proto[method];
            vi.spyOn(proto, method).mockImplementationOnce(function (this: any, ...args: any[]) {
                const req: IDBRequest = orig.apply(this, args);
                const txn: IDBTransaction = this.transaction ?? this.objectStore.transaction;
                if (afterSuccess) {
                    req.addEventListener("success", () => {
                        txn.abort();
                        if (errorName) Object.defineProperty(txn, "error", { value: new DOMException("", errorName) });
                    });
                } else {
                    txn.abort();
                }
                return req;
            });
        };

        beforeEach(() => {
            idb = new IDBFactory();
        });
        afterEach(async () => {
            vi.restoreAllMocks();
            await Promise.all(stores.splice(0).map((s) => s.destroy()));
        });

        const startStore = async (dbName = "aborted-save-test", factory: IDBFactory = idb) => {
            const store = new IndexedDBStore({ indexedDB: factory, dbName });
            store.setUserCreator((userId: string) => new User(userId));
            stores.push(store);
            await store.startup();
            return store;
        };
        const savedStore = async () => {
            const store = await startStore();
            await store.setSyncData(syncResp("saved"));
            await store.save(true);
            return store;
        };
        const persistedToken = async () => (await startStore()).getSavedSyncToken();

        it("should keep saved sync and retry presence when a save aborts", async () => {
            const store = await savedStore();
            const degraded = vi.fn();
            store.on("degraded", degraded);

            const user = new User("@bob:example.org");
            user.setPresenceEvent(
                new MatrixEvent({ type: "m.presence", sender: user.userId, content: { presence: "online" } }),
            );
            store.storeUser(user);

            abortOnce(IDBObjectStore.prototype, "put", true, "UnknownError");
            await store.setSyncData(syncResp("aborted"));
            await store.save(true);

            expect(degraded).not.toHaveBeenCalled();
            expect(await persistedToken()).toBe("saved");

            await store.save(true);
            const reader = await startStore();
            expect(await reader.getSavedSyncToken()).toBe("aborted");
            expect(reader.getUser(user.userId)?.events.presence?.getContent()).toEqual({ presence: "online" });
        });

        it("should keep saved sync when reads, client options, or clearOutOfBandMembers abort", async () => {
            const writer = await savedStore();
            await writer.setOutOfBandMembers(roomId, [member]);
            await writer.storeClientOptions({ lazyLoadMembers: true });

            const store = await startStore();
            const degraded = vi.fn();
            store.on("degraded", degraded);

            abortOnce(IDBIndex.prototype, "openCursor");
            expect(await store.getOutOfBandMembers(roomId)).toBeNull();
            abortOnce(IDBObjectStore.prototype, "openCursor");
            expect(await store.getClientOptions()).toBeUndefined();
            abortOnce(IDBObjectStore.prototype, "delete");
            await store.clearOutOfBandMembers(roomId);
            abortOnce(IDBObjectStore.prototype, "put", true);
            await store.storeClientOptions({ lazyLoadMembers: false });

            expect(degraded).not.toHaveBeenCalled();
            expect(await persistedToken()).toBe("saved");
        });

        it("should keep saved sync when getClientOptions aborts in worker mode", async () => {
            const dbName = "worker-abort-test";
            const writer = await startStore(dbName, indexedDB);
            await writer.setSyncData(syncResp("saved"));
            await writer.save(true);
            await writer.storeClientOptions({ lazyLoadMembers: true });

            const mockWorker = {
                onmessage: undefined as ((ev: MessageEvent) => void) | undefined,
                postMessage: (data: unknown) => storeWorker.onMessage({ data } as MessageEvent),
                terminate: vi.fn(),
            };
            const storeWorker = new IndexedDBStoreWorker((data) => {
                queueMicrotask(() => mockWorker.onmessage?.({ data } as MessageEvent));
            });
            const store = new IndexedDBStore({
                indexedDB,
                dbName,
                workerFactory: () => mockWorker as unknown as Worker,
            });
            store.setUserCreator((userId: string) => new User(userId));
            stores.push(store);
            await store.startup();

            const degraded = vi.fn();
            store.on("degraded", degraded);

            abortOnce(IDBObjectStore.prototype, "openCursor");
            expect(await store.getClientOptions()).toBeUndefined();
            expect(degraded).not.toHaveBeenCalled();

            const reader = await startStore(dbName, indexedDB);
            expect(await reader.getSavedSyncToken()).toBe("saved");
            await reader.deleteAllData();
        });

        it("should keep saved sync across closing, close and versionchange, and still degrade on deleteAllData", async () => {
            const writer = await savedStore();
            await writer.setOutOfBandMembers(roomId, [member]);

            const store = await startStore();
            const degraded = vi.fn();
            store.on("degraded", degraded);

            // Pending txn leaves connection closing before the async close event fires.
            const db = (store.backend as LocalIndexedDBStoreBackend)["db"]!;
            const closed = emitPromise(store["emitter"], "closed");
            db.transaction(["sync"], "readonly");
            forceClose(db);

            await store.save(true);
            expect(await store.getOutOfBandMembers(roomId)).toBeNull();
            await closed;

            expect((await store.getSavedSync())?.nextBatch).toBe("saved");
            expect(await store.getSavedSyncToken()).toBe("saved");
            expect(await store.isNewlyCreated()).toBe(false);
            await store.setSyncData(syncResp("after-close"));
            await store.save(true);

            const vStore = await startStore();
            vStore.on("degraded", degraded);
            (vStore.backend as LocalIndexedDBStoreBackend)["db"]!.onversionchange!({} as IDBVersionChangeEvent);
            await vStore.save(true);

            expect(degraded).not.toHaveBeenCalled();
            expect(await persistedToken()).toBe("saved");

            // Explicit deletion still degrades and retries on a recoverable error.
            const clearSpy = vi
                .spyOn(store.backend, "clearDatabase")
                .mockRejectedValueOnce(new DOMException("", "AbortError"));
            await store.deleteAllData();
            expect(degraded).toHaveBeenCalledTimes(1);
            expect(clearSpy).toHaveBeenCalledTimes(2);
            expect(await persistedToken()).toBeUndefined();
        });

        it("should reconnect and persist when startup() is retried after close", async () => {
            await savedStore();
            const store = new IndexedDBStore({ indexedDB: idb, dbName: "aborted-save-test" });
            store.setUserCreator((userId: string) => new User(userId));
            stores.push(store);
            const degraded = vi.fn();
            store.on("degraded", degraded);

            const closed = emitPromise(store["emitter"], "closed");
            const realGetPresence = store.backend.getUserPresenceEvents.bind(store.backend);
            vi.spyOn(store.backend, "getUserPresenceEvents").mockImplementationOnce(() => {
                forceClose((store.backend as LocalIndexedDBStoreBackend)["db"]!);
                return realGetPresence();
            });
            await expect(store.startup()).rejects.toBeDefined();
            await closed;

            await store.save(true);
            expect(degraded).not.toHaveBeenCalled();

            await store.startup();
            await store.setSyncData(syncResp("after-retry"));
            await store.save(true);
            expect(await persistedToken()).toBe("after-retry");
        });
    });
});
