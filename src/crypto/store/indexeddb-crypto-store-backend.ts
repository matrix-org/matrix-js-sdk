/*
Copyright 2017 - 2021 The Matrix.org Foundation C.I.C.

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

import { type Logger, logger } from "../../logger.ts";
import {
    type CryptoStore,
    type IDeviceData,
    type ISession,
    type SessionExtended,
    type ISessionInfo,
    type IWithheld,
    MigrationState,
    type Mode,
    type SecretStorePrivateKeys,
    SESSION_BATCH_SIZE,
    ACCOUNT_OBJECT_KEY_MIGRATION_STATE,
    type InboundGroupSessionData,
    type IRoomEncryption,
} from "./base.ts";
import { IndexedDBCryptoStore } from "./indexeddb-crypto-store.ts";
import { type CrossSigningKeyInfo } from "../../crypto-api/index.ts";

const PROFILE_TRANSACTIONS = false;

/**
 * Implementation of a CryptoStore which is backed by an existing
 * IndexedDB connection. Generally you want IndexedDBCryptoStore
 * which connects to the database and defers to one of these.
 *
 * @internal
 */
export class Backend implements CryptoStore {
    private nextTxnId = 0;

    /**
     */
    public constructor(private db: IDBDatabase) {
        // make sure we close the db on `onversionchange` - otherwise
        // attempts to delete the database will block (and subsequent
        // attempts to re-create it will also block).
        db.onversionchange = (): void => {
            logger.log(`versionchange for indexeddb ${this.db.name}: closing`);
            db.close();
        };
    }

    public async containsData(): Promise<boolean> {
        throw Error("Not implemented for Backend");
    }

    public async startup(): Promise<CryptoStore> {
        // No work to do, as the startup is done by the caller (e.g IndexedDBCryptoStore)
        // by passing us a ready IDBDatabase instance
        return this;
    }

    public async deleteAllData(): Promise<void> {
        throw Error("This is not implemented, call IDBFactory::deleteDatabase(dbName) instead.");
    }

    /**
     * Get data on how much of the libolm to Rust Crypto migration has been done.
     *
     * Implementation of {@link CryptoStore.getMigrationState}.
     */
    public async getMigrationState(): Promise<MigrationState> {
        let migrationState = MigrationState.NOT_STARTED;
        await this.doTxn("readonly", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
            const objectStore = txn.objectStore(IndexedDBCryptoStore.STORE_ACCOUNT);
            const getReq = objectStore.get(ACCOUNT_OBJECT_KEY_MIGRATION_STATE);
            getReq.onsuccess = (): void => {
                migrationState = getReq.result ?? MigrationState.NOT_STARTED;
            };
        });
        return migrationState;
    }

    /**
     * Set data on how much of the libolm to Rust Crypto migration has been done.
     *
     * Implementation of {@link CryptoStore.setMigrationState}.
     */
    public async setMigrationState(migrationState: MigrationState): Promise<void> {
        await this.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
            const objectStore = txn.objectStore(IndexedDBCryptoStore.STORE_ACCOUNT);
            objectStore.put(migrationState, ACCOUNT_OBJECT_KEY_MIGRATION_STATE);
        });
    }

    // Olm Account

    public getAccount(txn: IDBTransaction, func: (accountPickle: string | null) => void): void {
        const objectStore = txn.objectStore("account");
        const getReq = objectStore.get("-");
        getReq.onsuccess = function (): void {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public storeAccount(txn: IDBTransaction, accountPickle: string): void {
        const objectStore = txn.objectStore("account");
        objectStore.put(accountPickle, "-");
    }

    public getCrossSigningKeys(
        txn: IDBTransaction,
        func: (keys: Record<string, CrossSigningKeyInfo> | null) => void,
    ): void {
        const objectStore = txn.objectStore("account");
        const getReq = objectStore.get("crossSigningKeys");
        getReq.onsuccess = function (): void {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: IDBTransaction,
        func: (key: SecretStorePrivateKeys[K] | null) => void,
        type: K,
    ): void {
        const objectStore = txn.objectStore("account");
        const getReq = objectStore.get(`ssss_cache:${type}`);
        getReq.onsuccess = function (): void {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: IDBTransaction,
        type: K,
        key: SecretStorePrivateKeys[K],
    ): void {
        const objectStore = txn.objectStore("account");
        objectStore.put(key, `ssss_cache:${type}`);
    }

    // Olm Sessions

    public countEndToEndSessions(txn: IDBTransaction, func: (count: number) => void): void {
        const objectStore = txn.objectStore("sessions");
        const countReq = objectStore.count();
        countReq.onsuccess = function (): void {
            try {
                func(countReq.result);
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public getEndToEndSessions(
        deviceKey: string,
        txn: IDBTransaction,
        func: (sessions: { [sessionId: string]: ISessionInfo }) => void,
    ): void {
        const objectStore = txn.objectStore("sessions");
        const idx = objectStore.index("deviceKey");
        const getReq = idx.openCursor(deviceKey);
        const results: Parameters<Parameters<Backend["getEndToEndSessions"]>[2]>[0] = {};
        getReq.onsuccess = function (): void {
            const cursor = getReq.result;
            if (cursor) {
                results[cursor.value.sessionId] = {
                    session: cursor.value.session,
                    lastReceivedMessageTs: cursor.value.lastReceivedMessageTs,
                };
                cursor.continue();
            } else {
                try {
                    func(results);
                } catch (e) {
                    abortWithException(txn, <Error>e);
                }
            }
        };
    }

    public getEndToEndSession(
        deviceKey: string,
        sessionId: string,
        txn: IDBTransaction,
        func: (session: ISessionInfo | null) => void,
    ): void {
        const objectStore = txn.objectStore("sessions");
        const getReq = objectStore.get([deviceKey, sessionId]);
        getReq.onsuccess = function (): void {
            try {
                if (getReq.result) {
                    func({
                        session: getReq.result.session,
                        lastReceivedMessageTs: getReq.result.lastReceivedMessageTs,
                    });
                } else {
                    func(null);
                }
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public storeEndToEndSession(
        deviceKey: string,
        sessionId: string,
        sessionInfo: ISessionInfo,
        txn: IDBTransaction,
    ): void {
        const objectStore = txn.objectStore("sessions");
        objectStore.put({
            deviceKey,
            sessionId,
            session: sessionInfo.session,
            lastReceivedMessageTs: sessionInfo.lastReceivedMessageTs,
        });
    }

    /**
     * Fetch a batch of Olm sessions from the database.
     *
     * Implementation of {@link CryptoStore.getEndToEndSessionsBatch}.
     */
    public async getEndToEndSessionsBatch(): Promise<null | ISessionInfo[]> {
        const result: ISessionInfo[] = [];
        await this.doTxn("readonly", [IndexedDBCryptoStore.STORE_SESSIONS], (txn) => {
            const objectStore = txn.objectStore(IndexedDBCryptoStore.STORE_SESSIONS);
            const getReq = objectStore.openCursor();
            getReq.onsuccess = function (): void {
                try {
                    const cursor = getReq.result;
                    if (cursor) {
                        result.push(cursor.value);
                        if (result.length < SESSION_BATCH_SIZE) {
                            cursor.continue();
                        }
                    }
                } catch (e) {
                    abortWithException(txn, <Error>e);
                }
            };
        });

        if (result.length === 0) {
            // No sessions left.
            return null;
        }

        return result;
    }

    /**
     * Delete a batch of Olm sessions from the database.
     *
     * Implementation of {@link CryptoStore.deleteEndToEndSessionsBatch}.
     *
     * @internal
     */
    public async deleteEndToEndSessionsBatch(sessions: { deviceKey: string; sessionId: string }[]): Promise<void> {
        await this.doTxn("readwrite", [IndexedDBCryptoStore.STORE_SESSIONS], async (txn) => {
            try {
                const objectStore = txn.objectStore(IndexedDBCryptoStore.STORE_SESSIONS);
                for (const { deviceKey, sessionId } of sessions) {
                    const req = objectStore.delete([deviceKey, sessionId]);
                    await new Promise((resolve) => {
                        req.onsuccess = resolve;
                    });
                }
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        });
    }

    // Inbound group sessions

    public getEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        txn: IDBTransaction,
        func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void,
    ): void {
        let session: InboundGroupSessionData | null | boolean = false;
        let withheld: IWithheld | null | boolean = false;
        const objectStore = txn.objectStore("inbound_group_sessions");
        const getReq = objectStore.get([senderCurve25519Key, sessionId]);
        getReq.onsuccess = function (): void {
            try {
                if (getReq.result) {
                    session = getReq.result.session;
                } else {
                    session = null;
                }
                if (withheld !== false) {
                    func(session as InboundGroupSessionData, withheld as IWithheld);
                }
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };

        const withheldObjectStore = txn.objectStore("inbound_group_sessions_withheld");
        const withheldGetReq = withheldObjectStore.get([senderCurve25519Key, sessionId]);
        withheldGetReq.onsuccess = function (): void {
            try {
                if (withheldGetReq.result) {
                    withheld = withheldGetReq.result.session;
                } else {
                    withheld = null;
                }
                if (session !== false) {
                    func(session as InboundGroupSessionData, withheld as IWithheld);
                }
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public storeEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: IDBTransaction,
    ): void {
        const objectStore = txn.objectStore("inbound_group_sessions");
        objectStore.put({
            senderCurve25519Key,
            sessionId,
            session: sessionData,
        });
    }

    /**
     * Count the number of Megolm sessions in the database.
     *
     * Implementation of {@link CryptoStore.countEndToEndInboundGroupSessions}.
     *
     * @internal
     */
    public async countEndToEndInboundGroupSessions(): Promise<number> {
        let result = 0;
        await this.doTxn("readonly", [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], (txn) => {
            const sessionStore = txn.objectStore(IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS);
            const countReq = sessionStore.count();
            countReq.onsuccess = (): void => {
                result = countReq.result;
            };
        });
        return result;
    }

    /**
     * Fetch a batch of Megolm sessions from the database.
     *
     * Implementation of {@link CryptoStore.getEndToEndInboundGroupSessionsBatch}.
     */
    public async getEndToEndInboundGroupSessionsBatch(): Promise<null | SessionExtended[]> {
        const result: SessionExtended[] = [];
        await this.doTxn(
            "readonly",
            [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS, IndexedDBCryptoStore.STORE_BACKUP],
            (txn) => {
                const sessionStore = txn.objectStore(IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS);
                const backupStore = txn.objectStore(IndexedDBCryptoStore.STORE_BACKUP);

                const getReq = sessionStore.openCursor();
                getReq.onsuccess = function (): void {
                    try {
                        const cursor = getReq.result;
                        if (cursor) {
                            const backupGetReq = backupStore.get(cursor.key);
                            backupGetReq.onsuccess = (): void => {
                                result.push({
                                    senderKey: cursor.value.senderCurve25519Key,
                                    sessionId: cursor.value.sessionId,
                                    sessionData: cursor.value.session,
                                    needsBackup: backupGetReq.result !== undefined,
                                });
                                if (result.length < SESSION_BATCH_SIZE) {
                                    cursor.continue();
                                }
                            };
                        }
                    } catch (e) {
                        abortWithException(txn, <Error>e);
                    }
                };
            },
        );

        if (result.length === 0) {
            // No sessions left.
            return null;
        }

        return result;
    }

    /**
     * Delete a batch of Megolm sessions from the database.
     *
     * Implementation of {@link CryptoStore.deleteEndToEndInboundGroupSessionsBatch}.
     *
     * @internal
     */
    public async deleteEndToEndInboundGroupSessionsBatch(
        sessions: { senderKey: string; sessionId: string }[],
    ): Promise<void> {
        await this.doTxn("readwrite", [IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS], async (txn) => {
            try {
                const objectStore = txn.objectStore(IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS);
                for (const { senderKey, sessionId } of sessions) {
                    const req = objectStore.delete([senderKey, sessionId]);
                    await new Promise((resolve) => {
                        req.onsuccess = resolve;
                    });
                }
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        });
    }

    public getEndToEndDeviceData(txn: IDBTransaction, func: (deviceData: IDeviceData | null) => void): void {
        const objectStore = txn.objectStore("device_data");
        const getReq = objectStore.get("-");
        getReq.onsuccess = function (): void {
            try {
                func(getReq.result || null);
            } catch (e) {
                abortWithException(txn, <Error>e);
            }
        };
    }

    public getEndToEndRooms(txn: IDBTransaction, func: (rooms: Record<string, IRoomEncryption>) => void): void {
        const rooms: Parameters<Parameters<Backend["getEndToEndRooms"]>[1]>[0] = {};
        const objectStore = txn.objectStore("rooms");
        const getReq = objectStore.openCursor();
        getReq.onsuccess = function (): void {
            const cursor = getReq.result;
            if (cursor) {
                rooms[cursor.key as string] = cursor.value;
                cursor.continue();
            } else {
                try {
                    func(rooms);
                } catch (e) {
                    abortWithException(txn, <Error>e);
                }
            }
        };
    }

    public async markSessionsNeedingBackup(sessions: ISession[], txn?: IDBTransaction): Promise<void> {
        if (!txn) {
            txn = this.db.transaction("sessions_needing_backup", "readwrite");
        }
        const objectStore = txn.objectStore("sessions_needing_backup");
        await Promise.all(
            sessions.map((session) => {
                return new Promise((resolve, reject) => {
                    const req = objectStore.put({
                        senderCurve25519Key: session.senderKey,
                        sessionId: session.sessionId,
                    });
                    req.onsuccess = resolve;
                    req.onerror = reject;
                });
            }),
        );
    }

    public doTxn<T>(
        mode: Mode,
        stores: string | string[],
        func: (txn: IDBTransaction) => T,
        log: Logger = logger,
    ): Promise<T> {
        let startTime: number;
        let description: string;
        if (PROFILE_TRANSACTIONS) {
            const txnId = this.nextTxnId++;
            startTime = Date.now();
            description = `${mode} crypto store transaction ${txnId} in ${stores}`;
            log.debug(`Starting ${description}`);
        }
        const txn = this.db.transaction(stores, mode);
        const promise = promiseifyTxn(txn);
        const result = func(txn);
        if (PROFILE_TRANSACTIONS) {
            promise.then(
                () => {
                    const elapsedTime = Date.now() - startTime;
                    log.debug(`Finished ${description}, took ${elapsedTime} ms`);
                },
                () => {
                    const elapsedTime = Date.now() - startTime;
                    log.error(`Failed ${description}, took ${elapsedTime} ms`);
                },
            );
        }
        return promise.then(() => {
            return result;
        });
    }
}

type DbMigration = (db: IDBDatabase) => void;
const DB_MIGRATIONS: DbMigration[] = [
    (db): void => {
        createDatabase(db);
    },
    (db): void => {
        db.createObjectStore("account");
    },
    (db): void => {
        const sessionsStore = db.createObjectStore("sessions", {
            keyPath: ["deviceKey", "sessionId"],
        });
        sessionsStore.createIndex("deviceKey", "deviceKey");
    },
    (db): void => {
        db.createObjectStore("inbound_group_sessions", {
            keyPath: ["senderCurve25519Key", "sessionId"],
        });
    },
    (db): void => {
        db.createObjectStore("device_data");
    },
    (db): void => {
        db.createObjectStore("rooms");
    },
    (db): void => {
        db.createObjectStore("sessions_needing_backup", {
            keyPath: ["senderCurve25519Key", "sessionId"],
        });
    },
    (db): void => {
        db.createObjectStore("inbound_group_sessions_withheld", {
            keyPath: ["senderCurve25519Key", "sessionId"],
        });
    },
    (db): void => {
        const problemsStore = db.createObjectStore("session_problems", {
            keyPath: ["deviceKey", "time"],
        });
        problemsStore.createIndex("deviceKey", "deviceKey");

        db.createObjectStore("notified_error_devices", {
            keyPath: ["userId", "deviceId"],
        });
    },
    (db): void => {
        db.createObjectStore("shared_history_inbound_group_sessions", {
            keyPath: ["roomId"],
        });
    },
    (db): void => {
        db.createObjectStore("parked_shared_history", {
            keyPath: ["roomId"],
        });
    },
    // Expand as needed.
];
export const VERSION = DB_MIGRATIONS.length;

export function upgradeDatabase(db: IDBDatabase, oldVersion: number): void {
    logger.log(`Upgrading IndexedDBCryptoStore from version ${oldVersion}` + ` to ${VERSION}`);
    DB_MIGRATIONS.forEach((migration, index) => {
        if (oldVersion <= index) migration(db);
    });
}

function createDatabase(db: IDBDatabase): void {
    const outgoingRoomKeyRequestsStore = db.createObjectStore("outgoingRoomKeyRequests", { keyPath: "requestId" });

    // we assume that the RoomKeyRequestBody will have room_id and session_id
    // properties, to make the index efficient.
    outgoingRoomKeyRequestsStore.createIndex("session", ["requestBody.room_id", "requestBody.session_id"]);

    outgoingRoomKeyRequestsStore.createIndex("state", "state");
}

interface IWrappedIDBTransaction extends IDBTransaction {
    _mx_abortexception: Error; // eslint-disable-line camelcase
}

/*
 * Aborts a transaction with a given exception
 * The transaction promise will be rejected with this exception.
 */
function abortWithException(txn: IDBTransaction, e: Error): void {
    // We cheekily stick our exception onto the transaction object here
    // We could alternatively make the thing we pass back to the app
    // an object containing the transaction and exception.
    (txn as IWrappedIDBTransaction)._mx_abortexception = e;
    try {
        txn.abort();
    } catch {
        // sometimes we won't be able to abort the transaction
        // (ie. if it's aborted or completed)
    }
}

function promiseifyTxn<T>(txn: IDBTransaction): Promise<T | null> {
    return new Promise((resolve, reject) => {
        txn.oncomplete = (): void => {
            if ((txn as IWrappedIDBTransaction)._mx_abortexception !== undefined) {
                reject((txn as IWrappedIDBTransaction)._mx_abortexception);
            }
            resolve(null);
        };
        txn.onerror = (event): void => {
            if ((txn as IWrappedIDBTransaction)._mx_abortexception !== undefined) {
                reject((txn as IWrappedIDBTransaction)._mx_abortexception);
            } else {
                logger.log("Error performing indexeddb txn", event);
                reject(txn.error);
            }
        };
        txn.onabort = (event): void => {
            if ((txn as IWrappedIDBTransaction)._mx_abortexception !== undefined) {
                reject((txn as IWrappedIDBTransaction)._mx_abortexception);
            } else {
                logger.log("Error performing indexeddb txn", event);
                reject(txn.error);
            }
        };
    });
}
