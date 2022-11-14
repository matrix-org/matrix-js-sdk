/*
Copyright 2022 The Matrix.org Foundation C.I.C.
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

import { ReceiptType } from "../@types/read_receipts";
import { ListenerMap, TypedEventEmitter } from "./typed-event-emitter";
import * as utils from "../utils";
import { MatrixEvent } from "./event";
import { EventType } from "../@types/event";
import { EventTimelineSet } from "./event-timeline-set";

export const MAIN_ROOM_TIMELINE = "main";

export function synthesizeReceipt(userId: string, event: MatrixEvent, receiptType: ReceiptType): MatrixEvent {
    return new MatrixEvent({
        content: {
            [event.getId()!]: {
                [receiptType]: {
                    [userId]: {
                        ts: event.getTs(),
                        threadId: event.threadRootId ?? MAIN_ROOM_TIMELINE,
                    },
                },
            },
        },
        type: EventType.Receipt,
        room_id: event.getRoomId(),
    });
}

export interface Receipt {
    ts: number;
    thread_id?: string;
}

export interface WrappedReceipt {
    eventId: string;
    data: Receipt;
}

interface CachedReceipt {
    type: ReceiptType;
    userId: string;
    data: Receipt;
}

type ReceiptCache = {[eventId: string]: CachedReceipt[]};

export interface ReceiptContent {
    [eventId: string]: {
        [key in ReceiptType]: {
            [userId: string]: Receipt;
        };
    };
}

const ReceiptPairRealIndex = 0;
const ReceiptPairSyntheticIndex = 1;
// We will only hold a synthetic receipt if we do not have a real receipt or the synthetic is newer.
type Receipts = {
    [receiptType: string]: {
        [userId: string]: [WrappedReceipt | null, WrappedReceipt | null]; // Pair<real receipt, synthetic receipt> (both nullable)
    };
};

export abstract class ReadReceipt<
    Events extends string,
    Arguments extends ListenerMap<Events>,
    SuperclassArguments extends ListenerMap<any> = Arguments,
> extends TypedEventEmitter<Events, Arguments, SuperclassArguments> {
    // receipts should clobber based on receipt_type and user_id pairs hence
    // the form of this structure. This is sub-optimal for the exposed APIs
    // which pass in an event ID and get back some receipts, so we also store
    // a pre-cached list for this purpose.
    private receipts: Receipts = {}; // { receipt_type: { user_id: Receipt } }
    private receiptCacheByEventId: ReceiptCache = {}; // { event_id: CachedReceipt[] }

    public abstract getUnfilteredTimelineSet(): EventTimelineSet;
    public abstract timeline: MatrixEvent[];

    /**
     * Gets the latest receipt for a given user in the room
     * @param userId The id of the user for which we want the receipt
     * @param ignoreSynthesized Whether to ignore synthesized receipts or not
     * @param receiptType Optional. The type of the receipt we want to get
     * @returns the latest receipts of the chosen type for the chosen user
     */
    public getReadReceiptForUserId(
        userId: string, ignoreSynthesized = false, receiptType = ReceiptType.Read,
    ): WrappedReceipt | null {
        const [realReceipt, syntheticReceipt] = this.receipts[receiptType]?.[userId] ?? [];
        if (ignoreSynthesized) {
            return realReceipt;
        }

        return syntheticReceipt ?? realReceipt;
    }

    /**
     * Get the ID of the event that a given user has read up to, or null if we
     * have received no read receipts from them.
     * @param {String} userId The user ID to get read receipt event ID for
     * @param {Boolean} ignoreSynthesized If true, return only receipts that have been
     *                                    sent by the server, not implicit ones generated
     *                                    by the JS SDK.
     * @return {String} ID of the latest event that the given user has read, or null.
     */
    public getEventReadUpTo(userId: string, ignoreSynthesized = false): string | null {
        // XXX: This is very very ugly and I hope I won't have to ever add a new
        // receipt type here again. IMHO this should be done by the server in
        // some more intelligent manner or the client should just use timestamps

        const timelineSet = this.getUnfilteredTimelineSet();
        const publicReadReceipt = this.getReadReceiptForUserId(userId, ignoreSynthesized, ReceiptType.Read);
        const privateReadReceipt = this.getReadReceiptForUserId(userId, ignoreSynthesized, ReceiptType.ReadPrivate);

        // If we have both, compare them
        let comparison: number | null | undefined;
        if (publicReadReceipt?.eventId && privateReadReceipt?.eventId) {
            comparison = timelineSet.compareEventOrdering(publicReadReceipt?.eventId, privateReadReceipt?.eventId);
        }

        // If we didn't get a comparison try to compare the ts of the receipts
        if (!comparison && publicReadReceipt?.data?.ts && privateReadReceipt?.data?.ts) {
            comparison = publicReadReceipt?.data?.ts - privateReadReceipt?.data?.ts;
        }

        // The public receipt is more likely to drift out of date so the private
        // one has precedence
        if (!comparison) return privateReadReceipt?.eventId ?? publicReadReceipt?.eventId ?? null;

        // If public read receipt is older, return the private one
        return ((comparison < 0) ? privateReadReceipt?.eventId : publicReadReceipt?.eventId) ?? null;
    }

    public addReceiptToStructure(
        eventId: string,
        receiptType: ReceiptType,
        userId: string,
        receipt: Receipt,
        synthetic: boolean,
    ): void {
        if (!this.receipts[receiptType]) {
            this.receipts[receiptType] = {};
        }
        if (!this.receipts[receiptType][userId]) {
            this.receipts[receiptType][userId] = [null, null];
        }

        const pair = this.receipts[receiptType][userId];

        let existingReceipt = pair[ReceiptPairRealIndex];
        if (synthetic) {
            existingReceipt = pair[ReceiptPairSyntheticIndex] ?? pair[ReceiptPairRealIndex];
        }

        if (existingReceipt) {
            // we only want to add this receipt if we think it is later than the one we already have.
            // This is managed server-side, but because we synthesize RRs locally we have to do it here too.
            const ordering = this.getUnfilteredTimelineSet().compareEventOrdering(
                existingReceipt.eventId,
                eventId,
            );
            if (ordering !== null && ordering >= 0) {
                return;
            }
        }

        const wrappedReceipt: WrappedReceipt = {
            eventId,
            data: receipt,
        };

        const realReceipt = synthetic ? pair[ReceiptPairRealIndex] : wrappedReceipt;
        const syntheticReceipt = synthetic ? wrappedReceipt : pair[ReceiptPairSyntheticIndex];

        let ordering: number | null = null;
        if (realReceipt && syntheticReceipt) {
            ordering = this.getUnfilteredTimelineSet().compareEventOrdering(
                realReceipt.eventId,
                syntheticReceipt.eventId,
            );
        }

        const preferSynthetic = ordering === null || ordering < 0;

        // we don't bother caching just real receipts by event ID as there's nothing that would read it.
        // Take the current cached receipt before we overwrite the pair elements.
        const cachedReceipt = pair[ReceiptPairSyntheticIndex] ?? pair[ReceiptPairRealIndex];

        if (synthetic && preferSynthetic) {
            pair[ReceiptPairSyntheticIndex] = wrappedReceipt;
        } else if (!synthetic) {
            pair[ReceiptPairRealIndex] = wrappedReceipt;

            if (!preferSynthetic) {
                pair[ReceiptPairSyntheticIndex] = null;
            }
        }

        const newCachedReceipt = pair[ReceiptPairSyntheticIndex] ?? pair[ReceiptPairRealIndex];
        if (cachedReceipt === newCachedReceipt) return;

        // clean up any previous cache entry
        if (cachedReceipt && this.receiptCacheByEventId[cachedReceipt.eventId]) {
            const previousEventId = cachedReceipt.eventId;
            // Remove the receipt we're about to clobber out of existence from the cache
            this.receiptCacheByEventId[previousEventId] = (
                this.receiptCacheByEventId[previousEventId].filter(r => {
                    return r.type !== receiptType || r.userId !== userId;
                })
            );

            if (this.receiptCacheByEventId[previousEventId].length < 1) {
                delete this.receiptCacheByEventId[previousEventId]; // clean up the cache keys
            }
        }

        // cache the new one
        if (!this.receiptCacheByEventId[eventId]) {
            this.receiptCacheByEventId[eventId] = [];
        }
        this.receiptCacheByEventId[eventId].push({
            userId: userId,
            type: receiptType as ReceiptType,
            data: receipt,
        });
    }

    /**
     * Get a list of receipts for the given event.
     * @param {MatrixEvent} event the event to get receipts for
     * @return {Object[]} A list of receipts with a userId, type and data keys or
     * an empty list.
     */
    public getReceiptsForEvent(event: MatrixEvent): CachedReceipt[] {
        return this.receiptCacheByEventId[event.getId()!] || [];
    }

    public abstract addReceipt(event: MatrixEvent, synthetic: boolean): void;

    /**
     * Add a temporary local-echo receipt to the room to reflect in the
     * client the fact that we've sent one.
     * @param {string} userId The user ID if the receipt sender
     * @param {MatrixEvent} e The event that is to be acknowledged
     * @param {ReceiptType} receiptType The type of receipt
     */
    public addLocalEchoReceipt(userId: string, e: MatrixEvent, receiptType: ReceiptType): void {
        this.addReceipt(synthesizeReceipt(userId, e, receiptType), true);
    }

    /**
     * Get a list of user IDs who have <b>read up to</b> the given event.
     * @param {MatrixEvent} event the event to get read receipts for.
     * @return {String[]} A list of user IDs.
     */
    public getUsersReadUpTo(event: MatrixEvent): string[] {
        return this.getReceiptsForEvent(event).filter(function(receipt) {
            return utils.isSupportedReceiptType(receipt.type);
        }).map(function(receipt) {
            return receipt.userId;
        });
    }

    /**
     * Determines if the given user has read a particular event ID with the known
     * history of the room. This is not a definitive check as it relies only on
     * what is available to the room at the time of execution.
     * @param {String} userId The user ID to check the read state of.
     * @param {String} eventId The event ID to check if the user read.
     * @returns {Boolean} True if the user has read the event, false otherwise.
     */
    public hasUserReadEvent(userId: string, eventId: string): boolean {
        const readUpToId = this.getEventReadUpTo(userId, false);
        if (readUpToId === eventId) return true;

        if (this.timeline?.length
            && this.timeline[this.timeline.length - 1].getSender()
            && this.timeline[this.timeline.length - 1].getSender() === userId) {
            // It doesn't matter where the event is in the timeline, the user has read
            // it because they've sent the latest event.
            return true;
        }

        for (let i = this.timeline?.length - 1; i >= 0; --i) {
            const ev = this.timeline[i];

            // If we encounter the target event first, the user hasn't read it
            // however if we encounter the readUpToId first then the user has read
            // it. These rules apply because we're iterating bottom-up.
            if (ev.getId() === eventId) return false;
            if (ev.getId() === readUpToId) return true;
        }

        // We don't know if the user has read it, so assume not.
        return false;
    }
}
