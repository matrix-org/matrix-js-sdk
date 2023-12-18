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

import "fake-indexeddb/auto";
import "jest-localstorage-mock";
import { IndexedDBCryptoStore, LocalStorageCryptoStore, MemoryCryptoStore } from "../../../../src";
import { CryptoStore } from "../../../../src/crypto/store/base";

describe.each([
    ["IndexedDBCryptoStore", () => new IndexedDBCryptoStore(global.indexedDB, "tests")],
    ["LocalStorageCryptoStore", () => new LocalStorageCryptoStore(localStorage)],
    ["MemoryCryptoStore", () => new MemoryCryptoStore()],
])("CryptoStore tests for %s", function (name, dbFactory) {
    let store: CryptoStore;

    beforeEach(async () => {
        store = dbFactory();
    });

    describe("containsData", () => {
        it("returns false at first", async () => {
            expect(await store.containsData()).toBe(false);
        });

        it("returns true after startup and account setup", async () => {
            await store.startup();
            await store.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
                store.storeAccount(txn, "not a real account");
            });
            expect(await store.containsData()).toBe(true);
        });
    });
});
