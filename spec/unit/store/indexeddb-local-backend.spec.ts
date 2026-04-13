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

describe("LocalIndexedDBStoreBackend", () => {
    let backend: LocalIndexedDBStoreBackend;

    beforeEach(async () => {
        backend = new LocalIndexedDBStoreBackend(indexedDB, `get-user-profile-${Date.now()}-${Math.random()}`);
        await backend.connect();
    });

    afterEach(async () => {
        await backend.clearDatabase();
    });

    it("stores and retrieves a user profile for the given user ID", async () => {
        const userId = "@alice:example.org";
        const profile: SyncUserProfile = {
            displayname: "Alice",
            avatar_url: "mxc://example.org/avatar",
        };

        await backend.storeUserProfiles([[userId, profile]]);

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

        await backend.storeUserProfiles([[userId, profile]]);

        await expect(backend.getUserProfile(userId)).resolves.toEqual(profile);
        backend.removeUserProfiles([userId]);
        await expect(backend.getUserProfile(userId)).resolves.toBeUndefined();
    });
});
