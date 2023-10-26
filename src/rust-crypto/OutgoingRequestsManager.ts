/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";

import { OutgoingRequest, OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { Logger } from "../logger";

/**
 * OutgoingRequestsManager: responsible for processing outgoing requests from the OlmMachine.
 * Ensure that only one loop is going on at once, and that the requests are processed in order.
 */
export class OutgoingRequestsManager {
    /** whether {@link stop} has been called */
    private stopped = false;

    /** whether a task is currently running */
    private isTaskRunning = false;

    /** queue of requests to be processed once the current loop is finished */
    private requestQueue: (() => void)[] = [];

    public constructor(
        private readonly logger: Logger,
        private readonly olmMachine: OlmMachine,
        public readonly outgoingRequestProcessor: OutgoingRequestProcessor,
    ) {}

    /**
     * Shut down as soon as possible the current loop of outgoing requests processing.
     */
    public stop(): void {
        this.stopped = true;
    }

    /**
     * Process the outgoing requests from the OlmMachine.
     *
     * This should be called at the end of each sync, to process any requests that have been queued.
     * In some cases if outgoing requests need to be sent immediately, this can be called directly.
     *
     * There is only one request running at once, and the others are queued.
     * If a request is currently running the queued request will only trigger an additional run.
     */
    public async doProcessOutgoingRequests(): Promise<void> {
        if (this.isTaskRunning) {
            // If the task is running, add the request to the queue and wait for completion.
            // This ensures that the requests are processed only once at a time.
            await new Promise<void>((resolve) => {
                this.requestQueue.push(resolve);
            });
        } else {
            await this.executeTask();
        }
    }

    private async executeTask(): Promise<void> {
        this.isTaskRunning = true;

        try {
            await this.processOutgoingRequests();
        } finally {
            this.isTaskRunning = false;
        }

        if (this.requestQueue.length > 0) {
            if (this.stopped) {
                this.requestQueue.forEach((resolve) => resolve());
                return;
            }
            // there are a pending request that need to be executed
            const awaitingRequests = this.requestQueue.map((resolve) => resolve);
            // reset the queue
            this.requestQueue = [];

            // run again and resolve all the pending requests.
            await this.executeTask();

            awaitingRequests.forEach((resolve) => resolve());
        }
    }

    private async processOutgoingRequests(): Promise<void> {
        if (this.stopped) return;

        const outgoingRequests: OutgoingRequest[] = await this.olmMachine.outgoingRequests();

        for (const request of outgoingRequests) {
            if (this.stopped) return;
            try {
                await this.outgoingRequestProcessor.makeOutgoingRequest(request);
            } catch (e) {
                // as part of the loop we silently ignore errors, but log them.
                // The rust sdk will retry the request later as it won't have been marked as sent.
                this.logger.error(`Failed to process outgoing request ${request.type}: ${e}`);
            }
        }
    }
}
