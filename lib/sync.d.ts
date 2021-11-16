import { Room } from "./models/room";
import { Group } from "./models/group";
import { IStoredClientOpts, MatrixClient } from "./client";
import { SyncState } from "./sync.api";
import { MatrixEvent } from "./models/event";
export interface ISyncStateData {
    error?: Error;
    oldSyncToken?: string;
    nextSyncToken?: string;
    catchingUp?: boolean;
    fromCache?: boolean;
}
/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @constructor
 * @param {MatrixClient} client The matrix client instance to use.
 * @param {Object} opts Config options
 * @param {module:crypto=} opts.crypto Crypto manager
 * @param {Function=} opts.canResetEntireTimeline A function which is called
 * with a room ID and returns a boolean. It should return 'true' if the SDK can
 * SAFELY remove events from this room. It may not be safe to remove events if
 * there are other references to the timelines for this room.
 * Default: returns false.
 * @param {Boolean=} opts.disablePresence True to perform syncing without automatically
 * updating presence.
 */
export declare class SyncApi {
    private readonly client;
    private readonly opts;
    private _peekRoom;
    private currentSyncRequest;
    private syncState;
    private syncStateData;
    private catchingUp;
    private running;
    private keepAliveTimer;
    private connectionReturnedDefer;
    private notifEvents;
    private failedSyncCount;
    private storeIsInvalid;
    constructor(client: MatrixClient, opts?: Partial<IStoredClientOpts>);
    /**
     * @param {string} roomId
     * @return {Room}
     */
    createRoom(roomId: string): Room;
    /**
     * @param {string} groupId
     * @return {Group}
     */
    createGroup(groupId: string): Group;
    /**
     * @param {Room} room
     * @private
     */
    private registerStateListeners;
    /**
     * @param {Room} room
     * @private
     */
    private deregisterStateListeners;
    /**
     * Sync rooms the user has left.
     * @return {Promise} Resolved when they've been added to the store.
     */
    syncLeftRooms(): Promise<any[]>;
    /**
     * Split events between the ones that will end up in the main
     * room timeline versus the one that need to be processed in a thread
     * @experimental
     */
    partitionThreadedEvents(events: MatrixEvent[]): [MatrixEvent[], MatrixEvent[]];
    /**
     * Peek into a room. This will result in the room in question being synced so it
     * is accessible via getRooms(). Live updates for the room will be provided.
     * @param {string} roomId The room ID to peek into.
     * @return {Promise} A promise which resolves once the room has been added to the
     * store.
     */
    peek(roomId: string): Promise<Room>;
    /**
     * Stop polling for updates in the peeked room. NOPs if there is no room being
     * peeked.
     */
    stopPeeking(): void;
    /**
     * Do a peek room poll.
     * @param {Room} peekRoom
     * @param {string?} token from= token
     */
    private peekPoll;
    /**
     * Returns the current state of this sync object
     * @see module:client~MatrixClient#event:"sync"
     * @return {?String}
     */
    getSyncState(): SyncState;
    /**
     * Returns the additional data object associated with
     * the current sync state, or null if there is no
     * such data.
     * Sync errors, if available, are put in the 'error' key of
     * this object.
     * @return {?Object}
     */
    getSyncStateData(): ISyncStateData;
    recoverFromSyncStartupError(savedSyncPromise: Promise<void>, err: Error): Promise<void>;
    /**
     * Is the lazy loading option different than in previous session?
     * @param {boolean} lazyLoadMembers current options for lazy loading
     * @return {boolean} whether or not the option has changed compared to the previous session */
    private wasLazyLoadingToggled;
    private shouldAbortSync;
    /**
     * Main entry point
     */
    sync(): void;
    /**
     * Stops the sync object from syncing.
     */
    stop(): void;
    /**
     * Retry a backed off syncing request immediately. This should only be used when
     * the user <b>explicitly</b> attempts to retry their lost connection.
     * @return {boolean} True if this resulted in a request being retried.
     */
    retryImmediately(): boolean;
    /**
     * Process a single set of cached sync data.
     * @param {Object} savedSync a saved sync that was persisted by a store. This
     * should have been acquired via client.store.getSavedSync().
     */
    private syncFromCache;
    /**
     * Invoke me to do /sync calls
     * @param {Object} syncOptions
     * @param {string} syncOptions.filterId
     * @param {boolean} syncOptions.hasSyncedBefore
     */
    private doSync;
    private doSyncRequest;
    private getSyncParams;
    private onSyncError;
    /**
     * Process data returned from a sync response and propagate it
     * into the model objects
     *
     * @param {Object} syncEventData Object containing sync tokens associated with this sync
     * @param {Object} data The response from /sync
     */
    private processSyncResponse;
    /**
     * Starts polling the connectivity check endpoint
     * @param {number} delay How long to delay until the first poll.
     *        defaults to a short, randomised interval (to prevent
     *        tightlooping if /versions succeeds but /sync etc. fail).
     * @return {promise} which resolves once the connection returns
     */
    private startKeepAlives;
    /**
     * Make a dummy call to /_matrix/client/versions, to see if the HS is
     * reachable.
     *
     * On failure, schedules a call back to itself. On success, resolves
     * this.connectionReturnedDefer.
     *
     * @param {boolean} connDidFail True if a connectivity failure has been detected. Optional.
     */
    private pokeKeepAlive;
    /**
     * @param {Object} groupsSection Groups section object, eg. response.groups.invite
     * @param {string} sectionName Which section this is ('invite', 'join' or 'leave')
     */
    private processGroupSyncEntry;
    /**
     * @param {Object} obj
     * @return {Object[]}
     */
    private mapSyncResponseToRoomArray;
    /**
     * @param {Object} obj
     * @param {Room} room
     * @param {boolean} decrypt
     * @return {MatrixEvent[]}
     */
    private mapSyncEventsFormat;
    /**
     * @param {Room} room
     */
    private resolveInvites;
    /**
     * @param {Room} room
     * @param {MatrixEvent[]} stateEventList A list of state events. This is the state
     * at the *START* of the timeline list if it is supplied.
     * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
     * @param {boolean} fromCache whether the sync response came from cache
     * is earlier in time. Higher index is later.
     */
    private processRoomEvents;
    /**
     * @experimental
     */
    private processThreadEvents;
    /**
     * Takes a list of timelineEvents and adds and adds to notifEvents
     * as appropriate.
     * This must be called after the room the events belong to has been stored.
     *
     * @param {Room} room
     * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
     * is earlier in time. Higher index is later.
     */
    private processEventsForNotifs;
    /**
     * @return {string}
     */
    private getGuestFilter;
    /**
     * Sets the sync state and emits an event to say so
     * @param {String} newState The new state string
     * @param {Object} data Object of additional data to emit in the event
     */
    private updateSyncState;
    /**
     * Event handler for the 'online' event
     * This event is generally unreliable and precise behaviour
     * varies between browsers, so we poll for connectivity too,
     * but this might help us reconnect a little faster.
     */
    private onOnline;
}
//# sourceMappingURL=sync.d.ts.map