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

import { logger, type Logger } from "../../logger.ts";
import { LocalStorageCryptoStore } from "./localStorage-crypto-store.ts";
import { MemoryCryptoStore } from "./memory-crypto-store.ts";
import * as IndexedDBCryptoStoreBackend from "./indexeddb-crypto-store-backend.ts";
import { InvalidCryptoStoreError, InvalidCryptoStoreState } from "../../errors.ts";
import * as IndexedDBHelpers from "../../indexeddb-helpers.ts";
import {
    type CryptoStore,
    type ISession,
    type SessionExtended,
    type ISessionInfo,
    type IWithheld,
    MigrationState,
    type Mode,
    type SecretStorePrivateKeys,
    ACCOUNT_OBJECT_KEY_MIGRATION_STATE,
    type InboundGroupSessionData,
    type IRoomEncryption,
} from "./base.ts";
import { type CrossSigningKeyInfo } from "../../crypto-api/index.ts";

/*
 * Internal module. indexeddb storage for e2e.
 */

/**
 * An implementation of CryptoStore, which is normally backed by an indexeddb,
 * but with fallback to MemoryCryptoStore.
 */
export class IndexedDBCryptoStore implements CryptoStore {
    public static STORE_ACCOUNT = "account";
    public static STORE_SESSIONS = "sessions";
    public static STORE_INBOUND_GROUP_SESSIONS = "inbound_group_sessions";
    public static STORE_INBOUND_GROUP_SESSIONS_WITHHELD = "inbound_group_sessions_withheld";
    public static STORE_SHARED_HISTORY_INBOUND_GROUP_SESSIONS = "shared_history_inbound_group_sessions";
    public static STORE_PARKED_SHARED_HISTORY = "parked_shared_history";
    public static STORE_DEVICE_DATA = "device_data";
    public static STORE_ROOMS = "rooms";
    public static STORE_BACKUP = "sessions_needing_backup";

    public static exists(indexedDB: IDBFactory, dbName: string): Promise<boolean> {
        return IndexedDBHelpers.exists(indexedDB, dbName);
    }

    /**
     * Utility to check if a legacy crypto store exists and has not been migrated.
     * Returns true if the store exists and has not been migrated, false otherwise.
     */
    public static existsAndIsNotMigrated(indexedDb: IDBFactory, dbName: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            let exists = true;
            const openDBRequest = indexedDb.open(dbName);
            openDBRequest.onupgradeneeded = (): void => {
                // Since we did not provide an explicit version when opening, this event
                // should only fire if the DB did not exist before at any version.
                exists = false;
            };
            openDBRequest.onblocked = (): void => reject(openDBRequest.error);
            openDBRequest.onsuccess = (): void => {
                const db = openDBRequest.result;
                if (!exists) {
                    db.close();
                    // The DB did not exist before, but has been created as part of this
                    // existence check. Delete it now to restore previous state. Delete can
                    // actually take a while to complete in some browsers, so don't wait for
                    // it. This won't block future open calls that a store might issue next to
                    // properly set up the DB.
                    indexedDb.deleteDatabase(dbName);
                    resolve(false);
                } else {
                    const tx = db.transaction([IndexedDBCryptoStore.STORE_ACCOUNT], "readonly");
                    const objectStore = tx.objectStore(IndexedDBCryptoStore.STORE_ACCOUNT);
                    const getReq = objectStore.get(ACCOUNT_OBJECT_KEY_MIGRATION_STATE);

                    getReq.onsuccess = (): void => {
                        const migrationState = getReq.result ?? MigrationState.NOT_STARTED;
                        resolve(migrationState === MigrationState.NOT_STARTED);
                    };

                    getReq.onerror = (): void => {
                        reject(getReq.error);
                    };

                    db.close();
                }
            };
            openDBRequest.onerror = (): void => reject(openDBRequest.error);
        });
    }

    private backendPromise?: Promise<CryptoStore>;
    private backend?: CryptoStore;

    /**
     * Create a new IndexedDBCryptoStore
     *
     * @param indexedDB -  global indexedDB instance
     * @param dbName -   name of db to connect to
     */
    public constructor(
        private readonly indexedDB: IDBFactory,
        private readonly dbName: string,
    ) {}

    /**
     * Returns true if this CryptoStore has ever been initialised (ie, it might contain data).
     *
     * Implementation of {@link CryptoStore.containsData}.
     *
     * @internal
     */
    public async containsData(): Promise<boolean> {
        return IndexedDBCryptoStore.exists(this.indexedDB, this.dbName);
    }

    /**
     * Ensure the database exists and is up-to-date, or fall back to
     * a local storage or in-memory store.
     *
     * This must be called before the store can be used.
     *
     * @returns resolves to either an IndexedDBCryptoStoreBackend.Backend,
     * or a MemoryCryptoStore
     */
    public startup(): Promise<CryptoStore> {
        if (this.backendPromise) {
            return this.backendPromise;
        }

        this.backendPromise = new Promise<CryptoStore>((resolve, reject) => {
            if (!this.indexedDB) {
                reject(new Error("no indexeddb support available"));
                return;
            }

            logger.log(`connecting to indexeddb ${this.dbName}`);

            const req = this.indexedDB.open(this.dbName, IndexedDBCryptoStoreBackend.VERSION);

            req.onupgradeneeded = (ev): void => {
                const db = req.result;
                const oldVersion = ev.oldVersion;
                IndexedDBCryptoStoreBackend.upgradeDatabase(db, oldVersion);
            };

            req.onblocked = (): void => {
                logger.log(`can't yet open IndexedDBCryptoStore because it is open elsewhere`);
            };

            req.onerror = (ev): void => {
                logger.log("Error connecting to indexeddb", ev);
                reject(req.error);
            };

            req.onsuccess = (): void => {
                const db = req.result;

                logger.log(`connected to indexeddb ${this.dbName}`);
                resolve(new IndexedDBCryptoStoreBackend.Backend(db));
            };
        })
            .then((backend) => {
                // Edge has IndexedDB but doesn't support compund keys which we use fairly extensively.
                // Try a dummy query which will fail if the browser doesn't support compund keys, so
                // we can fall back to a different backend.
                return backend
                    .doTxn(
                        "readonly",
                        [
                            IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS,
                            IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS_WITHHELD,
                        ],
                        (txn) => {
                            backend.getEndToEndInboundGroupSession("", "", txn, () => {});
                        },
                    )
                    .then(() => backend);
            })
            .catch((e) => {
                if (e.name === "VersionError") {
                    logger.warn("Crypto DB is too new for us to use!", e);
                    // don't fall back to a different store: the user has crypto data
                    // in this db so we should use it or nothing at all.
                    throw new InvalidCryptoStoreError(InvalidCryptoStoreState.TooNew);
                }
                logger.warn(
                    `unable to connect to indexeddb ${this.dbName}` + `: falling back to localStorage store: ${e}`,
                );

                try {
                    return new LocalStorageCryptoStore(globalThis.localStorage);
                } catch (e) {
                    logger.warn(`unable to open localStorage: falling back to in-memory store: ${e}`);
                    return new MemoryCryptoStore();
                }
            })
            .then((backend) => {
                this.backend = backend;
                return backend;
            });

        return this.backendPromise;
    }

    /**
     * Delete all data from this store.
     *
     * @returns resolves when the store has been cleared.
     */
    public deleteAllData(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (!this.indexedDB) {
                reject(new Error("no indexeddb support available"));
                return;
            }

            logger.log(`Removing indexeddb instance: ${this.dbName}`);
            const req = this.indexedDB.deleteDatabase(this.dbName);

            req.onblocked = (): void => {
                logger.log(`can't yet delete IndexedDBCryptoStore because it is open elsewhere`);
            };

            req.onerror = (ev): void => {
                logger.log("Error deleting data from indexeddb", ev);
                reject(req.error);
            };

            req.onsuccess = (): void => {
                logger.log(`Removed indexeddb instance: ${this.dbName}`);
                resolve();
            };
        }).catch((e) => {
            // in firefox, with indexedDB disabled, this fails with a
            // DOMError. We treat this as non-fatal, so that people can
            // still use the app.
            logger.warn(`unable to delete IndexedDBCryptoStore: ${e}`);
        });
    }

    /**
     * Get data on how much of the libolm to Rust Crypto migration has been done.
     *
     * Implementation of {@link CryptoStore.getMigrationState}.
     *
     * @internal
     */
    public getMigrationState(): Promise<MigrationState> {
        return this.backend!.getMigrationState();
    }

    /**
     * Set data on how much of the libolm to Rust Crypto migration has been done.
     *
     * Implementation of {@link CryptoStore.setMigrationState}.
     *
     * @internal
     */
    public setMigrationState(migrationState: MigrationState): Promise<void> {
        return this.backend!.setMigrationState(migrationState);
    }

    // Olm Account

    /*
     * Get the account pickle from the store.
     * This requires an active transaction. See doTxn().
     *
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with the account pickle
     */
    public getAccount(txn: IDBTransaction, func: (accountPickle: string | null) => void): void {
        this.backend!.getAccount(txn, func);
    }

    /**
     * Write the account pickle to the store.
     * This requires an active transaction. See doTxn().
     *
     * @param txn - An active transaction. See doTxn().
     * @param accountPickle - The new account pickle to store.
     */
    public storeAccount(txn: IDBTransaction, accountPickle: string): void {
        this.backend!.storeAccount(txn, accountPickle);
    }

    /**
     * Get the public part of the cross-signing keys (eg. self-signing key,
     * user signing key).
     *
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with the account keys object:
     *        `{ key_type: base64 encoded seed }` where key type = user_signing_key_seed or self_signing_key_seed
     */
    public getCrossSigningKeys(
        txn: IDBTransaction,
        func: (keys: Record<string, CrossSigningKeyInfo> | null) => void,
    ): void {
        this.backend!.getCrossSigningKeys(txn, func);
    }

    /**
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with the private key
     * @param type - A key type
     */
    public getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: IDBTransaction,
        func: (key: SecretStorePrivateKeys[K] | null) => void,
        type: K,
    ): void {
        this.backend!.getSecretStorePrivateKey(txn, func, type);
    }

    /**
     * Write the cross-signing private keys back to the store
     *
     * @param txn - An active transaction. See doTxn().
     * @param type - The type of cross-signing private key to store
     * @param key - keys object as getCrossSigningKeys()
     */
    public storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: IDBTransaction,
        type: K,
        key: SecretStorePrivateKeys[K],
    ): void {
        this.backend!.storeSecretStorePrivateKey(txn, type, key);
    }

    // Olm sessions

    /**
     * Returns the number of end-to-end sessions in the store
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with the count of sessions
     */
    public countEndToEndSessions(txn: IDBTransaction, func: (count: number) => void): void {
        this.backend!.countEndToEndSessions(txn, func);
    }

    /**
     * Retrieve a specific end-to-end session between the logged-in user
     * and another device.
     * @param deviceKey - The public key of the other device.
     * @param sessionId - The ID of the session to retrieve
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with A map from sessionId
     *     to session information object with 'session' key being the
     *     Base64 end-to-end session and lastReceivedMessageTs being the
     *     timestamp in milliseconds at which the session last received
     *     a message.
     */
    public getEndToEndSession(
        deviceKey: string,
        sessionId: string,
        txn: IDBTransaction,
        func: (session: ISessionInfo | null) => void,
    ): void {
        this.backend!.getEndToEndSession(deviceKey, sessionId, txn, func);
    }

    /**
     * Retrieve the end-to-end sessions between the logged-in user and another
     * device.
     * @param deviceKey - The public key of the other device.
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with A map from sessionId
     *     to session information object with 'session' key being the
     *     Base64 end-to-end session and lastReceivedMessageTs being the
     *     timestamp in milliseconds at which the session last received
     *     a message.
     */
    public getEndToEndSessions(
        deviceKey: string,
        txn: IDBTransaction,
        func: (sessions: { [sessionId: string]: ISessionInfo }) => void,
    ): void {
        this.backend!.getEndToEndSessions(deviceKey, txn, func);
    }

    /**
     * Store a session between the logged-in user and another device
     * @param deviceKey - The public key of the other device.
     * @param sessionId - The ID for this end-to-end session.
     * @param sessionInfo - Session information object
     * @param txn - An active transaction. See doTxn().
     */
    public storeEndToEndSession(
        deviceKey: string,
        sessionId: string,
        sessionInfo: ISessionInfo,
        txn: IDBTransaction,
    ): void {
        this.backend!.storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn);
    }

    /**
     * Count the number of Megolm sessions in the database.
     *
     * Implementation of {@link CryptoStore.countEndToEndInboundGroupSessions}.
     *
     * @internal
     */
    public countEndToEndInboundGroupSessions(): Promise<number> {
        return this.backend!.countEndToEndInboundGroupSessions();
    }

    /**
     * Fetch a batch of Olm sessions from the database.
     *
     * Implementation of {@link CryptoStore.getEndToEndSessionsBatch}.
     *
     * @internal
     */
    public getEndToEndSessionsBatch(): Promise<null | ISessionInfo[]> {
        return this.backend!.getEndToEndSessionsBatch();
    }

    /**
     * Delete a batch of Olm sessions from the database.
     *
     * Implementation of {@link CryptoStore.deleteEndToEndSessionsBatch}.
     *
     * @internal
     */
    public deleteEndToEndSessionsBatch(sessions: { deviceKey: string; sessionId: string }[]): Promise<void> {
        return this.backend!.deleteEndToEndSessionsBatch(sessions);
    }

    // Inbound group sessions

    /**
     * Retrieve the end-to-end inbound group session for a given
     * server key and session ID
     * @param senderCurve25519Key - The sender's curve 25519 key
     * @param sessionId - The ID of the session
     * @param txn - An active transaction. See doTxn().
     * @param func - Called with A map from sessionId
     *     to Base64 end-to-end session.
     */
    public getEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        txn: IDBTransaction,
        func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void,
    ): void {
        this.backend!.getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func);
    }

    /**
     * Writes an end-to-end inbound group session to the store.
     * If there already exists an inbound group session with the same
     * senderCurve25519Key and sessionID, it will be overwritten.
     * @param senderCurve25519Key - The sender's curve 25519 key
     * @param sessionId - The ID of the session
     * @param sessionData - The session data structure
     * @param txn - An active transaction. See doTxn().
     */
    public storeEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: IDBTransaction,
    ): void {
        this.backend!.storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn);
    }

    /**
     * Fetch a batch of Megolm sessions from the database.
     *
     * Implementation of {@link CryptoStore.getEndToEndInboundGroupSessionsBatch}.
     *
     * @internal
     */
    public getEndToEndInboundGroupSessionsBatch(): Promise<SessionExtended[] | null> {
        return this.backend!.getEndToEndInboundGroupSessionsBatch();
    }

    /**
     * Delete a batch of Megolm sessions from the database.
     *
     * Implementation of {@link CryptoStore.deleteEndToEndInboundGroupSessionsBatch}.
     *
     * @internal
     */
    public deleteEndToEndInboundGroupSessionsBatch(
        sessions: { senderKey: string; sessionId: string }[],
    ): Promise<void> {
        return this.backend!.deleteEndToEndInboundGroupSessionsBatch(sessions);
    }

    /**
     * Get an object of `roomId->roomInfo` for all e2e rooms in the store
     * @param txn - An active transaction. See doTxn().
     * @param func - Function called with the end-to-end encrypted rooms
     */
    public getEndToEndRooms(txn: IDBTransaction, func: (rooms: Record<string, IRoomEncryption>) => void): void {
        this.backend!.getEndToEndRooms(txn, func);
    }

    /**
     * Mark sessions as needing to be backed up.
     * @param sessions - The sessions that need to be backed up.
     * @param txn - An active transaction. See doTxn(). (optional)
     * @returns resolves when the sessions are marked
     */
    public markSessionsNeedingBackup(sessions: ISession[], txn?: IDBTransaction): Promise<void> {
        return this.backend!.markSessionsNeedingBackup(sessions, txn);
    }

    /**
     * Perform a transaction on the crypto store. Any store methods
     * that require a transaction (txn) object to be passed in may
     * only be called within a callback of either this function or
     * one of the store functions operating on the same transaction.
     *
     * @param mode - 'readwrite' if you need to call setter
     *     functions with this transaction. Otherwise, 'readonly'.
     * @param stores - List IndexedDBCryptoStore.STORE_*
     *     options representing all types of object that will be
     *     accessed or written to with this transaction.
     * @param func - Function called with the
     *     transaction object: an opaque object that should be passed
     *     to store functions.
     * @param log - A possibly customised log
     * @returns Promise that resolves with the result of the `func`
     *     when the transaction is complete. If the backend is
     *     async (ie. the indexeddb backend) any of the callback
     *     functions throwing an exception will cause this promise to
     *     reject with that exception. On synchronous backends, the
     *     exception will propagate to the caller of the getFoo method.
     */
    public doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn: IDBTransaction) => T, log?: Logger): Promise<T> {
        return this.backend!.doTxn<T>(mode, stores, func as (txn: unknown) => T, log);
    }
}
