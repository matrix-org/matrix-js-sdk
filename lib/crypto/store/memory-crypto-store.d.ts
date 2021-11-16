import { CryptoStore, IDeviceData, IProblem, ISession, ISessionInfo, IWithheld, Mode, OutgoingRoomKeyRequest } from "./base";
import { IRoomKeyRequestBody } from "../index";
import { ICrossSigningKey } from "../../client";
import { IOlmDevice } from "../algorithms/megolm";
import { IRoomEncryption } from "../RoomList";
import { InboundGroupSessionData } from "../OlmDevice";
import { IEncryptedPayload } from "../aes";
/**
 * Internal module. in-memory storage for e2e.
 *
 * @module
 */
/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
export declare class MemoryCryptoStore implements CryptoStore {
    private outgoingRoomKeyRequests;
    private account;
    private crossSigningKeys;
    private privateKeys;
    private sessions;
    private sessionProblems;
    private notifiedErrorDevices;
    private inboundGroupSessions;
    private inboundGroupSessionsWithheld;
    private deviceData;
    private rooms;
    private sessionsNeedingBackup;
    private sharedHistoryInboundGroupSessions;
    /**
     * Ensure the database exists and is up-to-date.
     *
     * This must be called before the store can be used.
     *
     * @return {Promise} resolves to the store.
     */
    startup(): Promise<CryptoStore>;
    /**
     * Delete all data from this store.
     *
     * @returns {Promise} Promise which resolves when the store has been cleared.
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
     * Looks for existing room key request, and returns the result synchronously.
     *
     * @internal
     *
     * @param {module:crypto~RoomKeyRequestBody} requestBody
     *    existing request to look for
     *
     * @return {module:crypto/store/base~OutgoingRoomKeyRequest?}
     *    the matching request, or null if not found
     */
    private _getOutgoingRoomKeyRequest;
    /**
     * Look for room key requests by state
     *
     * @param {Array<Number>} wantedStates list of acceptable states
     *
     * @return {Promise} resolves to the a
     *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
     *    there are no pending requests in those states
     */
    getOutgoingRoomKeyRequestByState(wantedStates: number[]): Promise<OutgoingRoomKeyRequest | null>;
    /**
     *
     * @param {Number} wantedState
     * @return {Promise<Array<*>>} All OutgoingRoomKeyRequests in state
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
    getAccount(txn: unknown, func: (accountPickle: string) => void): void;
    storeAccount(txn: unknown, accountPickle: string): void;
    getCrossSigningKeys(txn: unknown, func: (keys: Record<string, ICrossSigningKey>) => void): void;
    getSecretStorePrivateKey(txn: unknown, func: (key: IEncryptedPayload | null) => void, type: string): void;
    storeCrossSigningKeys(txn: unknown, keys: Record<string, ICrossSigningKey>): void;
    storeSecretStorePrivateKey(txn: unknown, type: string, key: IEncryptedPayload): void;
    countEndToEndSessions(txn: unknown, func: (count: number) => void): void;
    getEndToEndSession(deviceKey: string, sessionId: string, txn: unknown, func: (session: ISessionInfo) => void): void;
    getEndToEndSessions(deviceKey: string, txn: unknown, func: (sessions: {
        [sessionId: string]: ISessionInfo;
    }) => void): void;
    getAllEndToEndSessions(txn: unknown, func: (session: ISessionInfo) => void): void;
    storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: unknown): void;
    storeEndToEndSessionProblem(deviceKey: string, type: string, fixed: boolean): Promise<void>;
    getEndToEndSessionProblem(deviceKey: string, timestamp: number): Promise<IProblem | null>;
    filterOutNotifiedErrorDevices(devices: IOlmDevice[]): Promise<IOlmDevice[]>;
    getEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, txn: unknown, func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void): void;
    getAllEndToEndInboundGroupSessions(txn: unknown, func: (session: ISession | null) => void): void;
    addEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, sessionData: InboundGroupSessionData, txn: unknown): void;
    storeEndToEndInboundGroupSession(senderCurve25519Key: string, sessionId: string, sessionData: InboundGroupSessionData, txn: unknown): void;
    storeEndToEndInboundGroupSessionWithheld(senderCurve25519Key: string, sessionId: string, sessionData: IWithheld, txn: unknown): void;
    getEndToEndDeviceData(txn: unknown, func: (deviceData: IDeviceData | null) => void): void;
    storeEndToEndDeviceData(deviceData: IDeviceData, txn: unknown): void;
    storeEndToEndRoom(roomId: string, roomInfo: IRoomEncryption, txn: unknown): void;
    getEndToEndRooms(txn: unknown, func: (rooms: Record<string, IRoomEncryption>) => void): void;
    getSessionsNeedingBackup(limit: number): Promise<ISession[]>;
    countSessionsNeedingBackup(): Promise<number>;
    unmarkSessionsNeedingBackup(sessions: ISession[]): Promise<void>;
    markSessionsNeedingBackup(sessions: ISession[]): Promise<void>;
    addSharedHistoryInboundGroupSession(roomId: string, senderKey: string, sessionId: string): void;
    getSharedHistoryInboundGroupSessions(roomId: string): Promise<[senderKey: string, sessionId: string][]>;
    doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn?: unknown) => T): Promise<T>;
}
//# sourceMappingURL=memory-crypto-store.d.ts.map