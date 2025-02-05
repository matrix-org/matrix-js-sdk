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

import { safeSet } from "../../utils.ts";
import {
    type CryptoStore,
    type ISession,
    type SessionExtended,
    type ISessionInfo,
    type IWithheld,
    MigrationState,
    type Mode,
    type SecretStorePrivateKeys,
    SESSION_BATCH_SIZE,
    type InboundGroupSessionData,
    type IRoomEncryption,
} from "./base.ts";
import { type CrossSigningKeyInfo } from "../../crypto-api/index.ts";

function encodeSessionKey(senderCurve25519Key: string, sessionId: string): string {
    return encodeURIComponent(senderCurve25519Key) + "/" + encodeURIComponent(sessionId);
}

function decodeSessionKey(key: string): { senderKey: string; sessionId: string } {
    const keyParts = key.split("/");
    const senderKey = decodeURIComponent(keyParts[0]);
    const sessionId = decodeURIComponent(keyParts[1]);
    return { senderKey, sessionId };
}

/**
 * Internal module. in-memory storage for e2e.
 */

export class MemoryCryptoStore implements CryptoStore {
    private migrationState: MigrationState = MigrationState.NOT_STARTED;
    private account: string | null = null;
    private crossSigningKeys: Record<string, CrossSigningKeyInfo> | null = null;
    private privateKeys: Partial<SecretStorePrivateKeys> = {};

    private sessions: { [deviceKey: string]: { [sessionId: string]: ISessionInfo } } = {};
    private inboundGroupSessions: { [sessionKey: string]: InboundGroupSessionData } = {};
    private inboundGroupSessionsWithheld: Record<string, IWithheld> = {};
    // Opaque device data object
    private rooms: { [roomId: string]: IRoomEncryption } = {};
    private sessionsNeedingBackup: { [sessionKey: string]: boolean } = {};

    /**
     * Returns true if this CryptoStore has ever been initialised (ie, it might contain data).
     *
     * Implementation of {@link CryptoStore.containsData}.
     *
     * @internal
     */
    public async containsData(): Promise<boolean> {
        // If it contains anything, it should contain an account.
        return this.account !== null;
    }

    /**
     * Ensure the database exists and is up-to-date.
     *
     * This must be called before the store can be used.
     *
     * @returns resolves to the store.
     */
    public async startup(): Promise<CryptoStore> {
        // No startup work to do for the memory store.
        return this;
    }

    /**
     * Delete all data from this store.
     *
     * @returns Promise which resolves when the store has been cleared.
     */
    public deleteAllData(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Get data on how much of the libolm to Rust Crypto migration has been done.
     *
     * Implementation of {@link CryptoStore.getMigrationState}.
     *
     * @internal
     */
    public async getMigrationState(): Promise<MigrationState> {
        return this.migrationState;
    }

    /**
     * Set data on how much of the libolm to Rust Crypto migration has been done.
     *
     * Implementation of {@link CryptoStore.setMigrationState}.
     *
     * @internal
     */
    public async setMigrationState(migrationState: MigrationState): Promise<void> {
        this.migrationState = migrationState;
    }

    // Olm Account

    public getAccount(txn: unknown, func: (accountPickle: string | null) => void): void {
        func(this.account);
    }

    public storeAccount(txn: unknown, accountPickle: string): void {
        this.account = accountPickle;
    }

    public getCrossSigningKeys(txn: unknown, func: (keys: Record<string, CrossSigningKeyInfo> | null) => void): void {
        func(this.crossSigningKeys);
    }

    public getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        func: (key: SecretStorePrivateKeys[K] | null) => void,
        type: K,
    ): void {
        const result = this.privateKeys[type] as SecretStorePrivateKeys[K] | undefined;
        func(result || null);
    }

    public storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        type: K,
        key: SecretStorePrivateKeys[K],
    ): void {
        this.privateKeys[type] = key;
    }

    // Olm Sessions

    public countEndToEndSessions(txn: unknown, func: (count: number) => void): void {
        let count = 0;
        for (const deviceSessions of Object.values(this.sessions)) {
            count += Object.keys(deviceSessions).length;
        }
        func(count);
    }

    public getEndToEndSession(
        deviceKey: string,
        sessionId: string,
        txn: unknown,
        func: (session: ISessionInfo) => void,
    ): void {
        const deviceSessions = this.sessions[deviceKey] || {};
        func(deviceSessions[sessionId] || null);
    }

    public getEndToEndSessions(
        deviceKey: string,
        txn: unknown,
        func: (sessions: { [sessionId: string]: ISessionInfo }) => void,
    ): void {
        func(this.sessions[deviceKey] || {});
    }

    public storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: unknown): void {
        let deviceSessions = this.sessions[deviceKey];
        if (deviceSessions === undefined) {
            deviceSessions = {};
            this.sessions[deviceKey] = deviceSessions;
        }
        safeSet(deviceSessions, sessionId, sessionInfo);
    }

    /**
     * Fetch a batch of Olm sessions from the database.
     *
     * Implementation of {@link CryptoStore.getEndToEndSessionsBatch}.
     *
     * @internal
     */
    public async getEndToEndSessionsBatch(): Promise<null | ISessionInfo[]> {
        const result: ISessionInfo[] = [];
        for (const deviceSessions of Object.values(this.sessions)) {
            for (const session of Object.values(deviceSessions)) {
                result.push(session);
                if (result.length >= SESSION_BATCH_SIZE) {
                    return result;
                }
            }
        }

        if (result.length === 0) {
            // No sessions left.
            return null;
        }

        // There are fewer sessions than the batch size; return the final batch of sessions.
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
        for (const { deviceKey, sessionId } of sessions) {
            const deviceSessions = this.sessions[deviceKey] || {};
            delete deviceSessions[sessionId];
            if (Object.keys(deviceSessions).length === 0) {
                // No more sessions for this device.
                delete this.sessions[deviceKey];
            }
        }
    }

    // Inbound Group Sessions

    public getEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        txn: unknown,
        func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void,
    ): void {
        const k = encodeSessionKey(senderCurve25519Key, sessionId);
        func(this.inboundGroupSessions[k] || null, this.inboundGroupSessionsWithheld[k] || null);
    }

    public storeEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void {
        const k = encodeSessionKey(senderCurve25519Key, sessionId);
        this.inboundGroupSessions[k] = sessionData;
    }

    /**
     * Count the number of Megolm sessions in the database.
     *
     * Implementation of {@link CryptoStore.countEndToEndInboundGroupSessions}.
     *
     * @internal
     */
    public async countEndToEndInboundGroupSessions(): Promise<number> {
        return Object.keys(this.inboundGroupSessions).length;
    }

    /**
     * Fetch a batch of Megolm sessions from the database.
     *
     * Implementation of {@link CryptoStore.getEndToEndInboundGroupSessionsBatch}.
     *
     * @internal
     */
    public async getEndToEndInboundGroupSessionsBatch(): Promise<null | SessionExtended[]> {
        const result: SessionExtended[] = [];
        for (const [key, session] of Object.entries(this.inboundGroupSessions)) {
            result.push({
                ...decodeSessionKey(key),
                sessionData: session,
                needsBackup: key in this.sessionsNeedingBackup,
            });
            if (result.length >= SESSION_BATCH_SIZE) {
                return result;
            }
        }

        if (result.length === 0) {
            // No sessions left.
            return null;
        }

        // There are fewer sessions than the batch size; return the final batch of sessions.
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
        for (const { senderKey, sessionId } of sessions) {
            const k = encodeSessionKey(senderKey, sessionId);
            delete this.inboundGroupSessions[k];
        }
    }

    // E2E rooms

    public getEndToEndRooms(txn: unknown, func: (rooms: Record<string, IRoomEncryption>) => void): void {
        func(this.rooms);
    }

    public markSessionsNeedingBackup(sessions: ISession[]): Promise<void> {
        for (const session of sessions) {
            const sessionKey = encodeSessionKey(session.senderKey, session.sessionId);
            this.sessionsNeedingBackup[sessionKey] = true;
        }
        return Promise.resolve();
    }

    // Session key backups

    public doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn?: unknown) => T): Promise<T> {
        return Promise.resolve(func(null));
    }
}
