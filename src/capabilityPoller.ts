/*
Copyright 2026 Element Creations Ltd.
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

import { type IHttpOpts, type MatrixHttpApi } from "./http-api/index.ts";
import { type Logger } from "./logger.ts";
import { TypedEventEmitter } from "./models/typed-event-emitter.ts";
import { deepCompare } from "./utils.ts";

// How often we update the server capabilities.
// 6 hours - an arbitrary value, but they should change very infrequently.
const CAPABILITIES_CACHE_MS = 6 * 60 * 60 * 1000;

// How long we want before retrying if we couldn't fetch
const CAPABILITIES_RETRY_MS = 30 * 1000;

/**
 * Manages storing and periodically refreshing the server capabilities.
 */
export abstract class CapabilityPoller<ResponseType> extends TypedEventEmitter<
    "update",
    { update: (data: ResponseType) => void }
> {
    protected cached?: ResponseType;
    private retryTimeout?: ReturnType<typeof setTimeout>;
    private refreshTimeout?: ReturnType<typeof setInterval>;

    public constructor(
        protected readonly logger: Logger,
        protected readonly http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        private readonly name: string,
    ) {
        super();
    }

    /**
     * Starts periodically fetching the server capabilities.
     */
    public start(): void {
        this.poll().then();
    }

    /**
     * Stops the service
     */
    public stop(): void {
        this.clearTimeouts();
    }

    /**
     * Returns the cached capabilities, or undefined if none are cached.
     * @returns the current capabilities, if any.
     */
    public getCached(): ResponseType | undefined {
        return this.cached;
    }

    public abstract fetch(): Promise<ResponseType>;

    private poll = async (): Promise<void> => {
        this.logger.debug("Checking capabilites");
        try {
            const current = this.cached;
            await this.fetch();
            this.clearTimeouts();
            this.refreshTimeout = globalThis.setTimeout(this.poll, CAPABILITIES_CACHE_MS);
            this.logger.debug(`Fetched new server ${this.name}`);
            if (this.cached && !deepCompare(current, this.cached)) {
                this.emit("update", this.cached);
            }
        } catch (e) {
            this.clearTimeouts();
            const howLong = Math.floor(CAPABILITIES_RETRY_MS + Math.random() * 5000);
            this.retryTimeout = globalThis.setTimeout(this.poll, howLong);
            this.logger.warn(`Failed to refresh ${this.name}: retrying in ${howLong}ms`, e);
        }
    };

    private clearTimeouts(): void {
        if (this.refreshTimeout) {
            clearInterval(this.refreshTimeout);
            this.refreshTimeout = undefined;
        }
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = undefined;
        }
    }
}
