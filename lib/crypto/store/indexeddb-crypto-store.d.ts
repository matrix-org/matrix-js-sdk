import { PrefixedLogger } from '../../logger';
import { CryptoStore, IDeviceData, IProblem, ISession, ISessionInfo, IWithheld, Mode, OutgoingRoomKeyRequest } from "./base";
import { IRoomKeyRequestBody } from "../index";
import { ICrossSigningKey } from "../../client";
import { IOlmDevice } from "../algorithms/megolm";
import { IRoomEncryption } from "../RoomList";
import { InboundGroupSessionData } from "../OlmDevice";
import { IEncryptedPayload } from "../aes";
/**
 * Internal module. indexeddb storage for e2e.
 *
 * @module
 */
/**
 * An implementation of CryptoStore, which is normally backed by an indexeddb,
 * but with fallback to MemoryCryptoStore.
 *
 * @implements {module:crypto/store/base~CryptoStore}
 */
export declare class IndexedDBCryptoStore implements CryptoStore {
    private readonly indexedDB;
    private readonly dbName;
    static STORE_ACCOUNT: string;
    static STORE_SESSIONS: string;
    static STORE_INBOUND_GROUP_SESSIONS: string;
    static STORE_INBOUND_GROUP_SESSIONS_WITHHELD: string;
    static STORE_SHARED_HISTORY_INBOUND_GROUP_SESSIONS: string;
    static STORE_DEVICE_DATA: string;
    static STORE_ROOMS: string;
    static STORE_BACKUP: string;
    static exists(indexedDB: IDBFactory, dbName: string): Promise<boolean>;
    private backendPromise;
    private backend;
    /**
     * Create a new IndexedDBCryptoStore
     *
     * @param {IDBFactory} indexedDB  global indexedDB instance
     * @param {string} dbName   name of db to connect to
     */
    constructor(indexedDB: IDBFactory, dbName: string);
    /**
     * Ensure the database exists and is up-to-date, or fall back to
     * a local storage or in-memory store.
     *
     * This must be called before the store can be used.
     *
     * @return {Promise} resolves to either an IndexedDBCryptoStoreBackend.Backend,
     * or a MemoryCryptoStore
     */
    startup(): Promise<CryptoStore>;
    /**
     * Delete all data from this store.
     *
     * @returns {Promise} resolves when the store has been cleared.
     */
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
     * Look for room key requests by state –
     * unlike above, return a list of all entries in one state.
     *
     * @param {Number} wantedState
     * @return {Promise<Array<*>>} Returns an array of requests in the given state
     */
    getAllOutgoingRoomKeyRequestsByState(wantedState: number): Promise<OutgoingRoomKeyRequest[]>;
    /**
     * Look for room key requests by target device and state
     *
     * @param {string} userId Target user ID
     * @param {string} deviceId Target device ID
     * @param {Array<Number>} wantedStates list of acceptable states
     *
     * @return {Promise} resolves to a list of all the
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
     */
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
    /**
     * Write the account pickle to the store.
     * This requires an active transaction. See doTxn().
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {string} accountPickle The new account pickle to store.
     */
    storeAccount(txn: IDBTransaction, accountPickle: string): void;
    /**
     * Get the public part of the cross-signing keys (eg. self-signing key,
     * user signing key).
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(string)} func Called with the account keys object:
     *        { key_type: base64 encoded seed } where key type = user_signing_key_seed or self_signing_key_seed
     */
    getCrossSigningKeys(txn: IDBTransaction, func: (keys: Record<string, ICrossSigningKey>) => void): void;
    /**
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(string)} func Called with the private key
     * @param {string} type A key type
     */
    getSecretStorePrivateKey(txn: IDBTransaction, func: (key: IEncryptedPayload | null) => void, type: string): void;
    /**
     * Write the cross-signing keys back to the store
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {string} keys keys object as getCrossSigningKeys()
     */
    storeCrossSigningKeys(txn: IDBTransaction, keys: Record<string, ICrossSigningKey>): void;
    /**
     * Write the cross-signing private keys back to the store
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {string} type The type of cross-signing private key to store
     * @param {string} key keys object as getCrossSigningKeys()
     */
    storeSecretStorePrivateKey(txn: IDBTransaction, type: string, key: IEncryptedPayload): void;
    /**
     * Returns the number of end-to-end sessions in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(int)} func Called with the count of sessions
     */
    countEndToEndSessions(txn: IDBTransaction, func: (count: number) => void): void;
    /**
     * Retrieve a specific end-to-end session between the logged-in user
     * and another device.
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID of the session to retrieve
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to session information object with 'session' key being the
     *     Base64 end-to-end session and lastReceivedMessageTs being the
     *     timestamp in milliseconds at which the session last received
     *     a message.
     */
    getEndToEndSession(deviceKey: string, sessionId: string, txn: IDBTransaction, func: (sessions: {
        [sessionId: string]: ISessionInfo;
    }) => void): void;
    /**
     * Retrieve the end-to-end sessions between the logged-in user and another
     * device.
     * @param {string} deviceKey The public key of the other device.
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to session information object with 'session' key being the
     *     Base64 end-to-end session and lastReceivedMessageTs being the
     *     timestamp in milliseconds at which the session last received
     *     a message.
     */
    getEndToEndSessions(deviceKey: string, txn: IDBTransaction, func: (sessions: {
        [sessionId: string]: ISessionInfo;
    }) => void): void;
    /**
     * Retrieve all end-to-end sessions
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called one for each session with
     *     an object with, deviceKey, lastReceivedMessageTs, sessionId
     *     and session keys.
     */
    getAllEndToEndSessions(txn: IDBTransaction, func: (session: ISessionInfo) => void): void;
    /**
     * Store a session between the logged-in user and another device
     * @param {string} deviceKey The public key of the other device.
     * @param {string} sessionId The ID for this end-to-end session.
     * @param {string} sessionInfo Session information object
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: IDBTransaction): void;
    storeEndToEndSessionProblem(deviceKey: string, type: string, fixed: boolean): Promise<void>;
    getEndToEndSessionProblem(deviceKey: string, timestamp: number): Promise<IProblem | null>;
    filterOutNotifiedErrorDevices(devices: IOlmDevice[]): Promise<IOlmDevice[]>;
    /**
     * Retrieve the end-to-end inbound group session for a given
     * server key and session ID
     * @param {string} senderCurve25519Key The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called with A map from sessionId
     *     to Base64 end-to-end session.
     */
    getEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, txn: IDBTransaction, func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void): void;
    /**
     * Fetches all inbound group sessions in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(object)} func Called once for each group session
     *     in the store with an object having keys {senderKey, sessionId,
     *     sessionData}, then once with null to indicate the end of the list.
     */
    getAllEndToEndInboundGroupSessions(txn: IDBTransaction, func: (session: ISession | null) => void): void;
    /**
     * Adds an end-to-end inbound group session to the store.
     * If there already exists an inbound group session with the same
     * senderCurve25519Key and sessionID, the session will not be added.
     * @param {string} senderCurve25519Key The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {object} sessionData The session data structure
     * @param {*} txn An active transaction. See doTxn().
     */
    addEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, sessionData: InboundGroupSessionData, txn: IDBTransaction): void;
    /**
     * Writes an end-to-end inbound group session to the store.
     * If there already exists an inbound group session with the same
     * senderCurve25519Key and sessionID, it will be overwritten.
     * @param {string} senderCurve25519Key The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {object} sessionData The session data structure
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, sessionData: InboundGroupSessionData, txn: IDBTransaction): void;
    storeEndToEndInboundGroupSessionWithheld(senderCurve25519Key: string, sessionId: string, sessionData: IWithheld, txn: IDBTransaction): void;
    /**
     * Store the state of all tracked devices
     * This contains devices for each user, a tracking state for each user
     * and a sync token matching the point in time the snapshot represents.
     * These all need to be written out in full each time such that the snapshot
     * is always consistent, so they are stored in one object.
     *
     * @param {Object} deviceData
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndDeviceData(deviceData: IDeviceData, txn: IDBTransaction): void;
    /**
     * Get the state of all tracked devices
     *
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(Object)} func Function called with the
     *     device data
     */
    getEndToEndDeviceData(txn: IDBTransaction, func: (deviceData: IDeviceData | null) => void): void;
    /**
     * Store the end-to-end state for a room.
     * @param {string} roomId The room's ID.
     * @param {object} roomInfo The end-to-end info for the room.
     * @param {*} txn An active transaction. See doTxn().
     */
    storeEndToEndRoom(roomId: string, roomInfo: IRoomEncryption, txn: IDBTransaction): void;
    /**
     * Get an object of roomId->roomInfo for all e2e rooms in the store
     * @param {*} txn An active transaction. See doTxn().
     * @param {function(Object)} func Function called with the end to end encrypted rooms
     */
    getEndToEndRooms(txn: IDBTransaction, func: (rooms: Record<string, IRoomEncryption>) => void): void;
    /**
     * Get the inbound group sessions that need to be backed up.
     * @param {number} limit The maximum number of sessions to retrieve.  0
     * for no limit.
     * @returns {Promise} resolves to an array of inbound group sessions
     */
    getSessionsNeedingBackup(limit: number): Promise<ISession[]>;
    /**
     * Count the inbound group sessions that need to be backed up.
     * @param {*} txn An active transaction. See doTxn(). (optional)
     * @returns {Promise} resolves to the number of sessions
     */
    countSessionsNeedingBackup(txn?: IDBTransaction): Promise<number>;
    /**
     * Unmark sessions as needing to be backed up.
     * @param {Array<object>} sessions The sessions that need to be backed up.
     * @param {*} txn An active transaction. See doTxn(). (optional)
     * @returns {Promise} resolves when the sessions are unmarked
     */
    unmarkSessionsNeedingBackup(sessions: ISession[], txn?: IDBTransaction): Promise<void>;
    /**
     * Mark sessions as needing to be backed up.
     * @param {Array<object>} sessions The sessions that need to be backed up.
     * @param {*} txn An active transaction. See doTxn(). (optional)
     * @returns {Promise} resolves when the sessions are marked
     */
    markSessionsNeedingBackup(sessions: ISession[], txn?: IDBTransaction): Promise<void>;
    /**
     * Add a shared-history group session for a room.
     * @param {string} roomId The room that the key belongs to
     * @param {string} senderKey The sender's curve 25519 key
     * @param {string} sessionId The ID of the session
     * @param {*} txn An active transaction. See doTxn(). (optional)
     */
    addSharedHistoryInboundGroupSession(roomId: string, senderKey: string, sessionId: string, txn?: IDBTransaction): void;
    /**
     * Get the shared-history group session for a room.
     * @param {string} roomId The room that the key belongs to
     * @param {*} txn An active transaction. See doTxn(). (optional)
     * @returns {Promise} Resolves to an array of [senderKey, sessionId]
     */
    getSharedHistoryInboundGroupSessions(roomId: string, txn?: IDBTransaction): Promise<[senderKey: string, sessionId: string][]>;
    /**
     * Perform a transaction on the crypto store. Any store methods
     * that require a transaction (txn) object to be passed in may
     * only be called within a callback of either this function or
     * one of the store functions operating on the same transaction.
     *
     * @param {string} mode 'readwrite' if you need to call setter
     *     functions with this transaction. Otherwise, 'readonly'.
     * @param {string[]} stores List IndexedDBCryptoStore.STORE_*
     *     options representing all types of object that will be
     *     accessed or written to with this transaction.
     * @param {function(*)} func Function called with the
     *     transaction object: an opaque object that should be passed
     *     to store functions.
     * @param {Logger} [log] A possibly customised log
     * @return {Promise} Promise that resolves with the result of the `func`
     *     when the transaction is complete. If the backend is
     *     async (ie. the indexeddb backend) any of the callback
     *     functions throwing an exception will cause this promise to
     *     reject with that exception. On synchronous backends, the
     *     exception will propagate to the caller of the getFoo method.
     */
    doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn: IDBTransaction) => T, log?: PrefixedLogger): Promise<T>;
}
//# sourceMappingURL=indexeddb-crypto-store.d.ts.map