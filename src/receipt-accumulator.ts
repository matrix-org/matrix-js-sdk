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

import { AccumulatedReceipt, IMinimalEvent } from "./sync-accumulator";
import { EventType } from "./@types/event";
import { MapWithDefault, recursiveMapToObject } from "./utils";
import { IContent } from "./models/event";
import { ReceiptType } from "./@types/read_receipts";

/**
 * Summarises the read receipts within a room. Used by the sync accumulator.
 *
 * Given receipts for users, picks the most recently-received one and provides
 * the results in a new fake receipt event returned from
 * buildAccumulatedReceiptEvent().
 *
 * Handles unthreaded receipts and receipts in each thread separately, so the
 * returned event contains the most recently received unthreaded receipt, and
 * the most recently received receipt in each thread.
 */
export class ReceiptAccumulator {
    /** user_id -\> most-recently-received unthreaded receipt */
    private unthreadedReadReceipts: Map<string, AccumulatedReceipt> = new Map();

    /** thread_id -\> user_id -\> most-recently-received receipt for this thread */
    private threadedReadReceipts: MapWithDefault<string, Map<string, AccumulatedReceipt>> = new MapWithDefault(
        () => new Map(),
    );

    /**
     * Provide an unthreaded receipt for this user. Overwrites any other
     * unthreaded receipt we have for this user.
     */
    public setUnthreaded(userId: string, receipt: AccumulatedReceipt): void {
        this.unthreadedReadReceipts.set(userId, receipt);
    }

    /**
     * Provide a receipt for this user in this thread. Overwrites any other
     * receipt we have for this user in this thread.
     */
    public setThreaded(threadId: string, userId: string, receipt: AccumulatedReceipt): void {
        this.threadedReadReceipts.getOrCreate(threadId).set(userId, receipt);
    }

    /**
     * @returns an iterator of pairs of [userId, AccumulatedReceipt] - all the
     *          most recently-received unthreaded receipts for each user.
     */
    private allUnthreaded(): IterableIterator<[string, AccumulatedReceipt]> {
        return this.unthreadedReadReceipts.entries();
    }

    /**
     * @returns an iterator of pairs of [userId, AccumulatedReceipt] - all the
     *          most recently-received threaded receipts for each user, in all
     *          threads.
     */
    private *allThreaded(): IterableIterator<[string, AccumulatedReceipt]> {
        for (const receiptsForThread of this.threadedReadReceipts.values()) {
            for (const e of receiptsForThread.entries()) {
                yield e;
            }
        }
    }

    /**
     * Build a receipt event that contains all relevant information for this
     * room, taking the most recently received receipt for each user in an
     * unthreaded context, and in each thread.
     */
    public buildAccumulatedReceiptEvent(roomId: string): IMinimalEvent | null {
        const receiptEvent: IMinimalEvent = {
            type: EventType.Receipt,
            room_id: roomId,
            content: {
                // $event_id: { "m.read": { $user_id: $json } }
            } as IContent,
        };

        const receiptEventContent: MapWithDefault<
            string,
            MapWithDefault<ReceiptType, Map<string, object>>
        > = new MapWithDefault(() => new MapWithDefault(() => new Map()));

        for (const [userId, receiptData] of this.allUnthreaded()) {
            receiptEventContent
                .getOrCreate(receiptData.eventId)
                .getOrCreate(receiptData.type)
                .set(userId, receiptData.data);
        }

        for (const [userId, receiptData] of this.allThreaded()) {
            receiptEventContent
                .getOrCreate(receiptData.eventId)
                .getOrCreate(receiptData.type)
                .set(userId, receiptData.data);
        }

        receiptEvent.content = recursiveMapToObject(receiptEventContent);

        return receiptEventContent.size > 0 ? receiptEvent : null;
    }
}
