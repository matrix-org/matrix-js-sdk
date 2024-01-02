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
import { CryptoStore, MigrationState, SESSION_BATCH_SIZE } from "../../../../src/crypto/store/base";

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

    describe("migrationState", () => {
        beforeEach(async () => {
            await store.startup();
        });

        it("returns 0 at first", async () => {
            expect(await store.getMigrationState()).toEqual(MigrationState.NOT_STARTED);
        });

        it("stores updates", async () => {
            await store.setMigrationState(MigrationState.INITIAL_DATA_MIGRATED);
            expect(await store.getMigrationState()).toEqual(MigrationState.INITIAL_DATA_MIGRATED);
        });
    });

    describe("get/delete EndToEndSessionsBatch", () => {
        beforeEach(async () => {
            await store.startup();
        });

        it("returns null at first", async () => {
            expect(await store.getEndToEndSessionsBatch()).toBe(null);
        });

        it("returns a batch of sessions", async () => {
            // First store some sessions in the db
            const N_DEVICES = 6;
            const N_SESSIONS_PER_DEVICE = 6;
            await createSessions(N_DEVICES, N_SESSIONS_PER_DEVICE);

            let nSessions = 0;
            await store.doTxn("readonly", [IndexedDBCryptoStore.STORE_SESSIONS], (txn) =>
                store.countEndToEndSessions(txn, (n) => (nSessions = n)),
            );
            expect(nSessions).toEqual(N_DEVICES * N_SESSIONS_PER_DEVICE);

            // Then, get a batch and check it looks right.
            const batch = await store.getEndToEndSessionsBatch();
            expect(batch!.length).toEqual(N_DEVICES * N_SESSIONS_PER_DEVICE);
            for (let i = 0; i < N_DEVICES; i++) {
                for (let j = 0; j < N_SESSIONS_PER_DEVICE; j++) {
                    const r = batch![i * N_DEVICES + j];

                    expect(r.deviceKey).toEqual(`device${i}`);
                    expect(r.sessionId).toEqual(`session${j}`);
                }
            }
        });

        it("returns another batch of sessions after the first batch is deleted", async () => {
            // First store some sessions in the db
            const N_DEVICES = 8;
            const N_SESSIONS_PER_DEVICE = 8;
            await createSessions(N_DEVICES, N_SESSIONS_PER_DEVICE);

            // Get the first batch
            const batch = (await store.getEndToEndSessionsBatch())!;
            expect(batch.length).toEqual(SESSION_BATCH_SIZE);

            // ... and delete.
            await store.deleteEndToEndSessionsBatch(batch);

            // Fetch a second batch
            const batch2 = (await store.getEndToEndSessionsBatch())!;
            expect(batch2.length).toEqual(N_DEVICES * N_SESSIONS_PER_DEVICE - SESSION_BATCH_SIZE);

            // ... and delete.
            await store.deleteEndToEndSessionsBatch(batch2);

            // the batch should now be null.
            expect(await store.getEndToEndSessionsBatch()).toBe(null);
        });

        /** Create a bunch of fake Olm sessions and stash them in the DB. */
        async function createSessions(nDevices: number, nSessionsPerDevice: number) {
            await store.doTxn("readwrite", IndexedDBCryptoStore.STORE_SESSIONS, (txn) => {
                for (let i = 0; i < nDevices; i++) {
                    for (let j = 0; j < nSessionsPerDevice; j++) {
                        store.storeEndToEndSession(
                            `device${i}`,
                            `session${j}`,
                            {
                                deviceKey: `device${i}`,
                                sessionId: `session${j}`,
                            },
                            txn,
                        );
                    }
                }
            });
        }
    });

    describe("get/delete EndToEndInboundGroupSessionsBatch", () => {
        beforeEach(async () => {
            await store.startup();
        });

        it("returns null at first", async () => {
            expect(await store.getEndToEndInboundGroupSessionsBatch()).toBe(null);
        });

        it("returns a batch of sessions", async () => {
            const N_DEVICES = 6;
            const N_SESSIONS_PER_DEVICE = 6;
            await createSessions(N_DEVICES, N_SESSIONS_PER_DEVICE);

            // Mark one of the sessions as needing backup
            await store.doTxn("readwrite", IndexedDBCryptoStore.STORE_BACKUP, async (txn) => {
                await store.markSessionsNeedingBackup([{ senderKey: pad43("device5"), sessionId: "session5" }], txn);
            });

            expect(await store.countEndToEndInboundGroupSessions()).toEqual(N_DEVICES * N_SESSIONS_PER_DEVICE);

            const batch = await store.getEndToEndInboundGroupSessionsBatch();
            expect(batch!.length).toEqual(N_DEVICES * N_SESSIONS_PER_DEVICE);
            for (let i = 0; i < N_DEVICES; i++) {
                for (let j = 0; j < N_SESSIONS_PER_DEVICE; j++) {
                    const r = batch![i * N_DEVICES + j];

                    expect(r.senderKey).toEqual(pad43(`device${i}`));
                    expect(r.sessionId).toEqual(`session${j}`);

                    // only the last session needs backup
                    expect(r.needsBackup).toBe(i === 5 && j === 5);
                }
            }
        });

        it("returns another batch of sessions after the first batch is deleted", async () => {
            // First store some sessions in the db
            const N_DEVICES = 8;
            const N_SESSIONS_PER_DEVICE = 8;
            await createSessions(N_DEVICES, N_SESSIONS_PER_DEVICE);

            // Get the first batch
            const batch = (await store.getEndToEndInboundGroupSessionsBatch())!;
            expect(batch.length).toEqual(SESSION_BATCH_SIZE);

            // ... and delete.
            await store.deleteEndToEndInboundGroupSessionsBatch(batch);

            // Fetch a second batch
            const batch2 = (await store.getEndToEndInboundGroupSessionsBatch())!;
            expect(batch2.length).toEqual(N_DEVICES * N_SESSIONS_PER_DEVICE - SESSION_BATCH_SIZE);

            // ... and delete.
            await store.deleteEndToEndInboundGroupSessionsBatch(batch2);

            // the batch should now be null.
            expect(await store.getEndToEndInboundGroupSessionsBatch()).toBe(null);
        });

        /** Create a bunch of fake megolm sessions and stash them in the DB. */
        async function createSessions(nDevices: number, nSessionsPerDevice: number) {
            await store.doTxn("readwrite", IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS, (txn) => {
                for (let i = 0; i < nDevices; i++) {
                    for (let j = 0; j < nSessionsPerDevice; j++) {
                        store.storeEndToEndInboundGroupSession(
                            pad43(`device${i}`),
                            `session${j}`,
                            {
                                forwardingCurve25519KeyChain: [],
                                keysClaimed: {},
                                room_id: "",
                                session: "",
                            },
                            txn,
                        );
                    }
                }
            });
        }
    });
});

/** Pad a string to 43 characters long */
function pad43(x: string): string {
    return x + ".".repeat(43 - x.length);
}
