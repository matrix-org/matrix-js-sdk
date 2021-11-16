/// <reference types="node" />
/**
 * @module models/room
 */
import { EventEmitter } from "events";
import { EventTimelineSet, DuplicateStrategy } from "./event-timeline-set";
import { EventTimeline } from "./event-timeline";
import { EventStatus, MatrixEvent } from "./event";
import { RoomMember } from "./room-member";
import { IRoomSummary, RoomSummary } from "./room-summary";
import { EventType, RoomType } from "../@types/event";
import { MatrixClient, PendingEventOrdering } from "../client";
import { GuestAccess, HistoryVisibility, JoinRule, ResizeMethod } from "../@types/partials";
import { Filter } from "../filter";
import { RoomState } from "./room-state";
import { Thread } from "./thread";
interface IOpts {
    storageToken?: string;
    pendingEventOrdering?: PendingEventOrdering;
    timelineSupport?: boolean;
    unstableClientRelationAggregation?: boolean;
    lazyLoadMembers?: boolean;
}
export interface IRecommendedVersion {
    version: string;
    needsUpgrade: boolean;
    urgent: boolean;
}
interface IReceipt {
    ts: number;
}
interface ICachedReceipt {
    type: string;
    userId: string;
    data: IReceipt;
}
export declare enum NotificationCountType {
    Highlight = "highlight",
    Total = "total"
}
export declare class Room extends EventEmitter {
    readonly roomId: string;
    readonly client: MatrixClient;
    readonly myUserId: string;
    private readonly opts;
    private readonly reEmitter;
    private txnToEvent;
    private receipts;
    private receiptCacheByEventId;
    private realReceipts;
    private notificationCounts;
    private readonly timelineSets;
    private readonly filteredTimelineSets;
    private readonly pendingEventList?;
    private blacklistUnverifiedDevices;
    private selfMembership;
    private summaryHeroes;
    private getTypeWarning;
    private getVersionWarning;
    private membersPromise?;
    name: string;
    normalizedName: string;
    tags: Record<string, Record<string, any>>;
    accountData: Record<string, MatrixEvent>;
    summary: RoomSummary;
    readonly storageToken?: string;
    timeline: MatrixEvent[];
    oldState: RoomState;
    currentState: RoomState;
    /**
     * @experimental
     */
    threads: Map<string, Thread>;
    /**
     * Construct a new Room.
     *
     * <p>For a room, we store an ordered sequence of timelines, which may or may not
     * be continuous. Each timeline lists a series of events, as well as tracking
     * the room state at the start and the end of the timeline. It also tracks
     * forward and backward pagination tokens, as well as containing links to the
     * next timeline in the sequence.
     *
     * <p>There is one special timeline - the 'live' timeline, which represents the
     * timeline to which events are being added in real-time as they are received
     * from the /sync API. Note that you should not retain references to this
     * timeline - even if it is the current timeline right now, it may not remain
     * so if the server gives us a timeline gap in /sync.
     *
     * <p>In order that we can find events from their ids later, we also maintain a
     * map from event_id to timeline and index.
     *
     * @constructor
     * @alias module:models/room
     * @param {string} roomId Required. The ID of this room.
     * @param {MatrixClient} client Required. The client, used to lazy load members.
     * @param {string} myUserId Required. The ID of the syncing user.
     * @param {Object=} opts Configuration options
     * @param {*} opts.storageToken Optional. The token which a data store can use
     * to remember the state of the room. What this means is dependent on the store
     * implementation.
     *
     * @param {String=} opts.pendingEventOrdering Controls where pending messages
     * appear in a room's timeline. If "<b>chronological</b>", messages will appear
     * in the timeline when the call to <code>sendEvent</code> was made. If
     * "<b>detached</b>", pending messages will appear in a separate list,
     * accessible via {@link module:models/room#getPendingEvents}. Default:
     * "chronological".
     * @param {boolean} [opts.timelineSupport = false] Set to true to enable improved
     * timeline support.
     * @param {boolean} [opts.unstableClientRelationAggregation = false]
     * Optional. Set to true to enable client-side aggregation of event relations
     * via `EventTimelineSet#getRelationsForEvent`.
     * This feature is currently unstable and the API may change without notice.
     *
     * @prop {string} roomId The ID of this room.
     * @prop {string} name The human-readable display name for this room.
     * @prop {string} normalizedName The un-homoglyphed name for this room.
     * @prop {Array<MatrixEvent>} timeline The live event timeline for this room,
     * with the oldest event at index 0. Present for backwards compatibility -
     * prefer getLiveTimeline().getEvents().
     * @prop {object} tags Dict of room tags; the keys are the tag name and the values
     * are any metadata associated with the tag - e.g. { "fav" : { order: 1 } }
     * @prop {object} accountData Dict of per-room account_data events; the keys are the
     * event type and the values are the events.
     * @prop {RoomState} oldState The state of the room at the time of the oldest
     * event in the live timeline. Present for backwards compatibility -
     * prefer getLiveTimeline().getState(EventTimeline.BACKWARDS).
     * @prop {RoomState} currentState The state of the room at the time of the
     * newest event in the timeline. Present for backwards compatibility -
     * prefer getLiveTimeline().getState(EventTimeline.FORWARDS).
     * @prop {RoomSummary} summary The room summary.
     * @prop {*} storageToken A token which a data store can use to remember
     * the state of the room.
     */
    constructor(roomId: string, client: MatrixClient, myUserId: string, opts?: IOpts);
    /**
     * Bulk decrypt critical events in a room
     *
     * Critical events represents the minimal set of events to decrypt
     * for a typical UI to function properly
     *
     * - Last event of every room (to generate likely message preview)
     * - All events up to the read receipt (to calculate an accurate notification count)
     *
     * @returns {Promise} Signals when all events have been decrypted
     */
    decryptCriticalEvents(): Promise<void>;
    /**
     * Bulk decrypt events in a room
     *
     * @returns {Promise} Signals when all events have been decrypted
     */
    decryptAllEvents(): Promise<void>;
    /**
     * Gets the version of the room
     * @returns {string} The version of the room, or null if it could not be determined
     */
    getVersion(): string | null;
    /**
     * Determines whether this room needs to be upgraded to a new version
     * @returns {string?} What version the room should be upgraded to, or null if
     *     the room does not require upgrading at this time.
     * @deprecated Use #getRecommendedVersion() instead
     */
    shouldUpgradeToVersion(): string | null;
    /**
     * Determines the recommended room version for the room. This returns an
     * object with 3 properties: <code>version</code> as the new version the
     * room should be upgraded to (may be the same as the current version);
     * <code>needsUpgrade</code> to indicate if the room actually can be
     * upgraded (ie: does the current version not match?); and <code>urgent</code>
     * to indicate if the new version patches a vulnerability in a previous
     * version.
     * @returns {Promise<{version: string, needsUpgrade: boolean, urgent: boolean}>}
     * Resolves to the version the room should be upgraded to.
     */
    getRecommendedVersion(): Promise<IRecommendedVersion>;
    private checkVersionAgainstCapability;
    /**
     * Determines whether the given user is permitted to perform a room upgrade
     * @param {String} userId The ID of the user to test against
     * @returns {boolean} True if the given user is permitted to upgrade the room
     */
    userMayUpgradeRoom(userId: string): boolean;
    /**
     * Get the list of pending sent events for this room
     *
     * @return {module:models/event.MatrixEvent[]} A list of the sent events
     * waiting for remote echo.
     *
     * @throws If <code>opts.pendingEventOrdering</code> was not 'detached'
     */
    getPendingEvents(): MatrixEvent[];
    /**
     * Removes a pending event for this room
     *
     * @param {string} eventId
     * @return {boolean} True if an element was removed.
     */
    removePendingEvent(eventId: string): boolean;
    /**
     * Check whether the pending event list contains a given event by ID.
     * If pending event ordering is not "detached" then this returns false.
     *
     * @param {string} eventId The event ID to check for.
     * @return {boolean}
     */
    hasPendingEvent(eventId: string): boolean;
    /**
     * Get a specific event from the pending event list, if configured, null otherwise.
     *
     * @param {string} eventId The event ID to check for.
     * @return {MatrixEvent}
     */
    getPendingEvent(eventId: string): MatrixEvent | null;
    /**
     * Get the live unfiltered timeline for this room.
     *
     * @return {module:models/event-timeline~EventTimeline} live timeline
     */
    getLiveTimeline(): EventTimeline;
    /**
     * Get the timestamp of the last message in the room
     *
     * @return {number} the timestamp of the last message in the room
     */
    getLastActiveTimestamp(): number;
    /**
     * @return {string} the membership type (join | leave | invite) for the logged in user
     */
    getMyMembership(): string;
    /**
     * If this room is a DM we're invited to,
     * try to find out who invited us
     * @return {string} user id of the inviter
     */
    getDMInviter(): string;
    /**
     * Assuming this room is a DM room, tries to guess with which user.
     * @return {string} user id of the other member (could be syncing user)
     */
    guessDMUserId(): string;
    getAvatarFallbackMember(): RoomMember;
    /**
     * Sets the membership this room was received as during sync
     * @param {string} membership join | leave | invite
     */
    updateMyMembership(membership: string): void;
    private loadMembersFromServer;
    private loadMembers;
    /**
     * Preloads the member list in case lazy loading
     * of memberships is in use. Can be called multiple times,
     * it will only preload once.
     * @return {Promise} when preloading is done and
     * accessing the members on the room will take
     * all members in the room into account
     */
    loadMembersIfNeeded(): Promise<boolean>;
    /**
     * Removes the lazily loaded members from storage if needed
     */
    clearLoadedMembersIfNeeded(): Promise<void>;
    /**
     * called when sync receives this room in the leave section
     * to do cleanup after leaving a room. Possibly called multiple times.
     */
    private cleanupAfterLeaving;
    /**
     * Reset the live timeline of all timelineSets, and start new ones.
     *
     * <p>This is used when /sync returns a 'limited' timeline.
     *
     * @param {string=} backPaginationToken   token for back-paginating the new timeline
     * @param {string=} forwardPaginationToken token for forward-paginating the old live timeline,
     * if absent or null, all timelines are reset, removing old ones (including the previous live
     * timeline which would otherwise be unable to paginate forwards without this token).
     * Removing just the old live timeline whilst preserving previous ones is not supported.
     */
    resetLiveTimeline(backPaginationToken: string, forwardPaginationToken: string): void;
    /**
     * Fix up this.timeline, this.oldState and this.currentState
     *
     * @private
     */
    private fixUpLegacyTimelineFields;
    /**
     * Returns whether there are any devices in the room that are unverified
     *
     * Note: Callers should first check if crypto is enabled on this device. If it is
     * disabled, then we aren't tracking room devices at all, so we can't answer this, and an
     * error will be thrown.
     *
     * @return {boolean} the result
     */
    hasUnverifiedDevices(): Promise<boolean>;
    /**
     * Return the timeline sets for this room.
     * @return {EventTimelineSet[]} array of timeline sets for this room
     */
    getTimelineSets(): EventTimelineSet[];
    /**
     * Helper to return the main unfiltered timeline set for this room
     * @return {EventTimelineSet} room's unfiltered timeline set
     */
    getUnfilteredTimelineSet(): EventTimelineSet;
    /**
     * Get the timeline which contains the given event from the unfiltered set, if any
     *
     * @param {string} eventId  event ID to look for
     * @return {?module:models/event-timeline~EventTimeline} timeline containing
     * the given event, or null if unknown
     */
    getTimelineForEvent(eventId: string): EventTimeline;
    /**
     * Add a new timeline to this room's unfiltered timeline set
     *
     * @return {module:models/event-timeline~EventTimeline} newly-created timeline
     */
    addTimeline(): EventTimeline;
    /**
     * Get an event which is stored in our unfiltered timeline set or in a thread
     *
     * @param {string} eventId  event ID to look for
     * @return {?module:models/event.MatrixEvent} the given event, or undefined if unknown
     */
    findEventById(eventId: string): MatrixEvent | undefined;
    /**
     * Get one of the notification counts for this room
     * @param {String} type The type of notification count to get. default: 'total'
     * @return {Number} The notification count, or undefined if there is no count
     *                  for this type.
     */
    getUnreadNotificationCount(type?: NotificationCountType): number | undefined;
    /**
     * Set one of the notification counts for this room
     * @param {String} type The type of notification count to set.
     * @param {Number} count The new count
     */
    setUnreadNotificationCount(type: NotificationCountType, count: number): void;
    setSummary(summary: IRoomSummary): void;
    /**
     * Whether to send encrypted messages to devices within this room.
     * @param {Boolean} value true to blacklist unverified devices, null
     * to use the global value for this room.
     */
    setBlacklistUnverifiedDevices(value: boolean): void;
    /**
     * Whether to send encrypted messages to devices within this room.
     * @return {Boolean} true if blacklisting unverified devices, null
     * if the global value should be used for this room.
     */
    getBlacklistUnverifiedDevices(): boolean;
    /**
     * Get the avatar URL for a room if one was set.
     * @param {String} baseUrl The homeserver base URL. See
     * {@link module:client~MatrixClient#getHomeserverUrl}.
     * @param {Number} width The desired width of the thumbnail.
     * @param {Number} height The desired height of the thumbnail.
     * @param {string} resizeMethod The thumbnail resize method to use, either
     * "crop" or "scale".
     * @param {boolean} allowDefault True to allow an identicon for this room if an
     * avatar URL wasn't explicitly set. Default: true. (Deprecated)
     * @return {?string} the avatar URL or null.
     */
    getAvatarUrl(baseUrl: string, width: number, height: number, resizeMethod: ResizeMethod, allowDefault?: boolean): string | null;
    /**
     * Get the mxc avatar url for the room, if one was set.
     * @return {string} the mxc avatar url or falsy
     */
    getMxcAvatarUrl(): string | null;
    /**
     * Get the aliases this room has according to the room's state
     * The aliases returned by this function may not necessarily
     * still point to this room.
     * @return {array} The room's alias as an array of strings
     */
    getAliases(): string[];
    /**
     * Get this room's canonical alias
     * The alias returned by this function may not necessarily
     * still point to this room.
     * @return {?string} The room's canonical alias, or null if there is none
     */
    getCanonicalAlias(): string | null;
    /**
     * Get this room's alternative aliases
     * @return {array} The room's alternative aliases, or an empty array
     */
    getAltAliases(): string[];
    /**
     * Add events to a timeline
     *
     * <p>Will fire "Room.timeline" for each event added.
     *
     * @param {MatrixEvent[]} events A list of events to add.
     *
     * @param {boolean} toStartOfTimeline   True to add these events to the start
     * (oldest) instead of the end (newest) of the timeline. If true, the oldest
     * event will be the <b>last</b> element of 'events'.
     *
     * @param {module:models/event-timeline~EventTimeline} timeline   timeline to
     *    add events to.
     *
     * @param {string=} paginationToken   token for the next batch of events
     *
     * @fires module:client~MatrixClient#event:"Room.timeline"
     *
     */
    addEventsToTimeline(events: MatrixEvent[], toStartOfTimeline: boolean, timeline: EventTimeline, paginationToken?: string): void;
    /**
     * @experimental
     */
    getThread(eventId: string): Thread;
    /**
     * @experimental
     */
    getThreads(): Thread[];
    /**
     * Get a member from the current room state.
     * @param {string} userId The user ID of the member.
     * @return {RoomMember} The member or <code>null</code>.
     */
    getMember(userId: string): RoomMember | null;
    /**
     * Get all currently loaded members from the current
     * room state.
     * @returns {RoomMember[]} Room members
     */
    getMembers(): RoomMember[];
    /**
     * Get a list of members whose membership state is "join".
     * @return {RoomMember[]} A list of currently joined members.
     */
    getJoinedMembers(): RoomMember[];
    /**
     * Returns the number of joined members in this room
     * This method caches the result.
     * This is a wrapper around the method of the same name in roomState, returning
     * its result for the room's current state.
     * @return {number} The number of members in this room whose membership is 'join'
     */
    getJoinedMemberCount(): number;
    /**
     * Returns the number of invited members in this room
     * @return {number} The number of members in this room whose membership is 'invite'
     */
    getInvitedMemberCount(): number;
    /**
     * Returns the number of invited + joined members in this room
     * @return {number} The number of members in this room whose membership is 'invite' or 'join'
     */
    getInvitedAndJoinedMemberCount(): number;
    /**
     * Get a list of members with given membership state.
     * @param {string} membership The membership state.
     * @return {RoomMember[]} A list of members with the given membership state.
     */
    getMembersWithMembership(membership: string): RoomMember[];
    /**
     * Get a list of members we should be encrypting for in this room
     * @return {Promise<RoomMember[]>} A list of members who
     * we should encrypt messages for in this room.
     */
    getEncryptionTargetMembers(): Promise<RoomMember[]>;
    /**
     * Determine whether we should encrypt messages for invited users in this room
     * @return {boolean} if we should encrypt messages for invited users
     */
    shouldEncryptForInvitedMembers(): boolean;
    /**
     * Get the default room name (i.e. what a given user would see if the
     * room had no m.room.name)
     * @param {string} userId The userId from whose perspective we want
     * to calculate the default name
     * @return {string} The default room name
     */
    getDefaultRoomName(userId: string): string;
    /**
     * Check if the given user_id has the given membership state.
     * @param {string} userId The user ID to check.
     * @param {string} membership The membership e.g. <code>'join'</code>
     * @return {boolean} True if this user_id has the given membership state.
     */
    hasMembershipState(userId: string, membership: string): boolean;
    /**
     * Add a timelineSet for this room with the given filter
     * @param {Filter} filter The filter to be applied to this timelineSet
     * @return {EventTimelineSet} The timelineSet
     */
    getOrCreateFilteredTimelineSet(filter: Filter): EventTimelineSet;
    /**
     * Forget the timelineSet for this room with the given filter
     *
     * @param {Filter} filter the filter whose timelineSet is to be forgotten
     */
    removeFilteredTimelineSet(filter: Filter): void;
    findThreadForEvent(event: MatrixEvent): Thread;
    /**
     * Add an event to a thread's timeline. Will fire "Thread.update"
     * @experimental
     */
    addThreadedEvent(event: MatrixEvent): Promise<void>;
    /**
     * Add an event to the end of this room's live timelines. Will fire
     * "Room.timeline".
     *
     * @param {MatrixEvent} event Event to be added
     * @param {string?} duplicateStrategy 'ignore' or 'replace'
     * @param {boolean} fromCache whether the sync response came from cache
     * @fires module:client~MatrixClient#event:"Room.timeline"
     * @private
     */
    private addLiveEvent;
    /**
     * Add a pending outgoing event to this room.
     *
     * <p>The event is added to either the pendingEventList, or the live timeline,
     * depending on the setting of opts.pendingEventOrdering.
     *
     * <p>This is an internal method, intended for use by MatrixClient.
     *
     * @param {module:models/event.MatrixEvent} event The event to add.
     *
     * @param {string} txnId Transaction id for this outgoing event
     *
     * @fires module:client~MatrixClient#event:"Room.localEchoUpdated"
     *
     * @throws if the event doesn't have status SENDING, or we aren't given a
     * unique transaction id.
     */
    addPendingEvent(event: MatrixEvent, txnId: string): void;
    /**
     * Persists all pending events to local storage
     *
     * If the current room is encrypted only encrypted events will be persisted
     * all messages that are not yet encrypted will be discarded
     *
     * This is because the flow of EVENT_STATUS transition is
     * queued => sending => encrypting => sending => sent
     *
     * Steps 3 and 4 are skipped for unencrypted room.
     * It is better to discard an unencrypted message rather than persisting
     * it locally for everyone to read
     */
    private savePendingEvents;
    /**
     * Used to aggregate the local echo for a relation, and also
     * for re-applying a relation after it's redaction has been cancelled,
     * as the local echo for the redaction of the relation would have
     * un-aggregated the relation. Note that this is different from regular messages,
     * which are just kept detached for their local echo.
     *
     * Also note that live events are aggregated in the live EventTimelineSet.
     * @param {module:models/event.MatrixEvent} event the relation event that needs to be aggregated.
     */
    private aggregateNonLiveRelation;
    /**
     * Deal with the echo of a message we sent.
     *
     * <p>We move the event to the live timeline if it isn't there already, and
     * update it.
     *
     * @param {module:models/event.MatrixEvent} remoteEvent   The event received from
     *    /sync
     * @param {module:models/event.MatrixEvent} localEvent    The local echo, which
     *    should be either in the pendingEventList or the timeline.
     *
     * @fires module:client~MatrixClient#event:"Room.localEchoUpdated"
     * @private
     */
    private handleRemoteEcho;
    /**
     * Update the status / event id on a pending event, to reflect its transmission
     * progress.
     *
     * <p>This is an internal method.
     *
     * @param {MatrixEvent} event      local echo event
     * @param {EventStatus} newStatus  status to assign
     * @param {string} newEventId      new event id to assign. Ignored unless
     *    newStatus == EventStatus.SENT.
     * @fires module:client~MatrixClient#event:"Room.localEchoUpdated"
     */
    updatePendingEvent(event: MatrixEvent, newStatus: EventStatus, newEventId?: string): void;
    private revertRedactionLocalEcho;
    /**
     * Add some events to this room. This can include state events, message
     * events and typing notifications. These events are treated as "live" so
     * they will go to the end of the timeline.
     *
     * @param {MatrixEvent[]} events A list of events to add.
     *
     * @param {string} duplicateStrategy Optional. Applies to events in the
     * timeline only. If this is 'replace' then if a duplicate is encountered, the
     * event passed to this function will replace the existing event in the
     * timeline. If this is not specified, or is 'ignore', then the event passed to
     * this function will be ignored entirely, preserving the existing event in the
     * timeline. Events are identical based on their event ID <b>only</b>.
     *
     * @param {boolean} fromCache whether the sync response came from cache
     * @throws If <code>duplicateStrategy</code> is not falsey, 'replace' or 'ignore'.
     */
    addLiveEvents(events: MatrixEvent[], duplicateStrategy?: DuplicateStrategy, fromCache?: boolean): void;
    /**
     * Adds/handles ephemeral events such as typing notifications and read receipts.
     * @param {MatrixEvent[]} events A list of events to process
     */
    addEphemeralEvents(events: MatrixEvent[]): void;
    /**
     * Removes events from this room.
     * @param {String[]} eventIds A list of eventIds to remove.
     */
    removeEvents(eventIds: string[]): void;
    /**
     * Removes a single event from this room.
     *
     * @param {String} eventId  The id of the event to remove
     *
     * @return {boolean} true if the event was removed from any of the room's timeline sets
     */
    removeEvent(eventId: string): boolean;
    /**
     * Recalculate various aspects of the room, including the room name and
     * room summary. Call this any time the room's current state is modified.
     * May fire "Room.name" if the room name is updated.
     * @fires module:client~MatrixClient#event:"Room.name"
     */
    recalculate(): void;
    /**
     * Get a list of user IDs who have <b>read up to</b> the given event.
     * @param {MatrixEvent} event the event to get read receipts for.
     * @return {String[]} A list of user IDs.
     */
    getUsersReadUpTo(event: MatrixEvent): string[];
    /**
     * Get the ID of the event that a given user has read up to, or null if we
     * have received no read receipts from them.
     * @param {String} userId The user ID to get read receipt event ID for
     * @param {Boolean} ignoreSynthesized If true, return only receipts that have been
     *                                    sent by the server, not implicit ones generated
     *                                    by the JS SDK.
     * @return {String} ID of the latest event that the given user has read, or null.
     */
    getEventReadUpTo(userId: string, ignoreSynthesized?: boolean): string | null;
    /**
     * Determines if the given user has read a particular event ID with the known
     * history of the room. This is not a definitive check as it relies only on
     * what is available to the room at the time of execution.
     * @param {String} userId The user ID to check the read state of.
     * @param {String} eventId The event ID to check if the user read.
     * @returns {Boolean} True if the user has read the event, false otherwise.
     */
    hasUserReadEvent(userId: string, eventId: string): boolean;
    /**
     * Get a list of receipts for the given event.
     * @param {MatrixEvent} event the event to get receipts for
     * @return {Object[]} A list of receipts with a userId, type and data keys or
     * an empty list.
     */
    getReceiptsForEvent(event: MatrixEvent): ICachedReceipt[];
    /**
     * Add a receipt event to the room.
     * @param {MatrixEvent} event The m.receipt event.
     * @param {Boolean} fake True if this event is implicit
     */
    addReceipt(event: MatrixEvent, fake?: boolean): void;
    /**
     * Add a receipt event to the room.
     * @param {MatrixEvent} event The m.receipt event.
     * @param {Object} receipts The object to add receipts to
     */
    private addReceiptsToStructure;
    /**
     * Build and return a map of receipts by event ID
     * @param {Object} receipts A map of receipts
     * @return {Object} Map of receipts by event ID
     */
    private buildReceiptCache;
    /**
     * Add a temporary local-echo receipt to the room to reflect in the
     * client the fact that we've sent one.
     * @param {string} userId The user ID if the receipt sender
     * @param {MatrixEvent} e The event that is to be acknowledged
     * @param {string} receiptType The type of receipt
     */
    addLocalEchoReceipt(userId: string, e: MatrixEvent, receiptType: string): void;
    /**
     * Update the room-tag event for the room.  The previous one is overwritten.
     * @param {MatrixEvent} event the m.tag event
     */
    addTags(event: MatrixEvent): void;
    /**
     * Update the account_data events for this room, overwriting events of the same type.
     * @param {Array<MatrixEvent>} events an array of account_data events to add
     */
    addAccountData(events: MatrixEvent[]): void;
    /**
     * Access account_data event of given event type for this room
     * @param {string} type the type of account_data event to be accessed
     * @return {?MatrixEvent} the account_data event in question
     */
    getAccountData(type: EventType | string): MatrixEvent | undefined;
    /**
     * Returns whether the syncing user has permission to send a message in the room
     * @return {boolean} true if the user should be permitted to send
     *                   message events into the room.
     */
    maySendMessage(): boolean;
    /**
     * Returns whether the given user has permissions to issue an invite for this room.
     * @param {string} userId the ID of the Matrix user to check permissions for
     * @returns {boolean} true if the user should be permitted to issue invites for this room.
     */
    canInvite(userId: string): boolean;
    /**
     * Returns the join rule based on the m.room.join_rule state event, defaulting to `invite`.
     * @returns {string} the join_rule applied to this room
     */
    getJoinRule(): JoinRule;
    /**
     * Returns the history visibility based on the m.room.history_visibility state event, defaulting to `shared`.
     * @returns {HistoryVisibility} the history_visibility applied to this room
     */
    getHistoryVisibility(): HistoryVisibility;
    /**
     * Returns the history visibility based on the m.room.history_visibility state event, defaulting to `shared`.
     * @returns {HistoryVisibility} the history_visibility applied to this room
     */
    getGuestAccess(): GuestAccess;
    /**
     * Returns the type of the room from the `m.room.create` event content or undefined if none is set
     * @returns {?string} the type of the room. Currently only RoomType.Space is known.
     */
    getType(): RoomType | string | undefined;
    /**
     * Returns whether the room is a space-room as defined by MSC1772.
     * @returns {boolean} true if the room's type is RoomType.Space
     */
    isSpaceRoom(): boolean;
    /**
     * This is an internal method. Calculates the name of the room from the current
     * room state.
     * @param {string} userId The client's user ID. Used to filter room members
     * correctly.
     * @param {boolean} ignoreRoomNameEvent Return the implicit room name that we'd see if there
     * was no m.room.name event.
     * @return {string} The calculated room name.
     */
    private calculateRoomName;
}
export {};
/**
 * Fires when an event we had previously received is redacted.
 *
 * (Note this is *not* fired when the redaction happens before we receive the
 * event).
 *
 * @event module:client~MatrixClient#"Room.redaction"
 * @param {MatrixEvent} event The matrix redaction event
 * @param {Room} room The room containing the redacted event
 */
/**
 * Fires when an event that was previously redacted isn't anymore.
 * This happens when the redaction couldn't be sent and
 * was subsequently cancelled by the user. Redactions have a local echo
 * which is undone in this scenario.
 *
 * @event module:client~MatrixClient#"Room.redactionCancelled"
 * @param {MatrixEvent} event The matrix redaction event that was cancelled.
 * @param {Room} room The room containing the unredacted event
 */
/**
 * Fires whenever the name of a room is updated.
 * @event module:client~MatrixClient#"Room.name"
 * @param {Room} room The room whose Room.name was updated.
 * @example
 * matrixClient.on("Room.name", function(room){
 *   var newName = room.name;
 * });
 */
/**
 * Fires whenever a receipt is received for a room
 * @event module:client~MatrixClient#"Room.receipt"
 * @param {event} event The receipt event
 * @param {Room} room The room whose receipts was updated.
 * @example
 * matrixClient.on("Room.receipt", function(event, room){
 *   var receiptContent = event.getContent();
 * });
 */
/**
 * Fires whenever a room's tags are updated.
 * @event module:client~MatrixClient#"Room.tags"
 * @param {event} event The tags event
 * @param {Room} room The room whose Room.tags was updated.
 * @example
 * matrixClient.on("Room.tags", function(event, room){
 *   var newTags = event.getContent().tags;
 *   if (newTags["favourite"]) showStar(room);
 * });
 */
/**
 * Fires whenever a room's account_data is updated.
 * @event module:client~MatrixClient#"Room.accountData"
 * @param {event} event The account_data event
 * @param {Room} room The room whose account_data was updated.
 * @param {MatrixEvent} prevEvent The event being replaced by
 * the new account data, if known.
 * @example
 * matrixClient.on("Room.accountData", function(event, room, oldEvent){
 *   if (event.getType() === "m.room.colorscheme") {
 *       applyColorScheme(event.getContents());
 *   }
 * });
 */
/**
 * Fires when the status of a transmitted event is updated.
 *
 * <p>When an event is first transmitted, a temporary copy of the event is
 * inserted into the timeline, with a temporary event id, and a status of
 * 'SENDING'.
 *
 * <p>Once the echo comes back from the server, the content of the event
 * (MatrixEvent.event) is replaced by the complete event from the homeserver,
 * thus updating its event id, as well as server-generated fields such as the
 * timestamp. Its status is set to null.
 *
 * <p>Once the /send request completes, if the remote echo has not already
 * arrived, the event is updated with a new event id and the status is set to
 * 'SENT'. The server-generated fields are of course not updated yet.
 *
 * <p>If the /send fails, In this case, the event's status is set to
 * 'NOT_SENT'. If it is later resent, the process starts again, setting the
 * status to 'SENDING'. Alternatively, the message may be cancelled, which
 * removes the event from the room, and sets the status to 'CANCELLED'.
 *
 * <p>This event is raised to reflect each of the transitions above.
 *
 * @event module:client~MatrixClient#"Room.localEchoUpdated"
 *
 * @param {MatrixEvent} event The matrix event which has been updated
 *
 * @param {Room} room The room containing the redacted event
 *
 * @param {string} oldEventId The previous event id (the temporary event id,
 *    except when updating a successfully-sent event when its echo arrives)
 *
 * @param {EventStatus} oldStatus The previous event status.
 */
/**
 * Fires when the logged in user's membership in the room is updated.
 *
 * @event module:models/room~Room#"Room.myMembership"
 * @param {Room} room The room in which the membership has been updated
 * @param {string} membership The new membership value
 * @param {string} prevMembership The previous membership value
 */
//# sourceMappingURL=room.d.ts.map