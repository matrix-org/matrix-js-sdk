import { ISavedSync } from "./index";
import { IStartClientOpts } from "../client";
import { IEvent, ISyncResponse } from "..";
import { IIndexedDBBackend, UserTuple } from "./indexeddb-backend";
export declare class RemoteIndexedDBStoreBackend implements IIndexedDBBackend {
    private readonly workerFactory;
    private readonly dbName;
    private worker;
    private nextSeq;
    private inFlight;
    private startPromise;
    /**
     * An IndexedDB store backend where the actual backend sits in a web
     * worker.
     *
     * Construct a new Indexed Database store backend. This requires a call to
     * <code>connect()</code> before this store can be used.
     * @constructor
     * @param {Function} workerFactory Factory which produces a Worker
     * @param {string=} dbName Optional database name. The same name must be used
     * to open the same database.
     */
    constructor(workerFactory: () => Worker, dbName: string);
    /**
     * Attempt to connect to the database. This can fail if the user does not
     * grant permission.
     * @return {Promise} Resolves if successfully connected.
     */
    connect(): Promise<void>;
    /**
     * Clear the entire database. This should be used when logging out of a client
     * to prevent mixing data between accounts.
     * @return {Promise} Resolved when the database is cleared.
     */
    clearDatabase(): Promise<void>;
    /** @return {Promise<boolean>} whether or not the database was newly created in this session. */
    isNewlyCreated(): Promise<boolean>;
    /**
     * @return {Promise} Resolves with a sync response to restore the
     * client state to where it was at the last save, or null if there
     * is no saved sync data.
     */
    getSavedSync(): Promise<ISavedSync>;
    getNextBatchToken(): Promise<string>;
    setSyncData(syncData: ISyncResponse): Promise<void>;
    syncToDatabase(userTuples: UserTuple[]): Promise<void>;
    /**
     * Returns the out-of-band membership events for this room that
     * were previously loaded.
     * @param {string} roomId
     * @returns {event[]} the events, potentially an empty array if OOB loading didn't yield any new members
     * @returns {null} in case the members for this room haven't been stored yet
     */
    getOutOfBandMembers(roomId: string): Promise<IEvent[] | null>;
    /**
     * Stores the out-of-band membership events for this room. Note that
     * it still makes sense to store an empty array as the OOB status for the room is
     * marked as fetched, and getOutOfBandMembers will return an empty array instead of null
     * @param {string} roomId
     * @param {event[]} membershipEvents the membership events to store
     * @returns {Promise} when all members have been stored
     */
    setOutOfBandMembers(roomId: string, membershipEvents: IEvent[]): Promise<void>;
    clearOutOfBandMembers(roomId: string): Promise<void>;
    getClientOptions(): Promise<IStartClientOpts>;
    storeClientOptions(options: IStartClientOpts): Promise<void>;
    /**
     * Load all user presence events from the database. This is not cached.
     * @return {Promise<Object[]>} A list of presence events in their raw form.
     */
    getUserPresenceEvents(): Promise<UserTuple[]>;
    private ensureStarted;
    private doCmd;
    private onWorkerMessage;
}
//# sourceMappingURL=indexeddb-remote-backend.d.ts.map