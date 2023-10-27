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
import { defer, IDeferred } from "../utils";

/**
 * OutgoingRequestsManager: responsible for processing outgoing requests from the OlmMachine.
 * Ensure that only one loop is going on at once, and that the requests are processed in order.
 */
export class OutgoingRequestsManager {
    /** whether {@link stop} has been called */
    private stopped = false;

    /** whether a task is currently running */
    private isTaskRunning = false;

    /**
     * If there are additional calls to doProcessOutgoingRequests() while there is a current call running
     * we need to remember in order to call process again (as there could be new requests).
     */
    private nextLoopDeferred?: IDeferred<void>;

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
     * Process the OutgoingRequests from the OlmMachine.
     *
     * This should be called at the end of each sync, to process any OlmMachine OutgoingRequests created by the rust sdk.
     * In some cases if OutgoingRequests need to be sent immediately, this can be called directly.
     *
     * Calls to doProcessOutgoingRequests() are processed synchronously, one after the other, in order.
     * If doProcessOutgoingRequests() is called while another call is still being processed, it will be queued.
     * Multiple calls to doProcessOutgoingRequests() when a call is already processing will be batched together.
     */
    public async doProcessOutgoingRequests(): Promise<void> {
        if (this.isTaskRunning) {
            // If the task is running, add the request to the queue and wait for completion.
            // This ensures that the requests are processed only once at a time.
            if (!this.nextLoopDeferred) {
                this.nextLoopDeferred = defer();
            }
            return this.nextLoopDeferred.promise;
        } else {
            this.isTaskRunning = true;
            try {
                await this.processOutgoingRequests();
            } finally {
                this.isTaskRunning = false;
            }

            // If there was some request while this iteration was running, run a second time and resolve the linked promise.
            if (this.nextLoopDeferred) {
                if (this.stopped) {
                    this.nextLoopDeferred.resolve();
                    return;
                }

                // keep the current deferred requests to resolve them after the next iteration.
                const deferred = this.nextLoopDeferred;
                // reset the nextLoopDeferred so that any future requests are queued for another additional iteration.
                this.nextLoopDeferred = undefined;

                // Run again and resolve all the pending requests.
                // Notice that we don't await on it, so that the current promise is resolved now.
                // The requests that were deferred will be resolved after this new iteration.
                this.doProcessOutgoingRequests().then(() => {
                    deferred.resolve();
                });
            }
        }
    }

    /**
     * Make a single request to `olmMachine.outgoingRequests` and do the corresponding requests.
     */
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
