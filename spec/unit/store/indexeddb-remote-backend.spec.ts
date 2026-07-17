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

import { RemoteIndexedDBStoreBackend } from "../../../src/store/indexeddb-remote-backend";

describe("RemoteIndexedDBStoreBackend", () => {
    let mockPostMessage: ReturnType<typeof vi.fn>;
    let mockTerminate: ReturnType<typeof vi.fn>;
    let workerMessageHandler: ((ev: MessageEvent) => void) | undefined;
    let backend: RemoteIndexedDBStoreBackend;

    function simulateWorkerMessage(data: object): void {
        workerMessageHandler?.({ data } as MessageEvent);
    }

    /** Override the next postMessage reply to return a specific result. */
    function stubNextResult(result: unknown): void {
        mockPostMessage.mockImplementationOnce((msg: { seq: number }) => {
            Promise.resolve().then(() => {
                simulateWorkerMessage({ command: "cmd_success", seq: msg.seq, result });
            });
        });
    }

    /** Override the next postMessage reply to return a cmd_fail. */
    function stubNextError(error: { message: string; name: string }): void {
        mockPostMessage.mockImplementationOnce((msg: { seq: number }) => {
            Promise.resolve().then(() => {
                simulateWorkerMessage({ command: "cmd_fail", seq: msg.seq, error });
            });
        });
    }

    beforeEach(() => {
        workerMessageHandler = undefined;

        // Auto-reply with cmd_success to every worker message by default.
        mockPostMessage = vi.fn().mockImplementation((msg: { seq: number }) => {
            Promise.resolve().then(() => {
                simulateWorkerMessage({ command: "cmd_success", seq: msg.seq, result: undefined });
            });
        });
        mockTerminate = vi.fn();

        backend = new RemoteIndexedDBStoreBackend(
            () =>
                ({
                    postMessage: mockPostMessage,
                    terminate: mockTerminate,
                    get onmessage() {
                        return workerMessageHandler ?? null;
                    },
                    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
                        workerMessageHandler = fn ?? undefined;
                    },
                }) as unknown as Worker,
            "test-db",
        );
    });

    /**
     * Connect the backend (drives setupWorker + connect replies via the auto-mock),
     * then clear the postMessage call log so tests only see the calls they trigger.
     */
    async function start(): Promise<void> {
        await backend.connect();
        mockPostMessage.mockClear();
    }

    describe("connect()", () => {
        it("sends setupWorker with the database name and then a connect command", async () => {
            await backend.connect();

            expect(mockPostMessage).toHaveBeenCalledWith({ command: "setupWorker", seq: 0, args: ["test-db"] });
            expect(mockPostMessage).toHaveBeenCalledWith({ command: "connect", seq: 1, args: undefined });
        });

        it("calls the worker factory only once across multiple connect() calls", async () => {
            const factory = vi.fn().mockReturnValue({
                postMessage: mockPostMessage,
                terminate: mockTerminate,
                get onmessage() {
                    return workerMessageHandler ?? null;
                },
                set onmessage(fn: ((ev: MessageEvent) => void) | null) {
                    workerMessageHandler = fn ?? undefined;
                },
            } satisfies Worker);
            backend = new RemoteIndexedDBStoreBackend(factory, "test-db");

            await backend.connect();
            await backend.connect();

            expect(factory).toHaveBeenCalledTimes(1);
        });

        it("calls the onClose callback when the worker sends a closed message", async () => {
            const onClose = vi.fn();
            await backend.connect(onClose);

            simulateWorkerMessage({ command: "closed" });

            expect(onClose).toHaveBeenCalledTimes(1);
        });
    });

    describe("clearDatabase()", () => {
        it("starts the worker if not yet started and sends clearDatabase", async () => {
            await backend.clearDatabase();

            expect(mockPostMessage).toHaveBeenCalledWith({ command: "setupWorker", seq: 0, args: ["test-db"] });
            expect(mockPostMessage).toHaveBeenCalledWith({ command: "clearDatabase", seq: 1, args: undefined });
        });
    });

    describe("commands (after connect)", () => {
        beforeEach(start);

        it("isNewlyCreated sends the command and returns the result", async () => {
            stubNextResult(true);

            const result = await backend.isNewlyCreated();

            expect(result).toBe(true);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "isNewlyCreated",
                seq: expect.any(Number),
                args: undefined,
            });
        });

        it("getSavedSync sends the command and returns the result", async () => {
            const savedSync = { nextBatch: "tok", roomsMap: {} };
            stubNextResult(savedSync);

            const result = await backend.getSavedSync();

            expect(result).toBe(savedSync);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getSavedSync",
                seq: expect.any(Number),
                args: undefined,
            });
        });

        it("getNextBatchToken sends the command and returns the token", async () => {
            stubNextResult("s1234_5678");

            const result = await backend.getNextBatchToken();

            expect(result).toBe("s1234_5678");
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getNextBatchToken",
                seq: expect.any(Number),
                args: undefined,
            });
        });

        it("setSyncData sends the command with sync data as args", async () => {
            const syncData = { next_batch: "tok" } as any;

            await backend.setSyncData(syncData);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "setSyncData",
                seq: expect.any(Number),
                args: [syncData],
            });
        });

        it("syncToDatabase sends the command with userTuples as args", async () => {
            const userTuples = [["@alice:example.org", { type: "m.presence" }]] as any;

            await backend.syncToDatabase(userTuples);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "syncToDatabase",
                seq: expect.any(Number),
                args: [userTuples],
            });
        });

        it("getUserPresenceEvents sends the command and returns the result", async () => {
            const events = [["@alice:example.org", { type: "m.presence" }]] as any;
            stubNextResult(events);

            const result = await backend.getUserPresenceEvents();

            expect(result).toBe(events);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getUserPresenceEvents",
                seq: expect.any(Number),
                args: undefined,
            });
        });

        it("getOutOfBandMembers sends the command with roomId and returns the result", async () => {
            const members = [{ type: "m.room.member", room_id: "!room:example.org" }] as any;
            stubNextResult(members);

            const result = await backend.getOutOfBandMembers("!room:example.org");

            expect(result).toBe(members);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getOutOfBandMembers",
                seq: expect.any(Number),
                args: ["!room:example.org"],
            });
        });

        it("setOutOfBandMembers sends the command with roomId and events as args", async () => {
            const events = [{ type: "m.room.member" }] as any;

            await backend.setOutOfBandMembers("!room:example.org", events);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "setOutOfBandMembers",
                seq: expect.any(Number),
                args: ["!room:example.org", events],
            });
        });

        it("clearOutOfBandMembers sends the command with roomId as args", async () => {
            await backend.clearOutOfBandMembers("!room:example.org");

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "clearOutOfBandMembers",
                seq: expect.any(Number),
                args: ["!room:example.org"],
            });
        });

        it("getClientOptions sends the command and returns the result", async () => {
            const opts = { lazyLoadMembers: true };
            stubNextResult(opts);

            const result = await backend.getClientOptions();

            expect(result).toEqual(opts);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getClientOptions",
                seq: expect.any(Number),
                args: undefined,
            });
        });

        it("storeClientOptions sends the command with options as args", async () => {
            const opts = { lazyLoadMembers: true } as any;

            await backend.storeClientOptions(opts);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "storeClientOptions",
                seq: expect.any(Number),
                args: [opts],
            });
        });

        it("saveToDeviceBatches sends the command with batches as args", async () => {
            const batches = [{ eventType: "m.room_key_request", txnId: "txn", batch: [] }] as any;

            await backend.saveToDeviceBatches(batches);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "saveToDeviceBatches",
                seq: expect.any(Number),
                args: [batches],
            });
        });

        it("getOldestToDeviceBatch sends the command and returns the result", async () => {
            const batch = { id: 1, eventType: "m.room_key_request", txnId: "txn", events: [] };
            stubNextResult(batch);

            const result = await backend.getOldestToDeviceBatch();

            expect(result).toBe(batch);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getOldestToDeviceBatch",
                seq: expect.any(Number),
                args: undefined,
            });
        });

        it("removeToDeviceBatch sends the command with the batch id as args", async () => {
            await backend.removeToDeviceBatch(42);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "removeToDeviceBatch",
                seq: expect.any(Number),
                args: [42],
            });
        });

        it("getUserProfile sends the command with the userId and returns the result", async () => {
            const profile = { displayname: "Alice", avatar_url: "mxc://example.org/alice" };
            stubNextResult(profile);

            const result = await backend.getUserProfile("@alice:example.org");

            expect(result).toEqual(profile);
            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "getUserProfile",
                seq: expect.any(Number),
                args: ["@alice:example.org"],
            });
        });

        it("storeUserProfiles sends the command with profile tuples as args", async () => {
            const tuples: [string, { displayname: string }][] = [["@alice:example.org", { displayname: "Alice" }]];

            await backend.storeUserProfiles(tuples as any);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "storeUserProfiles",
                seq: expect.any(Number),
                args: [tuples],
            });
        });

        it("removeUserProfiles sends the 'removeUserProfile' command with user IDs as args", async () => {
            await backend.removeUserProfiles(["@alice:example.org"]);

            expect(mockPostMessage).toHaveBeenCalledWith({
                command: "removeUserProfiles",
                seq: expect.any(Number),
                args: [["@alice:example.org"]],
            });
        });
    });

    describe("worker message handling", () => {
        beforeEach(start);

        it("rejects the in-flight promise when cmd_fail is received", async () => {
            stubNextError({ message: "disk full", name: "QuotaExceededError" });

            await expect(backend.getNextBatchToken()).rejects.toMatchObject({
                message: "disk full",
                name: "QuotaExceededError",
            });
        });
    });

    describe("destroy()", () => {
        it("terminates the worker", async () => {
            await start();
            await backend.destroy();

            expect(mockTerminate).toHaveBeenCalledTimes(1);
        });

        it("does nothing if the worker was never started", async () => {
            await backend.destroy();

            expect(mockTerminate).not.toHaveBeenCalled();
        });
    });
});
