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

import { AccumulatedReceipt } from "./sync-accumulator";
import { MapWithDefault } from "./utils";

export class ReceiptAccumulator {
    private readReceipts: Map<string, AccumulatedReceipt> = new Map();
    private threadedReadReceipts: MapWithDefault<string, Map<string, AccumulatedReceipt>> = new MapWithDefault(
        () => new Map(),
    );

    public setUnthreaded(userId: string, receipt: AccumulatedReceipt): void {
        this.readReceipts.set(userId, receipt);
    }

    public setThreaded(threadId: string, userId: string, receipt: AccumulatedReceipt): void {
        this.threadedReadReceipts.getOrCreate(threadId).set(userId, receipt);
    }

    /**
     * @returns an iterator of pairs of [userId, AccumulatedReceipt] - all the
     *          unthreaded receipts for each user.
     */
    public allUnthreaded(): IterableIterator<[string, AccumulatedReceipt]> {
        return this.readReceipts.entries();
    }

    /**
     * @returns an iterator of pairs of [userId, AccumulatedReceipt] - all the
     *          threaded receipts for each user, in all threads.
     */
    public *allThreaded(): IterableIterator<[string, AccumulatedReceipt]> {
        for (const receiptsForThread of this.threadedReadReceipts.values()) {
            for (const e of receiptsForThread.entries()) {
                yield e;
            }
        }
    }
}
