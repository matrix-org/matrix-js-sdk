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

import "fake-indexeddb/auto";

import { LocalIndexedDBStoreBackend } from "../../../src/store/indexeddb-local-backend";
import type { SyncUserProfile } from "../../../src/models/user";
import type { IMinimalEvent, ISyncResponse } from "../../../src/sync-accumulator";
import type { UserTuple } from "../../../src/store/indexeddb-backend";

describe("LocalIndexedDBStoreBackend", () => {
    let backend: LocalIndexedDBStoreBackend;

    beforeEach(async () => {
        backend = new LocalIndexedDBStoreBackend(indexedDB, `get-user-profile-${Date.now()}-${Math.random()}`);
        await backend.connect();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await backend.clearDatabase();
    });

    it("stores and retrieves a user profile for the given user ID", async () => {
        const userId = "@alice:example.org";
        const profile: SyncUserProfile = {
            displayname: "Alice",
            avatar_url: "mxc://example.org/avatar",
        };

        await backend.storeUserProfiles(new Map([[userId, profile]]));

        await expect(backend.getUserProfile(userId)).resolves.toEqual(profile);
    });

    it("returns undefined for a missing user profile", async () => {
        await expect(backend.getUserProfile("@missing:example.org")).resolves.toBeUndefined();
    });

    it("returns undefined once a user profile has been removed", async () => {
        const userId = "@alice:example.org";
        const profile: SyncUserProfile = {
            displayname: "Alice",
            avatar_url: "mxc://example.org/avatar",
        };

        await backend.storeUserProfiles(new Map([[userId, profile]]));

        await expect(backend.getUserProfile(userId)).resolves.toEqual(profile);
        backend.removeUserProfiles([userId]);
        await expect(backend.getUserProfile(userId)).resolves.toBeUndefined();
    });

    describe("syncToDatabase", () => {
        const readPersisted = async () => {
            const reader = new LocalIndexedDBStoreBackend(indexedDB, backend["dbName"].replace(/^matrix-js-sdk:/, ""));
            await reader.connect();
            try {
                return { sync: await reader.getSavedSync(), presence: await reader.getUserPresenceEvents() };
            } finally {
                await reader.destroy();
            }
        };
        const syncResp = (nextBatch: string, events: IMinimalEvent[] = []): ISyncResponse => ({
            next_batch: nextBatch,
            rooms: { join: {}, invite: {}, leave: {}, knock: {} },
            account_data: { events },
        });
        const online: UserTuple = ["@alice:example.org", { type: "m.presence", content: { presence: "online" } }];
        const offline: UserTuple = ["@alice:example.org", { type: "m.presence", content: { presence: "offline" } }];

        it("writes no partial data on async write failure", async () => {
            await backend.setSyncData(syncResp("saved", [{ type: "m.direct", content: { v: 1 } }]));
            await backend.syncToDatabase([online]);

            const realPut = IDBObjectStore.prototype.put;
            vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
                return this.name === "accountData" ? this.add(args[0]) : realPut.apply(this, args);
            });
            await backend.setSyncData(syncResp("failed", [{ type: "m.direct", content: { v: 2 } }]));
            // txnAsPromise rejects with txn.error, which is null for a bubbled request error.
            await expect(backend.syncToDatabase([offline])).rejects.toBeNull();

            const { sync, presence } = await readPersisted();
            expect(sync).toMatchObject({ nextBatch: "saved", accountData: [{ type: "m.direct", content: { v: 1 } }] });
            expect(presence).toEqual([online]);
        });

        it("aborts transaction and allows future saves on synchronous throw", async () => {
            await backend.setSyncData(syncResp("saved"));
            await backend.syncToDatabase([online]);

            const realPut = IDBObjectStore.prototype.put;
            vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
                if (this.name === "sync") throw new DOMException("Not clonable.", "DataCloneError");
                return realPut.apply(this, args);
            });
            await backend.setSyncData(syncResp("thrown", [{ type: "m.direct", content: {} }]));
            await expect(backend.syncToDatabase([offline])).rejects.toMatchObject({ name: "DataCloneError" });

            const before = await readPersisted();
            expect(before.sync).toMatchObject({ nextBatch: "saved", accountData: [] });
            expect(before.presence).toEqual([online]);

            vi.restoreAllMocks();
            await backend.syncToDatabase([offline]);
            const after = await readPersisted();
            expect(after.sync?.nextBatch).toBe("thrown");
            expect(after.presence).toEqual([offline]);
        });
    });
});
