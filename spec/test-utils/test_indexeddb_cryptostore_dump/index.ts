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

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Populate an IndexedDB store with the test data from this directory.
 *
 * @param name - Name of the IndexedDB database to create.
 */
export async function populateStore(name: string): Promise<IDBDatabase> {
    const req = indexedDB.open(name, 11);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        req.onupgradeneeded = (ev): void => {
            const db = req.result;
            const oldVersion = ev.oldVersion;
            upgradeDatabase(oldVersion, db);
        };

        req.onerror = (ev): void => {
            reject(req.error);
        };

        req.onsuccess = (): void => {
            const db = req.result;
            resolve(db);
        };
    });

    await importData(db);

    return db;
}

/** Create the schema for the indexed db store */
function upgradeDatabase(oldVersion: number, db: IDBDatabase) {
    if (oldVersion < 1) {
        const outgoingRoomKeyRequestsStore = db.createObjectStore("outgoingRoomKeyRequests", { keyPath: "requestId" });
        outgoingRoomKeyRequestsStore.createIndex("session", ["requestBody.room_id", "requestBody.session_id"]);
        outgoingRoomKeyRequestsStore.createIndex("state", "state");
    }

    if (oldVersion < 2) {
        db.createObjectStore("account");
    }

    if (oldVersion < 3) {
        const sessionsStore = db.createObjectStore("sessions", { keyPath: ["deviceKey", "sessionId"] });
        sessionsStore.createIndex("deviceKey", "deviceKey");
    }

    if (oldVersion < 4) {
        db.createObjectStore("inbound_group_sessions", { keyPath: ["senderCurve25519Key", "sessionId"] });
    }

    if (oldVersion < 5) {
        db.createObjectStore("device_data");
    }

    if (oldVersion < 6) {
        db.createObjectStore("rooms");
    }

    if (oldVersion < 7) {
        db.createObjectStore("sessions_needing_backup", { keyPath: ["senderCurve25519Key", "sessionId"] });
    }

    if (oldVersion < 8) {
        db.createObjectStore("inbound_group_sessions_withheld", { keyPath: ["senderCurve25519Key", "sessionId"] });
    }

    if (oldVersion < 9) {
        const problemsStore = db.createObjectStore("session_problems", { keyPath: ["deviceKey", "time"] });
        problemsStore.createIndex("deviceKey", "deviceKey");

        db.createObjectStore("notified_error_devices", { keyPath: ["userId", "deviceId"] });
    }

    if (oldVersion < 10) {
        db.createObjectStore("shared_history_inbound_group_sessions", { keyPath: ["roomId"] });
    }

    if (oldVersion < 11) {
        db.createObjectStore("parked_shared_history", { keyPath: ["roomId"] });
    }
}

async function importData(db: IDBDatabase) {
    const path = resolve("spec/test-utils/test_indexeddb_cryptostore_dump/dump.json");
    const json: Record<string, Array<{ key?: any; value: any }>> = JSON.parse(
        await readFile(path, { encoding: "utf8" }),
    );

    for (const [storeName, data] of Object.entries(json)) {
        await new Promise((resolve, reject) => {
            const store = db.transaction(storeName, "readwrite").objectStore(storeName);

            function putEntry(idx: number) {
                if (idx >= data.length) {
                    resolve(undefined);
                    return;
                }

                const { key, value } = data[idx];
                try {
                    const putReq = store.put(value, key);
                    putReq.onsuccess = (_) => putEntry(idx + 1);
                    putReq.onerror = (_) => reject(putReq.error);
                } catch (e) {
                    throw new Error(
                        `Error populating '${storeName}' with key ${JSON.stringify(key)}, value ${JSON.stringify(
                            value,
                        )}: ${e}`,
                    );
                }
            }

            putEntry(0);
        });
    }
}
