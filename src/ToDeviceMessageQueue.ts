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

import { logger } from "./logger";
import { MatrixClient } from "./matrix";
import { IndexedToDeviceBatch, ToDeviceBatch, ToDeviceBatchWithTxnId, ToDevicePayload } from "./models/ToDeviceMessage";
import { MatrixScheduler } from "./scheduler";

const MAX_BATCH_SIZE = 20;

/**
 * Maintains a queue of outgoing to-device messages, sending them
 * as soon as the homeserver is reachable.
 */
export class ToDeviceMessageQueue {
    private sending = false;
    private running = true;
    private retryTimeout: number = null;
    private retryAttempts = 0;

    constructor(private client: MatrixClient) {
    }

    public start(): void {
        this.running = true;
        this.sendQueue();
    }

    public stop(): void {
        this.running = false;
        if (this.retryTimeout !== null) clearTimeout(this.retryTimeout);
        this.retryTimeout = null;
    }

    public async queueBatch(batch: ToDeviceBatch): Promise<void> {
        const batches: ToDeviceBatchWithTxnId[] = [];
        for (let i = 0; i < batch.batch.length; i += MAX_BATCH_SIZE) {
            batches.push({
                eventType: batch.eventType,
                batch: batch.batch.slice(i, i + MAX_BATCH_SIZE),
                txnId: this.client.makeTxnId(),
            });
        }

        await this.client.store.saveToDeviceBatches(batches);
        this.sendQueue();
    }

    public sendQueue = async (): Promise<void> => {
        if (this.retryTimeout !== null) clearTimeout(this.retryTimeout);
        this.retryTimeout = null;

        if (this.sending || !this.running) return;

        logger.debug("Attempting to send queued to-device messages");

        this.sending = true;
        let headBatch;
        try {
            while (this.running) {
                headBatch = await this.client.store.getOldestToDeviceBatch();
                if (headBatch === null) break;
                await this.sendBatch(headBatch);
                await this.client.store.removeToDeviceBatch(headBatch.id);
                this.retryAttempts = 0;
            }

            // Make sure we're still running after the async tasks: if not, stop.
            if (!this.running) return;

            logger.debug("All queued to-device messages sent");
        } catch (e) {
            ++this.retryAttempts;
            // eslint-disable-next-line @typescript-eslint/naming-convention
            // eslint-disable-next-line new-cap
            const retryDelay = MatrixScheduler.RETRY_BACKOFF_RATELIMIT(null, this.retryAttempts, e);
            if (retryDelay === -1) {
                // the scheduler function doesn't differentiate between fatal errors and just getting
                // bored and giving up for now
                if (Math.floor(e.httpStatus / 100) === 4) {
                    logger.error("Fatal error when sending to-device message - dropping to-device batch!", e);
                    await this.client.store.removeToDeviceBatch(headBatch.id);
                } else {
                    logger.info("Automatic retry limit reached for to-device messages.");
                }
                return;
            }

            logger.info(`Failed to send batch of to-device messages. Will retry in ${retryDelay}ms`, e);
            this.retryTimeout = setTimeout(this.sendQueue, retryDelay);
        } finally {
            this.sending = false;
        }
    };

    /**
     * Attempts to send a batch of to-device messages.
     */
    private async sendBatch(batch: IndexedToDeviceBatch): Promise<void> {
        const contentMap: Record<string, Record<string, ToDevicePayload>> = {};
        for (const item of batch.batch) {
            if (!contentMap[item.userId]) {
                contentMap[item.userId] = {};
            }
            contentMap[item.userId][item.deviceId] = item.payload;
        }

        logger.info(`Sending batch of ${batch.batch.length} to-device messages with ID ${batch.id}`);

        await this.client.sendToDevice(batch.eventType, contentMap, batch.txnId);
    }
}
