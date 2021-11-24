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

import { EventTimelineSet } from "./event-timeline-set";
import { MatrixEvent } from "./event";
import { NotificationCountType } from "../@types/receipt";
import { TypedEventEmitter } from "./typed-event-emitter";

interface IReceipt {
    ts: number;
}

interface IWrappedReceipt {
    eventId: string;
    data: IReceipt;
}

interface ICachedReceipt {
    type: string;
    userId: string;
    data: IReceipt;
}

interface IReceiptContent {
    [eventId: string]: {
        [type: string]: {
            [userId: string]: IReceipt;
        };
    };
}

type ReceiptCache = Record<string, ICachedReceipt[]>;

type Receipts = Record<string, Record<string, IWrappedReceipt>>;

export function synthesizeReceipt(userId: string, event: MatrixEvent, receiptType: string): MatrixEvent {
    // console.log("synthesizing receipt for "+event.getId());
    // This is really ugly because JS has no way to express an object literal
    // where the name of a key comes from an expression
    const fakeReceipt = {
        content: {},
        type: "m.receipt",
        room_id: event.getRoomId(),
    };
    fakeReceipt.content[event.getId()] = {};
    fakeReceipt.content[event.getId()][receiptType] = {};
    fakeReceipt.content[event.getId()][receiptType][userId] = {
        ts: event.getTs(),
    };
    return new MatrixEvent(fakeReceipt);
}

export enum ReceiptEvents {
    Receipt = "Room.Receipt"
}

export abstract class Receipt<Events extends string = null> extends TypedEventEmitter<Events | ReceiptEvents> {
    // receipts should clobber based on receipt_type and user_id pairs hence
    // the form of this structure. This is sub-optimal for the exposed APIs
    // which pass in an event ID and get back some receipts, so we also store
    // a pre-cached list for this purpose.
    private receipts: Receipts = {}; // { receipt_type: { user_id: IReceipt } }
    private receiptCacheByEventId: ReceiptCache = {}; // { event_id: IReceipt2[] }
    // only receipts that came from the server, not synthesized ones
    private realReceipts: Receipts = {};

    public abstract timeline: MatrixEvent[];
    public abstract getUnfilteredTimelineSet(): EventTimelineSet;
    public abstract hasPendingEvent(eventId: string): boolean;

    private notificationCounts: Partial<Record<NotificationCountType, number>> = {};

    /**
     * Get a list of receipts for the given event.
     * @param {MatrixEvent} event the event to get receipts for
     * @return {Object[]} A list of receipts with a userId, type and data keys or
     * an empty list.
     */
    public getReceiptsForEvent(event: MatrixEvent): ICachedReceipt[] {
        return this.receiptCacheByEventId[event.getId()] || [];
    }

    /**
     * Add a receipt event to the room.
     * @param {MatrixEvent} event The m.receipt event.
     * @param {Boolean} fake True if this event is implicit
     */
    public addReceipt(event: MatrixEvent, fake = false): void {
        if (!fake) {
            this.addReceiptsToStructure(event, this.realReceipts);
            // we don't bother caching real receipts by event ID
            // as there's nothing that would read it.
        }
        this.addReceiptsToStructure(event, this.receipts);
        this.receiptCacheByEventId = this.buildReceiptCache(this.receipts);

        // send events after we've regenerated the cache, otherwise things that
        // listened for the event would read from a stale cache
        this.emit(ReceiptEvents.Receipt, event, this);
    }

    /**
     * Add a receipt event to the room.
     * @param {MatrixEvent} event The m.receipt event.
     * @param {Object} receipts The object to add receipts to
     */
    private addReceiptsToStructure(event: MatrixEvent, receipts: Receipts): void {
        const content = event.getContent<IReceiptContent>();
        Object.keys(content).forEach((eventId) => {
            Object.keys(content[eventId]).forEach((receiptType) => {
                Object.keys(content[eventId][receiptType]).forEach((userId) => {
                    const receipt = content[eventId][receiptType][userId];

                    if (!receipts[receiptType]) {
                        receipts[receiptType] = {};
                    }

                    const existingReceipt = receipts[receiptType][userId];

                    if (!existingReceipt) {
                        receipts[receiptType][userId] = {} as IWrappedReceipt;
                    } else {
                        // we only want to add this receipt if we think it is later
                        // than the one we already have. (This is managed
                        // server-side, but because we synthesize RRs locally we
                        // have to do it here too.)
                        const ordering = this.getUnfilteredTimelineSet().compareEventOrdering(
                            existingReceipt.eventId, eventId);
                        if (ordering !== null && ordering >= 0) {
                            return;
                        }
                    }

                    receipts[receiptType][userId] = {
                        eventId: eventId,
                        data: receipt,
                    };
                });
            });
        });
    }

    /**
     * Build and return a map of receipts by event ID
     * @param {Object} receipts A map of receipts
     * @return {Object} Map of receipts by event ID
     */
    private buildReceiptCache(receipts: Receipts): ReceiptCache {
        const receiptCacheByEventId = {};
        Object.keys(receipts).forEach(function(receiptType) {
            Object.keys(receipts[receiptType]).forEach(function(userId) {
                const receipt = receipts[receiptType][userId];
                if (!receiptCacheByEventId[receipt.eventId]) {
                    receiptCacheByEventId[receipt.eventId] = [];
                }
                receiptCacheByEventId[receipt.eventId].push({
                    userId: userId,
                    type: receiptType,
                    data: receipt.data,
                });
            });
        });
        return receiptCacheByEventId;
    }

    /**
     * Add a temporary local-echo receipt to the room to reflect in the
     * client the fact that we've sent one.
     * @param {string} userId The user ID if the receipt sender
     * @param {MatrixEvent} e The event that is to be acknowledged
     * @param {string} receiptType The type of receipt
     */
    public addLocalEchoReceipt(userId: string, e: MatrixEvent, receiptType: string): void {
        this.addReceipt(synthesizeReceipt(userId, e, receiptType), true);
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
        let receipts = this.receipts;
        if (ignoreSynthesized) {
            receipts = this.realReceipts;
        }

        if (
            receipts["m.read"] === undefined ||
            receipts["m.read"][userId] === undefined
        ) {
            return null;
        }

        return receipts["m.read"][userId].eventId;
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

        if (this.timeline.length
            && this.timeline[this.timeline.length - 1].getSender()
            && this.timeline[this.timeline.length - 1].getSender() === userId) {
            // It doesn't matter where the event is in the timeline, the user has read
            // it because they've sent the latest event.
            return true;
        }

        for (let i = this.timeline.length - 1; i >= 0; --i) {
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

    /**
     * Get a list of user IDs who have <b>read up to</b> the given event.
     * @param {MatrixEvent} event the event to get read receipts for.
     * @return {String[]} A list of user IDs.
     */
    public getUsersReadUpTo(event: MatrixEvent): string[] {
        return this.getReceiptsForEvent(event).filter(function(receipt) {
            return receipt.type === "m.read";
        }).map(function(receipt) {
            return receipt.userId;
        });
    }

    /**
     * Get one of the notification counts for this context
     * @param {String} type The type of notification count to get. default: 'total'
     * @return {Number} The notification count
     */
    public getUnreadNotificationCount(type = NotificationCountType.Total): number {
        return this.notificationCounts[type] ?? 0;
    }

    /**
     * Set one of the notification counts for this context
     * @param {String} type The type of notification count to set.
     * @param {Number} count The new count
     */
    public setUnreadNotificationCount(type: NotificationCountType, count: number): void {
        this.notificationCounts[type] = count;
    }
}
