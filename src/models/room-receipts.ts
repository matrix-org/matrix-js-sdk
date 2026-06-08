/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import {
    type CachedReceipt,
    MAIN_ROOM_TIMELINE,
    type Receipt,
    type ReceiptCache,
    type ReceiptContent,
    ReceiptType,
    type WrappedReceipt,
} from "../@types/read_receipts.ts";
import { inMainTimelineForReceipt, threadIdForReceipt } from "../client.ts";
import { type Room, RoomEvent } from "./room.ts";
import { MatrixEvent } from "./event.ts";
import { EventType } from "../@types/event.ts";
import { logger } from "../logger.ts";
import { isSupportedReceiptType } from "../utils.ts";

/**
 * Create a synthetic receipt for the given event.
 * @param userId - The user ID of the receipt sender
 * @param event - The event that is to be acknowledged
 * @param receiptType - The type of receipt
 * @param unthreaded - the receipt is unthreaded
 * @returns a new event with the synthetic receipt in it
 */
export function synthesizeReceipt(
    userId: string,
    event: MatrixEvent,
    receiptType: ReceiptType,
    unthreaded = false,
): MatrixEvent {
    return new MatrixEvent({
        content: {
            [event.getId()!]: {
                [receiptType]: {
                    [userId]: {
                        ts: event.getTs(),
                        ...(!unthreaded && { thread_id: threadIdForReceipt(event) }),
                    },
                },
            },
        },
        type: EventType.Receipt,
        room_id: event.getRoomId(),
    });
}

/**
 * Compute the event a user has read up to, by combining their public
 * `m.read` and private `m.read.private` receipts. Private wins on a tie,
 * matching the legacy `ReadReceipt.getLatestReceipt` precedence.
 *
 * The receipt is validated via `findEventById` (whose scope is the caller's
 * choice — Room searches all timelines, Thread only its own).
 */
export function computeEventReadUpTo(
    room: Room,
    findEventById: (eventId: string) => MatrixEvent | undefined,
    getReceiptForType: (receiptType: ReceiptType) => WrappedReceipt | null,
): string | null {
    const publicRead = getReceiptForType(ReceiptType.Read);
    const privateRead = getReceiptForType(ReceiptType.ReadPrivate);

    let latest: WrappedReceipt | null;
    if (publicRead && privateRead) {
        const ordering =
            room.getUnfilteredTimelineSet().compareEventOrdering(publicRead.eventId, privateRead.eventId) ??
            publicRead.data.ts - privateRead.data.ts;
        // private wins on tie or unknown ordering
        latest = ordering > 0 ? publicRead : privateRead;
    } else {
        latest = privateRead ?? publicRead ?? null;
    }

    if (!latest) return null;
    return receiptPointsAtConsistentEvent(latest, findEventById) ? latest.eventId : null;
}

/**
 * Returns true if the event pointed at by this receipt exists, and its
 * threadRootId is consistent with the thread information in the receipt.
 */
function receiptPointsAtConsistentEvent(
    receipt: WrappedReceipt,
    findEventById: (eventId: string) => MatrixEvent | undefined,
): boolean {
    const event = findEventById(receipt.eventId);
    if (!event) {
        // The receipt points at an event we don't have — treat as if absent.
        return false;
    }

    if (!receipt.data?.thread_id) {
        // Unthreaded receipt: no further validation needed.
        return true;
    }

    if (receipt.data.thread_id === MAIN_ROOM_TIMELINE) {
        if (inMainTimelineForReceipt(event)) {
            return true;
        }
    } else if (event.threadRootId === receipt.data.thread_id) {
        return true;
    }

    logger.warn(
        `Ignoring receipt because its thread_id (${receipt.data.thread_id}) disagrees ` +
            `with the thread root (${event.threadRootId}) of the referenced event ` +
            `(event ID = ${receipt.eventId})`,
    );
    return false;
}

/**
 * The latest receipts we have for a room.
 */
export class RoomReceipts {
    private room: Room;
    private threadedReceipts: ThreadedReceipts;
    private unthreadedReceipts: ReceiptsByUser;
    private danglingReceipts: DanglingReceipts;
    /**
     * Reverse index mapping eventId → cached receipts pointing at that event.
     * One entry per (userId, receiptType) per event, mirroring the
     * `receiptCacheByEventId` invariants from `ReadReceipt`.
     */
    private receiptsByEventId: ReceiptCache;
    /**
     * Forward index: latest cached eventId per `${userId}|${receiptType}`.
     * Used to evict stale reverse-index entries when a user's effective receipt
     * moves to a different event — including across the dangling/loaded boundary.
     */
    private currentEventByUserType: Map<string, string>;
    /** Oldest non-main threaded receipt timestamp per user (only used for the current user in practice). */
    private oldestThreadedReceiptTsByUser: Map<string, number>;
    /**
     * Latest unthreaded receipt per user, by ts. Tracked independently of the
     * `unthreadedReceipts` storage so callers see receipts whose event isn't
     * loaded yet — matching the legacy ts-based map this replaces.
     */
    private latestUnthreadedByUser: Map<string, Receipt>;

    public constructor(room: Room) {
        this.room = room;
        this.receiptsByEventId = new Map();
        this.currentEventByUserType = new Map();
        const cache = new ReverseReceiptCache(this.receiptsByEventId, this.currentEventByUserType);
        this.threadedReceipts = new ThreadedReceipts(room, cache);
        this.unthreadedReceipts = new ReceiptsByUser(room, cache);
        this.danglingReceipts = new DanglingReceipts(cache);
        this.oldestThreadedReceiptTsByUser = new Map();
        this.latestUnthreadedByUser = new Map();
        // We listen for timeline events so we can process dangling receipts
        room.on(RoomEvent.Timeline, this.onTimelineEvent);
    }

    /**
     * Remember the receipt information supplied. For each receipt:
     *
     * If we don't have the event for this receipt, store it as "dangling" so we
     * can process it later.
     *
     * Otherwise store it per-user in either the threaded store for its
     * thread_id, or the unthreaded store if there is no thread_id.
     *
     * Ignores any receipt that is before an existing receipt for the same user
     * (in the same thread, if applicable). "Before" is defined by the
     * unfilteredTimelineSet of the room.
     */
    public add(receiptContent: ReceiptContent, synthetic: boolean): void {
        /*
            Transform this structure:
            {
              "$EVENTID": {
                "m.read|m.read.private": {
                  "@user:example.org": {
                    "ts": 1661,
                    "thread_id": "main|$THREAD_ROOT_ID" // or missing/undefined for an unthreaded receipt
                  }
                }
              },
              ...
            }
            into maps of:
            threaded :: threadid :: userId :: ReceiptInfo
            unthreaded :: userId :: ReceiptInfo
            dangling :: eventId :: DanglingReceipt
        */
        for (const [eventId, eventReceipt] of Object.entries(receiptContent)) {
            for (const [receiptType, receiptsByUser] of Object.entries(eventReceipt)) {
                for (const [userId, receipt] of Object.entries(receiptsByUser)) {
                    // Side-effect tracking runs unconditionally, so dangling
                    // receipts are still visible via getOldestThreadedReceiptTs
                    // and getLastUnthreadedReceiptFor.
                    if (receipt.thread_id && receipt.thread_id !== MAIN_ROOM_TIMELINE) {
                        this.trackOldestThreadedReceipt(userId, receipt);
                    }
                    if (!receipt.thread_id) {
                        this.trackLatestUnthreaded(userId, receipt);
                    }

                    if (receipt.thread_id) {
                        // Threaded receipts go straight into the thread bucket: we
                        // already know which thread they belong to from the
                        // receipt itself, so they don't need to wait for the
                        // referenced event to arrive. This makes them visible to
                        // `getReadReceiptForUserIdInThread` immediately, matching
                        // the legacy `cachedThreadReadReceipts` behaviour.
                        this.threadedReceipts.set(receipt.thread_id, eventId, receiptType, userId, receipt, synthetic);
                    } else if (!this.room.findEventById(eventId)) {
                        // Unthreaded receipts that point at an event we don't
                        // have yet are deferred: we can't tell which thread the
                        // event belongs to (for `hasUserReadEvent`'s
                        // `threadIdForReceipt` step) until it arrives.
                        this.danglingReceipts.add(
                            new DanglingReceipt(eventId, receiptType, userId, receipt, synthetic),
                        );
                    } else {
                        this.unthreadedReceipts.set(eventId, receiptType, userId, receipt, synthetic);
                    }
                }
            }
        }
    }

    /**
     * Look for dangling receipts for the given event ID, and add them to the
     * threaded or unthreaded receipts store now that we know which event they
     * point at.
     */
    private onTimelineEvent = (event: MatrixEvent): void => {
        const eventId = event.getId();
        if (!eventId) return;

        const danglingReceipts = this.danglingReceipts.remove(eventId);

        danglingReceipts?.forEach((danglingReceipt) => {
            // Only unthreaded receipts are ever deferred — see `add` above.
            // Side-effect tracking already ran when the receipt was first added;
            // we only need to push it into unthreadedReceipts now.
            this.unthreadedReceipts.set(
                eventId,
                danglingReceipt.receiptType,
                danglingReceipt.userId,
                danglingReceipt.receipt,
                danglingReceipt.synthetic,
            );
        });
    };

    private trackOldestThreadedReceipt(userId: string, receipt: Receipt): void {
        const prior = this.oldestThreadedReceiptTsByUser.get(userId);
        if (prior === undefined || receipt.ts < prior) {
            this.oldestThreadedReceiptTsByUser.set(userId, receipt.ts);
        }
    }

    private trackLatestUnthreaded(userId: string, receipt: Receipt): void {
        const prior = this.latestUnthreadedByUser.get(userId);
        if (!prior || receipt.ts > prior.ts) {
            this.latestUnthreadedByUser.set(userId, receipt);
        }
    }

    public hasUserReadEvent(userId: string, eventId: string): boolean {
        const unthreaded = this.unthreadedReceipts.get(userId);
        if (unthreaded) {
            if (isAfterOrSame(unthreaded.eventId, eventId, this.room)) {
                // The unthreaded receipt is after this event, so we have read it.
                return true;
            }
        }

        const event = this.room.findEventById(eventId);
        if (!event) {
            // We don't know whether the user has read it - default to caution and say no.
            // This shouldn't really happen and feels like it ought to be an exception: let's
            // log a warn for now.
            logger.warn(
                `hasUserReadEvent event ID ${eventId} not found in room ${this.room.roomId}: this shouldn't happen!`,
            );
            return false;
        }

        const threadId = threadIdForReceipt(event);
        const threaded = this.threadedReceipts.get(threadId, userId);
        if (threaded) {
            if (isAfterOrSame(threaded.eventId, eventId, this.room)) {
                // The threaded receipt is after this event, so we have read it.
                return true;
            }
        }

        // TODO: what if they sent the second-last event in the thread?
        if (this.userSentLatestEventInThread(threadId, userId)) {
            // The user sent the latest message in this event's thread, so we
            // consider everything in the thread to be read.
            //
            // Note: maybe we don't need this because synthetic receipts should
            // do this job for us?
            return true;
        }

        // Neither of the receipts were after the event, so it's unread.
        return false;
    }

    /**
     * @returns true if the thread with this ID can be found, and the supplied
     *          user sent the latest message in it.
     */
    private userSentLatestEventInThread(threadId: string, userId: string): boolean {
        const timeline =
            threadId === MAIN_ROOM_TIMELINE
                ? this.room.getLiveTimeline().getEvents()
                : this.room.getThread(threadId)?.timeline;

        return !!(timeline && timeline.length > 0 && timeline[timeline.length - 1].getSender() === userId);
    }

    /**
     * Get the list of cached receipts for the given event.
     * Returns receipts in the order they were inserted, with at most one entry
     * per (userId, receiptType) pair.
     */
    public getReceiptsForEvent(eventId: string): CachedReceipt[] {
        return this.receiptsByEventId.get(eventId) ?? [];
    }

    /**
     * Get the cached receipts for an event, restricted to those scoped to the
     * given thread. Used by {@link Thread} to avoid returning receipts from
     * other thread contexts.
     */
    public getReceiptsForEventInThread(eventId: string, threadId: string): CachedReceipt[] {
        return this.getReceiptsForEvent(eventId).filter((r) => receiptIsInThread(r, threadId));
    }

    /**
     * Get the IDs of users that have read up to the given event.
     * Filters to the receipt types matrix-js-sdk considers as "read up to".
     */
    public getUsersReadUpTo(eventId: string): string[] {
        return this.getReceiptsForEvent(eventId)
            .filter((receipt) => isSupportedReceiptType(receipt.type))
            .map((receipt) => receipt.userId);
    }

    /**
     * Like {@link getUsersReadUpTo} but restricted to receipts scoped to the
     * given thread.
     */
    public getUsersReadUpToInThread(eventId: string, threadId: string): string[] {
        return this.getReceiptsForEventInThread(eventId, threadId)
            .filter((receipt) => isSupportedReceiptType(receipt.type))
            .map((receipt) => receipt.userId);
    }

    /**
     * Get the latest receipt for a specific user and (optionally) receipt type,
     * scoped to a thread.
     */
    public getReadReceiptForUserIdInThread(
        threadId: string,
        userId: string,
        ignoreSynthesized = false,
        receiptType: ReceiptType = ReceiptType.Read,
    ): WrappedReceipt | null {
        return this.threadedReceipts.getByReceiptType(threadId, userId, receiptType, ignoreSynthesized);
    }

    /**
     * Get the latest receipt for a specific user and (optionally) receipt type.
     */
    public getReadReceiptForUserId(
        userId: string,
        ignoreSynthesized = false,
        receiptType: ReceiptType = ReceiptType.Read,
    ): WrappedReceipt | null {
        // Look in both the main-thread bucket and unthreaded bucket — together
        // they cover what the legacy `Room` storage held.
        const threaded = this.threadedReceipts.getByReceiptType(
            MAIN_ROOM_TIMELINE,
            userId,
            receiptType,
            ignoreSynthesized,
        );
        const unthreaded = this.unthreadedReceipts.getByReceiptType(userId, receiptType, ignoreSynthesized);
        return pickLater(this.room, threaded, unthreaded);
    }

    /**
     * Get the event a user has read up to in the main timeline + unthreaded scope.
     * Picks the later of the user's `Read` / `ReadPrivate` receipts, preferring
     * `ReadPrivate` on a tie. Returns `null` if the chosen receipt points at
     * an event we don't have, or whose thread doesn't match.
     */
    public getEventReadUpTo(userId: string, ignoreSynthesized = false): string | null {
        const publicRead = this.getReadReceiptForUserId(userId, ignoreSynthesized, ReceiptType.Read);
        const privateRead = this.getReadReceiptForUserId(userId, ignoreSynthesized, ReceiptType.ReadPrivate);

        // Pick the later, preferring private on a tie or when comparison is unknown
        // (matches ReadReceipt.getLatestReceipt semantics).
        let latest: WrappedReceipt | null;
        if (publicRead && privateRead) {
            const ordering = this.room.compareEventOrdering(publicRead.eventId, privateRead.eventId);
            if (ordering === null || ordering === 0) {
                latest = privateRead;
            } else {
                latest = ordering < 0 ? privateRead : publicRead;
            }
            // compareReceipts also falls back to ts when ordering is null — but in
            // ReadReceipt.getLatestReceipt that fallback yields "0" via `a.data.ts - b.data.ts`
            // and then privateRead wins via `!comparison` branch. So our behaviour matches.
        } else {
            latest = privateRead ?? publicRead ?? null;
        }

        if (!latest) return null;
        return this.receiptPointsAtConsistentEvent(latest) ? latest.eventId : null;
    }

    /**
     * Returns true if the event pointed at by this receipt exists, and its
     * threadRootId is consistent with the thread information in the receipt.
     */
    private receiptPointsAtConsistentEvent(receipt: WrappedReceipt): boolean {
        const event = this.room.findEventById(receipt.eventId);
        if (!event) {
            // The receipt points at an event we don't have — treat as if absent.
            return false;
        }

        if (!receipt.data?.thread_id) {
            // Unthreaded receipt: no further validation needed.
            return true;
        }

        if (receipt.data.thread_id === MAIN_ROOM_TIMELINE) {
            if (inMainTimelineForReceipt(event)) {
                return true;
            }
        } else if (event.threadRootId === receipt.data.thread_id) {
            return true;
        }

        logger.warn(
            `Ignoring receipt because its thread_id (${receipt.data.thread_id}) disagrees ` +
                `with the thread root (${event.threadRootId}) of the referenced event ` +
                `(event ID = ${receipt.eventId})`,
        );
        return false;
    }

    /**
     * Get the latest unthreaded receipt for a user, as a raw Receipt.
     * Tracks by ts so that dangling receipts (whose events aren't loaded yet)
     * are still visible to callers — matching the legacy behaviour.
     */
    public getLastUnthreadedReceiptFor(userId: string): Receipt | undefined {
        return this.latestUnthreadedByUser.get(userId);
    }

    /**
     * Find when a client has gained thread capabilities by inspecting the oldest
     * threaded receipt for this user.
     */
    public getOldestThreadedReceiptTs(userId: string): number {
        return this.oldestThreadedReceiptTsByUser.get(userId) ?? Infinity;
    }
}

// --- implementation details ---

/**
 * True if the cached receipt is scoped to the given thread.
 * An unthreaded receipt (no `thread_id`) is treated as belonging to the main
 * timeline.
 */
function receiptIsInThread(receipt: CachedReceipt, threadId: string): boolean {
    const receiptThreadId = receipt.data.thread_id ?? MAIN_ROOM_TIMELINE;
    return receiptThreadId === threadId;
}

/**
 * Pick the later of two WrappedReceipts using timeline ordering with ts fallback.
 * Null inputs are treated as "absent" — the other receipt wins.
 */
function pickLater(room: Room, a: WrappedReceipt | null, b: WrappedReceipt | null): WrappedReceipt | null {
    if (!a) return b;
    if (!b) return a;
    const ordering = room.compareEventOrdering(a.eventId, b.eventId);
    if (ordering !== null) {
        if (ordering === 0) return a;
        return ordering > 0 ? a : b;
    }
    // Unknown ordering — fall back to timestamp.
    return a.data.ts >= b.data.ts ? a : b;
}

/**
 * The information "inside" a receipt once it has been stored inside
 * RoomReceipts - what eventId it refers to, its type, and the raw receipt data.
 *
 * Does not contain userId or threadId since these are stored as keys of the
 * maps in RoomReceipts.
 */
class ReceiptInfo {
    public constructor(
        public eventId: string,
        public receiptType: string,
        public receipt: Receipt,
    ) {}

    public get ts(): number {
        return this.receipt.ts;
    }

    /**
     * Convert to a WrappedReceipt for the public API.
     */
    public toWrapped(): WrappedReceipt {
        return { eventId: this.eventId, data: this.receipt };
    }

    /**
     * Convert to a CachedReceipt for the per-event reverse index.
     */
    public toCached(userId: string): CachedReceipt {
        return { userId, type: this.receiptType as ReceiptType, data: this.receipt };
    }
}

/**
 * Everything we know about a receipt that is "dangling" because we can't find
 * the event to which it refers.
 */
class DanglingReceipt {
    public constructor(
        public eventId: string,
        public receiptType: string,
        public userId: string,
        public receipt: Receipt,
        public synthetic: boolean,
    ) {}
}

/**
 * Maintains the eventId → CachedReceipt[] reverse index, with a forward
 * `(userId, receiptType) → eventId` pointer for fast eviction. Shared by all
 * receipt buckets (threaded, unthreaded, dangling) inside a RoomReceipts.
 */
class ReverseReceiptCache {
    public constructor(
        private receiptsByEventId: ReceiptCache,
        private currentEventByUserType: Map<string, string>,
    ) {}

    /**
     * Record that this user's effective receipt for the given type now points at
     * `newEventId`, with payload `data`. Evicts any prior entry the cache had
     * for (userId, receiptType) at a different event.
     */
    public update(userId: string, receiptType: string, newEventId: string, data: Receipt): void {
        const key = `${userId}|${receiptType}`;
        const oldEventId = this.currentEventByUserType.get(key);

        if (oldEventId && oldEventId !== newEventId) {
            this.evict(oldEventId, userId, receiptType);
        }

        let bucket = this.receiptsByEventId.get(newEventId);
        if (!bucket) {
            bucket = [];
            this.receiptsByEventId.set(newEventId, bucket);
        }

        const existingIdx = bucket.findIndex((r) => r.userId === userId && r.type === receiptType);
        const entry: CachedReceipt = { userId, type: receiptType as ReceiptType, data };
        if (existingIdx >= 0) {
            bucket[existingIdx] = entry;
        } else {
            bucket.push(entry);
        }

        this.currentEventByUserType.set(key, newEventId);
    }

    private evict(eventId: string, userId: string, receiptType: string): void {
        const bucket = this.receiptsByEventId.get(eventId);
        if (!bucket) return;
        const filtered = bucket.filter((r) => r.userId !== userId || r.type !== receiptType);
        if (filtered.length === 0) {
            this.receiptsByEventId.delete(eventId);
        } else {
            this.receiptsByEventId.set(eventId, filtered);
        }
    }
}

/**
 * The per-user storage of receipts, keyed by receipt type.
 *
 * For each receipt type we hold an optional real and synthetic receipt. The
 * invariant is: synthetic is only set if it's strictly later than real.
 */
class UserReceipts {
    private room: Room;

    /** Map of receiptType → {real, synthetic}. */
    private byType: Map<string, { real?: ReceiptInfo; synthetic?: ReceiptInfo }>;

    public constructor(room: Room) {
        this.room = room;
        this.byType = new Map();
    }

    /**
     * Set the real or synthetic receipt for the given receipt type.
     * Preserves the invariant that synthetic only exists if it's strictly later than real.
     */
    public set(synthetic: boolean, receiptInfo: ReceiptInfo): void {
        const entry = this.byType.get(receiptInfo.receiptType) ?? {};
        if (synthetic) {
            entry.synthetic = receiptInfo;
        } else {
            entry.real = receiptInfo;
        }

        if (entry.synthetic && entry.real) {
            if (isAfterOrSame(entry.real.eventId, entry.synthetic.eventId, this.room)) {
                entry.synthetic = undefined;
            }
        }

        this.byType.set(receiptInfo.receiptType, entry);
    }

    /**
     * Return the effective receipt across all types — the latest one,
     * preferring synthetic when it's later than real.
     */
    public get(): ReceiptInfo | undefined {
        let latest: ReceiptInfo | undefined;
        for (const entry of this.byType.values()) {
            const candidate = entry.synthetic ?? entry.real;
            if (!candidate) continue;
            if (!latest) {
                latest = candidate;
                continue;
            }
            const ordering = this.room.compareEventOrdering(latest.eventId, candidate.eventId);
            if (ordering !== null) {
                if (ordering < 0) latest = candidate;
            } else if (candidate.ts > latest.ts) {
                latest = candidate;
            }
        }
        return latest;
    }

    /**
     * Return the effective (real or synthetic, whichever is later) receipt for
     * the given receipt type.
     */
    public getByReceiptType(receiptType: string, ignoreSynthesized = false): ReceiptInfo | undefined {
        const entry = this.byType.get(receiptType);
        if (!entry) return undefined;
        return ignoreSynthesized ? entry.real : (entry.synthetic ?? entry.real);
    }

    /**
     * Return either the real or the synthetic receipt for the given receipt type.
     */
    public getRealOrSynthetic(receiptType: string, synthetic: boolean): ReceiptInfo | undefined {
        const entry = this.byType.get(receiptType);
        if (!entry) return undefined;
        return synthetic ? entry.synthetic : entry.real;
    }
}

/**
 * The latest receipt info we have, either for a single thread, or all the
 * unthreaded receipts for a room.
 *
 * userId: UserReceipts
 */
class ReceiptsByUser {
    private room: Room;
    private cache: ReverseReceiptCache;

    /** map of userId: UserReceipts */
    private data: Map<string, UserReceipts>;

    public constructor(room: Room, cache: ReverseReceiptCache) {
        this.room = room;
        this.cache = cache;
        this.data = new Map<string, UserReceipts>();
    }

    /**
     * Add the supplied receipt to our structure, if it is not earlier than the
     * one we already hold for this user / receipt type.
     */
    public set(eventId: string, receiptType: string, userId: string, receipt: Receipt, synthetic: boolean): void {
        const userReceipts = getOrCreate(this.data, userId, () => new UserReceipts(this.room));

        const existingByKind = userReceipts.getRealOrSynthetic(receiptType, synthetic);
        if (existingByKind && isAfter(existingByKind.eventId, eventId, this.room)) {
            // The new receipt is strictly before the existing one of the same kind - don't store it.
            return;
        }

        userReceipts.set(synthetic, new ReceiptInfo(eventId, receiptType, receipt));

        const newEffective = userReceipts.getByReceiptType(receiptType);
        if (newEffective) {
            this.cache.update(userId, receiptType, newEffective.eventId, newEffective.receipt);
        }
    }

    /**
     * Find the latest receipt we have for this user across all receipt types.
     */
    public get(userId: string): ReceiptInfo | undefined {
        return this.data.get(userId)?.get();
    }

    /**
     * Find the latest receipt of a specific type for this user.
     */
    public getByReceiptType(
        userId: string,
        receiptType: ReceiptType,
        ignoreSynthesized: boolean,
    ): WrappedReceipt | null {
        const info = this.data.get(userId)?.getByReceiptType(receiptType, ignoreSynthesized);
        return info ? info.toWrapped() : null;
    }
}

/**
 * The latest threaded receipts we have for a room.
 */
class ThreadedReceipts {
    private room: Room;
    private cache: ReverseReceiptCache;

    /** map of threadId: ReceiptsByUser */
    private data: Map<string, ReceiptsByUser>;

    public constructor(room: Room, cache: ReverseReceiptCache) {
        this.room = room;
        this.cache = cache;
        this.data = new Map<string, ReceiptsByUser>();
    }

    /**
     * Add the supplied receipt to our structure, if it is not earlier than one
     * we already hold for this user in this thread.
     */
    public set(
        threadId: string,
        eventId: string,
        receiptType: string,
        userId: string,
        receipt: Receipt,
        synthetic: boolean,
    ): void {
        const receiptsByUser = getOrCreate(this.data, threadId, () => new ReceiptsByUser(this.room, this.cache));
        receiptsByUser.set(eventId, receiptType, userId, receipt, synthetic);
    }

    /**
     * Find the latest threaded receipt for the supplied user in the supplied thread.
     *
     * @returns the found receipt info or undefined if we don't have one.
     */
    public get(threadId: string, userId: string): ReceiptInfo | undefined {
        return this.data.get(threadId)?.get(userId);
    }

    /**
     * Find the latest threaded receipt of a specific type for this user.
     */
    public getByReceiptType(
        threadId: string,
        userId: string,
        receiptType: ReceiptType,
        ignoreSynthesized: boolean,
    ): WrappedReceipt | null {
        const byUser = this.data.get(threadId);
        if (!byUser) return null;
        return byUser.getByReceiptType(userId, receiptType, ignoreSynthesized);
    }
}

/**
 * All the receipts that we have received but can't process because we can't
 * find the event they refer to.
 *
 * We hold on to them so we can process them if their event arrives later. To
 * keep the public `receiptsByEventId` index consistent with the legacy
 * behaviour, we also push dangling receipts into the reverse cache (with the
 * per-(userId, type) eviction semantics).
 */
class DanglingReceipts {
    /**
     * eventId: DanglingReceipt[]
     */
    private data = new Map<string, Array<DanglingReceipt>>();

    public constructor(private cache: ReverseReceiptCache) {}

    /**
     * Remember the supplied dangling receipt. Only stores it as the latest if
     * it isn't strictly older (by ts) than an existing dangling receipt for the
     * same (userId, receiptType). Updates the public reverse cache regardless,
     * so consumers see the cached receipts.
     */
    public add(danglingReceipt: DanglingReceipt): void {
        const danglingList = getOrCreate(this.data, danglingReceipt.eventId, () => []);
        danglingList.push(danglingReceipt);

        // We don't have the event yet, so we can't use the timeline for
        // ordering — fall back to ts only.
        this.cache.update(
            danglingReceipt.userId,
            danglingReceipt.receiptType,
            danglingReceipt.eventId,
            danglingReceipt.receipt,
        );
    }

    /**
     * Remove and return the dangling receipts for the given event ID.
     * @param eventId - the event ID to look for
     * @returns the found dangling receipts, or undefined if we don't have one.
     */
    public remove(eventId: string): Array<DanglingReceipt> | undefined {
        const danglingReceipts = this.data.get(eventId);
        this.data.delete(eventId);
        return danglingReceipts;
    }
}

function getOrCreate<K, V>(m: Map<K, V>, key: K, createFn: () => V): V {
    const found = m.get(key);
    if (found) {
        return found;
    } else {
        const created = createFn();
        m.set(key, created);
        return created;
    }
}

/**
 * Is left after right (or the same)?
 *
 * Only returns true if both events can be found, and left is after or the same
 * as right.
 *
 * @returns left \>= right
 */
function isAfterOrSame(leftEventId: string, rightEventId: string, room: Room): boolean {
    const comparison = room.compareEventOrdering(leftEventId, rightEventId);
    return comparison !== null && comparison >= 0;
}

/**
 * Is left strictly after right?
 *
 * Only returns true if both events can be found, and left is strictly after right.
 *
 * @returns left \> right
 */
function isAfter(leftEventId: string, rightEventId: string, room: Room): boolean {
    const comparison = room.compareEventOrdering(leftEventId, rightEventId);
    return comparison !== null && comparison > 0;
}
