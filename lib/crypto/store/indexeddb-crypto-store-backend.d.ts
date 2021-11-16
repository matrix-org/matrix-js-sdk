import { PrefixedLogger } from '../../logger';
import { CryptoStore, IDeviceData, IProblem, ISession, ISessionInfo, IWithheld, Mode, OutgoingRoomKeyRequest } from "./base";
import { IRoomKeyRequestBody } from "../index";
import { ICrossSigningKey } from "../../client";
import { IOlmDevice } from "../algorithms/megolm";
import { IRoomEncryption } from "../RoomList";
import { InboundGroupSessionData } from "../OlmDevice";
import { IEncryptedPayload } from "../aes";
export declare const VERSION = 10;
/**
 * Implementation of a CryptoStore which is backed by an existing
 * IndexedDB connection. Generally you want IndexedDBCryptoStore
 * which connects to the database and defers to one of these.
 *
 * @implements {module:crypto/store/base~CryptoStore}
 */
export declare class Backend implements CryptoStore {
    private db;
    private nextTxnId;
    /**
     * @param {IDBDatabase} db
     */
    constructor(db: IDBDatabase);
    startup(): Promise<CryptoStore>;
    deleteAllData(): Promise<void>;
    /**
     * Look for an existing outgoing room key request, and if none is found,
     * add a new one
     *
     * @param {module:crypto/store/base~OutgoingRoomKeyRequest} request
     *
     * @returns {Promise} resolves to
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}: either the
     *    same instance as passed in, or the existing one.
     */
    getOrAddOutgoingRoomKeyRequest(request: OutgoingRoomKeyRequest): Promise<OutgoingRoomKeyRequest>;
    /**
     * Look for an existing room key request
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    existing request to look for
     *
     * @return {Promise} resolves to the matching
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    not found
     */
    getOutgoingRoomKeyRequest(requestBody: IRoomKeyRequestBody): Promise<OutgoingRoomKeyRequest | null>;
    /**
     * look for an existing room key request in the db
     *
     * @private
     * @param {IDBTransaction} txn  database transaction
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    existing request to look for
     * @param {Function} callback  function to call with the results of the
     *    search. Either passed a matching
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    not found.
     */
    private _getOutgoingRoomKeyRequest;
    /**
     * Look for room key requests by state
     *
     * @param {Array<Number>} wantedStates list of acceptable states
     *
     * @return {Promise} resolves to the a
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    there are no pending requests in those states. If there are multiple
     *    requests in those states, an arbitrary one is chosen.
     */
    getOutgoingRoomKeyRequestByState(wantedStates: number[]): Promise<OutgoingRoomKeyRequest | null>;
    /**
     *
     * @param {Number} wantedState
     * @return {Promise<Array<*>>} All elements in a given state
     */
    getAllOutgoingRoomKeyRequestsByState(wantedState: number): Promise<OutgoingRoomKeyRequest[]>;
    getOutgoingRoomKeyRequestsByTarget(userId: string, deviceId: string, wantedStates: number[]): Promise<OutgoingRoomKeyRequest[]>;
    /**
     * Look for an existing room key request by id and state, and update it if
     * found
     *
     * @param {string} requestId      ID of request to update
     * @param {number} expectedState  state we expect to find the request in
     * @param {Object} updates        name/value map of updates to apply
     *
     * @returns {Promise} resolves to
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
     *    updated request, or null if no matching row was found
     */
    updateOutgoingRoomKeyRequest(requestId: string, expectedState: number, updates: Partial<OutgoingRoomKeyRequest>): Promise<OutgoingRoomKeyRequest | null>;
    /**
     * Look for an existing room key request by id and state, and delete it if
     * found
     *
     * @param {string} requestId      ID of request to update
     * @param {number} expectedState  state we expect to find the request in
     *
     * @returns {Promise} resolves once the operation is completed
     */
    deleteOutgoingRoomKeyRequest(requestId: string, expectedState: number): Promise<OutgoingRoomKeyRequest | null>;
    getAccount(txn: IDBTransaction, func: (accountPickle: string) => void): void;
    storeAccount(txn: IDBTransaction, accountPickle: string): void;
    getCrossSigningKeys(txn: IDBTransaction, func: (keys: Record<string, ICrossSigningKey>) => void): void;
    getSecretStorePrivateKey(txn: IDBTransaction, func: (key: IEncryptedPayload | null) => void, type: string): void;
    storeCrossSigningKeys(txn: IDBTransaction, keys: Record<string, ICrossSigningKey>): void;
    storeSecretStorePrivateKey(txn: IDBTransaction, type: string, key: IEncryptedPayload): void;
    countEndToEndSessions(txn: IDBTransaction, func: (count: number) => void): void;
    getEndToEndSessions(deviceKey: string, txn: IDBTransaction, func: (sessions: {
        [sessionId: string]: ISessionInfo;
    }) => void): void;
    getEndToEndSession(deviceKey: string, sessionId: string, txn: IDBTransaction, func: (sessions: {
        [sessionId: string]: ISessionInfo;
    }) => void): void;
    getAllEndToEndSessions(txn: IDBTransaction, func: (session: ISessionInfo) => void): void;
    storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: IDBTransaction): void;
    storeEndToEndSessionProblem(deviceKey: string, type: string, fixed: boolean): Promise<void>;
    getEndToEndSessionProblem(deviceKey: string, timestamp: number): Promise<IProblem | null>;
    filterOutNotifiedErrorDevices(devices: IOlmDevice[]): Promise<IOlmDevice[]>;
    getEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, txn: IDBTransaction, func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void): void;
    getAllEndToEndInboundGroupSessions(txn: IDBTransaction, func: (session: ISession | null) => void): void;
    addEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, sessionData: InboundGroupSessionData, txn: IDBTransaction): void;
    storeEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, sessionData: InboundGroupSessionData, txn: IDBTransaction): void;
    storeEndToEndInboundGroupSessionWithheld(senderCurve25519Key: string, sessionId: string, sessionData: IWithheld, txn: IDBTransaction): void;
    getEndToEndDeviceData(txn: IDBTransaction, func: (deviceData: IDeviceData | null) => void): void;
    storeEndToEndDeviceData(deviceData: IDeviceData, txn: IDBTransaction): void;
    storeEndToEndRoom(roomId: string, roomInfo: IRoomEncryption, txn: IDBTransaction): void;
    getEndToEndRooms(txn: IDBTransaction, func: (rooms: Record<string, IRoomEncryption>) => void): void;
    getSessionsNeedingBackup(limit: number): Promise<ISession[]>;
    countSessionsNeedingBackup(txn?: IDBTransaction): Promise<number>;
    unmarkSessionsNeedingBackup(sessions: ISession[], txn?: IDBTransaction): Promise<void>;
    markSessionsNeedingBackup(sessions: ISession[], txn?: IDBTransaction): Promise<void>;
    addSharedHistoryInboundGroupSession(roomId: string, senderKey: string, sessionId: string, txn?: IDBTransaction): void;
    getSharedHistoryInboundGroupSessions(roomId: string, txn?: IDBTransaction): Promise<[senderKey: string, sessionId: string][]>;
    doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn: IDBTransaction) => T, log?: PrefixedLogger): Promise<T>;
}
export declare function upgradeDatabase(db: IDBDatabase, oldVersion: number): void;
//# sourceMappingURL=indexeddb-crypto-store-backend.d.ts.map