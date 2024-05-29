/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { IRoomKeyRequestBody, IRoomKeyRequestRecipient } from "../index";
import { RoomKeyRequestState } from "../OutgoingRoomKeyRequestManager";
import { IOlmDevice } from "../algorithms/megolm";
import { TrackingStatus } from "../DeviceList";
import { IRoomEncryption } from "../RoomList";
import { IDevice } from "../deviceinfo";
import { ICrossSigningInfo } from "../CrossSigning";
import { Logger } from "../../logger";
import { InboundGroupSessionData } from "../OlmDevice";
import { MatrixEvent } from "../../models/event";
import { DehydrationManager } from "../dehydration";
import { IEncryptedPayload } from "../aes";
import { CrossSigningKeyInfo } from "../../crypto-api";

/**
 * Internal module. Definitions for storage for the crypto module
 */

export interface SecretStorePrivateKeys {
    "dehydration": {
        keyInfo: DehydrationManager["keyInfo"];
        key: IEncryptedPayload;
        deviceDisplayName: string;
        time: number;
    } | null;
    "m.megolm_backup.v1": IEncryptedPayload;
}

/**
 * Abstraction of things that can store data required for end-to-end encryption
 */
export interface CryptoStore {
    /**
     * Returns true if this CryptoStore has ever been initialised (ie, it might contain data).
     *
     * Unlike the rest of the methods in this interface, can be called before {@link CryptoStore#startup}.
     *
     * @internal
     */
    containsData(): Promise<boolean>;

    /**
     * Initialise this crypto store.
     *
     * Typically, this involves provisioning storage, and migrating any existing data to the current version of the
     * storage schema where appropriate.
     *
     * Must be called before any of the rest of the methods in this interface.
     */
    startup(): Promise<CryptoStore>;

    deleteAllData(): Promise<void>;

    /**
     * Get data on how much of the libolm to Rust Crypto migration has been done.
     *
     * @internal
     */
    getMigrationState(): Promise<MigrationState>;

    /**
     * Set data on how much of the libolm to Rust Crypto migration has been done.
     *
     * @internal
     */
    setMigrationState(migrationState: MigrationState): Promise<void>;

    getOrAddOutgoingRoomKeyRequest(request: OutgoingRoomKeyRequest): Promise<OutgoingRoomKeyRequest>;
    getOutgoingRoomKeyRequest(requestBody: IRoomKeyRequestBody): Promise<OutgoingRoomKeyRequest | null>;
    getOutgoingRoomKeyRequestByState(wantedStates: number[]): Promise<OutgoingRoomKeyRequest | null>;
    getAllOutgoingRoomKeyRequestsByState(wantedState: number): Promise<OutgoingRoomKeyRequest[]>;
    getOutgoingRoomKeyRequestsByTarget(
        userId: string,
        deviceId: string,
        wantedStates: number[],
    ): Promise<OutgoingRoomKeyRequest[]>;
    updateOutgoingRoomKeyRequest(
        requestId: string,
        expectedState: number,
        updates: Partial<OutgoingRoomKeyRequest>,
    ): Promise<OutgoingRoomKeyRequest | null>;
    deleteOutgoingRoomKeyRequest(requestId: string, expectedState: number): Promise<OutgoingRoomKeyRequest | null>;

    // Olm Account
    getAccount(txn: unknown, func: (accountPickle: string | null) => void): void;
    storeAccount(txn: unknown, accountPickle: string): void;
    getCrossSigningKeys(txn: unknown, func: (keys: Record<string, CrossSigningKeyInfo> | null) => void): void;
    getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        func: (key: SecretStorePrivateKeys[K] | null) => void,
        type: K,
    ): void;
    storeCrossSigningKeys(txn: unknown, keys: Record<string, CrossSigningKeyInfo>): void;
    storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        type: K,
        key: SecretStorePrivateKeys[K],
    ): void;

    // Olm Sessions
    countEndToEndSessions(txn: unknown, func: (count: number) => void): void;
    getEndToEndSession(
        deviceKey: string,
        sessionId: string,
        txn: unknown,
        func: (session: ISessionInfo | null) => void,
    ): void;
    getEndToEndSessions(
        deviceKey: string,
        txn: unknown,
        func: (sessions: { [sessionId: string]: ISessionInfo }) => void,
    ): void;
    getAllEndToEndSessions(txn: unknown, func: (session: ISessionInfo | null) => void): void;
    storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: unknown): void;
    storeEndToEndSessionProblem(deviceKey: string, type: string, fixed: boolean): Promise<void>;
    getEndToEndSessionProblem(deviceKey: string, timestamp: number): Promise<IProblem | null>;
    filterOutNotifiedErrorDevices(devices: IOlmDevice[]): Promise<IOlmDevice[]>;

    /**
     * Get a batch of end-to-end sessions from the database.
     *
     * @returns A batch of Olm Sessions, or `null` if no sessions are left.
     * @internal
     */
    getEndToEndSessionsBatch(): Promise<ISessionInfo[] | null>;

    /**
     * Delete a batch of end-to-end sessions from the database.
     *
     * Any sessions in the list which are not found are silently ignored.
     *
     * @internal
     */
    deleteEndToEndSessionsBatch(sessions: { deviceKey?: string; sessionId?: string }[]): Promise<void>;

    // Inbound Group Sessions
    getEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        txn: unknown,
        func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void,
    ): void;
    getAllEndToEndInboundGroupSessions(txn: unknown, func: (session: ISession | null) => void): void;
    addEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void;
    storeEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void;
    storeEndToEndInboundGroupSessionWithheld(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: IWithheld,
        txn: unknown,
    ): void;

    /**
     * Count the number of Megolm sessions in the database.
     *
     * @internal
     */
    countEndToEndInboundGroupSessions(): Promise<number>;

    /**
     * Get a batch of Megolm sessions from the database.
     *
     * @returns A batch of Megolm Sessions, or `null` if no sessions are left.
     * @internal
     */
    getEndToEndInboundGroupSessionsBatch(): Promise<SessionExtended[] | null>;

    /**
     * Delete a batch of Megolm sessions from the database.
     *
     * Any sessions in the list which are not found are silently ignored.
     *
     * @internal
     */
    deleteEndToEndInboundGroupSessionsBatch(sessions: { senderKey: string; sessionId: string }[]): Promise<void>;

    // Device Data
    getEndToEndDeviceData(txn: unknown, func: (deviceData: IDeviceData | null) => void): void;
    storeEndToEndDeviceData(deviceData: IDeviceData, txn: unknown): void;
    storeEndToEndRoom(roomId: string, roomInfo: IRoomEncryption, txn: unknown): void;
    getEndToEndRooms(txn: unknown, func: (rooms: Record<string, IRoomEncryption>) => void): void;
    getSessionsNeedingBackup(limit: number): Promise<ISession[]>;
    countSessionsNeedingBackup(txn?: unknown): Promise<number>;
    unmarkSessionsNeedingBackup(sessions: ISession[], txn?: unknown): Promise<void>;
    markSessionsNeedingBackup(sessions: ISession[], txn?: unknown): Promise<void>;
    addSharedHistoryInboundGroupSession(roomId: string, senderKey: string, sessionId: string, txn?: unknown): void;
    getSharedHistoryInboundGroupSessions(
        roomId: string,
        txn?: unknown,
    ): Promise<[senderKey: string, sessionId: string][]>;
    addParkedSharedHistory(roomId: string, data: ParkedSharedHistory, txn?: unknown): void;
    takeParkedSharedHistory(roomId: string, txn?: unknown): Promise<ParkedSharedHistory[]>;

    // Session key backups
    doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn: unknown) => T, log?: Logger): Promise<T>;
}

export type Mode = "readonly" | "readwrite";

/** Data on a Megolm session */
export interface ISession {
    senderKey: string;
    sessionId: string;
    sessionData?: InboundGroupSessionData;
}

/** Extended data on a Megolm session */
export interface SessionExtended extends ISession {
    needsBackup: boolean;
}

/** Data on an Olm session */
export interface ISessionInfo {
    deviceKey?: string;
    sessionId?: string;
    session?: string;
    lastReceivedMessageTs?: number;
}

export interface IDeviceData {
    devices: {
        [userId: string]: {
            [deviceId: string]: IDevice;
        };
    };
    trackingStatus: {
        [userId: string]: TrackingStatus;
    };
    crossSigningInfo?: Record<string, ICrossSigningInfo>;
    syncToken?: string;
}

export interface IProblem {
    type: string;
    fixed: boolean;
    time: number;
}

export interface IWithheld {
    // eslint-disable-next-line camelcase
    room_id: string;
    code: string;
    reason: string;
}

/**
 * Represents an outgoing room key request
 */
export interface OutgoingRoomKeyRequest {
    /**
     * Unique id for this request. Used for both an id within the request for later pairing with a cancellation,
     * and for the transaction id when sending the to_device messages to our local server.
     */
    requestId: string;
    requestTxnId?: string;
    /**
     * Transaction id for the cancellation, if any
     */
    cancellationTxnId?: string;
    /**
     * List of recipients for the request
     */
    recipients: IRoomKeyRequestRecipient[];
    /**
     * Parameters for the request
     */
    requestBody: IRoomKeyRequestBody;
    /**
     * current state of this request
     */
    state: RoomKeyRequestState;
}

export interface ParkedSharedHistory {
    senderId: string;
    senderKey: string;
    sessionId: string;
    sessionKey: string;
    keysClaimed: ReturnType<MatrixEvent["getKeysClaimed"]>; // XXX: Less type dependence on MatrixEvent
    forwardingCurve25519KeyChain: string[];
}

/**
 * Keys for the `account` object store to store the migration state.
 * Values are defined in `MigrationState`.
 * @internal
 */
export const ACCOUNT_OBJECT_KEY_MIGRATION_STATE = "migrationState";

/**
 * A record of which steps have been completed in the libolm to Rust Crypto migration.
 *
 * Used by {@link CryptoStore#getMigrationState} and {@link CryptoStore#setMigrationState}.
 *
 * @internal
 */
export enum MigrationState {
    /** No migration steps have yet been completed. */
    NOT_STARTED,

    /** We have migrated the account data, cross-signing keys, etc. */
    INITIAL_DATA_MIGRATED,

    /** INITIAL_DATA_MIGRATED, and in addition, we have migrated all the Olm sessions. */
    OLM_SESSIONS_MIGRATED,

    /** OLM_SESSIONS_MIGRATED, and in addition, we have migrated all the Megolm sessions. */
    MEGOLM_SESSIONS_MIGRATED,

    /** MEGOLM_SESSIONS_MIGRATED, and in addition, we have migrated all the room settings. */
    ROOM_SETTINGS_MIGRATED,

    /** ROOM_SETTINGS_MIGRATED, and in addition, we have done the first own keys query in order to
     * load the public part of the keys that have been migrated */
    INITIAL_OWN_KEY_QUERY_DONE,
}

/**
 * The size of batches to be returned by {@link CryptoStore#getEndToEndSessionsBatch} and
 * {@link CryptoStore#getEndToEndInboundGroupSessionsBatch}.
 */
export const SESSION_BATCH_SIZE = 50;
