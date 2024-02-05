/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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
import { IndexedDBCryptoStore } from "../../../../src";
import { MigrationState } from "../../../../src/crypto/store/base";

describe("IndexedDBCryptoStore", () => {
    describe("Test `existsAndIsNotMigrated`", () => {
        beforeEach(async () => {
            // eslint-disable-next-line no-global-assign
            indexedDB = new IDBFactory();
        });

        it("Should be true if there is a legacy database", async () => {
            // should detect a store that is not migrated
            const store = new IndexedDBCryptoStore(global.indexedDB, "tests");
            await store.startup();

            const result = await IndexedDBCryptoStore.existsAndIsNotMigrated(global.indexedDB, "tests");

            expect(result).toBe(true);
        });

        it("Should be true if there is a legacy database in non migrated state", async () => {
            // should detect a store that is not migrated
            const store = new IndexedDBCryptoStore(global.indexedDB, "tests");
            await store.startup();
            await store.setMigrationState(MigrationState.NOT_STARTED);

            const result = await IndexedDBCryptoStore.existsAndIsNotMigrated(global.indexedDB, "tests");

            expect(result).toBe(true);
        });

        describe.each([
            MigrationState.INITIAL_DATA_MIGRATED,
            MigrationState.OLM_SESSIONS_MIGRATED,
            MigrationState.MEGOLM_SESSIONS_MIGRATED,
            MigrationState.ROOM_SETTINGS_MIGRATED,
        ])("Exists and Migration state is %s", (migrationState) => {
            it("Should be false if migration has started", async () => {
                // should detect a store that is not migrated
                const store = new IndexedDBCryptoStore(global.indexedDB, "tests");
                await store.startup();
                await store.setMigrationState(migrationState);

                const result = await IndexedDBCryptoStore.existsAndIsNotMigrated(global.indexedDB, "tests");

                expect(result).toBe(false);
            });
        });

        it("Should be false if there is no legacy database", async () => {
            const result = await IndexedDBCryptoStore.existsAndIsNotMigrated(global.indexedDB, "tests");

            expect(result).toBe(false);
        });
    });
});
