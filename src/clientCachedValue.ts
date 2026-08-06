/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { type MatrixClient } from "./client.ts";
import { calculateRetryBackoff } from "./http-api/index.ts";
import { type Logger } from "./logger.ts";
import { sleep } from "./utils.ts";

/**
 * Defines a generic mechanism to fetch and cache values for the client.
 */
export abstract class ClientCachedValue<ValueType> {
    protected cached?: ValueType;
    protected fetchPromise?: Promise<ValueType>;
    protected ttlTimeoutHandle?: ReturnType<typeof setTimeout>;

    private isStopped = false;
    private ttlMillis?: number;

    private readonly logger: Logger;
    /**
     * Build a generic mechanism allowing to fetch and cache a given value from the homeserver.
     * @param name - The name of the cached value (for tracing/logs).
     * @param client - The matrix client
     * @param ttlMillis - The time-to-live before the value get refreshed. If undefined use refresh() to clear cache.
     * @param rootLogger
     */
    public constructor(
        protected readonly name: string,
        protected readonly client: MatrixClient,
        ttlMillis: number | undefined,
        rootLogger: Logger,
    ) {
        this.ttlMillis = ttlMillis;
        this.logger = rootLogger.getChild(`ClientCachedValue<${name}>`);
    }

    /**
     * Gets the cached value if any.
     */
    public get(): ValueType | undefined {
        return this.cached;
    }

    /**
     * Ensures that the value was fetched once before getting the actual cached value.
     */
    public async wait(): Promise<ValueType | undefined> {
        try {
            await this.doFetch();
        } catch (error) {
            // Ignore errors, as wait should not throw
        }
        return this.cached;
    }

    /**
     * Call this as early as possible and when the client is already capable of fetching the value.
     */
    public start(): void {
        this.isStopped = false;
        // Request a fetch as soon as possible
        this.doFetch().catch((err) => {
            this.logger.debug("Cached value fetch on start did fail", err);
        });
    }

    /**
     * Set the time-to-live for the cached value.
     * @param TTL The time-to-live in milliseconds.
     */
    public setTTLMillis(TTL: number): void {
        this.ttlMillis = TTL;
    }
    /**
     * Call when the client is stopped, or when the cached value is no longer needed.
     */
    public stop(): void {
        if (this.ttlTimeoutHandle) {
            clearTimeout(this.ttlTimeoutHandle);
        }
        this.isStopped = true;
    }

    /**
     * Force to refresh.
     * @throws
     */
    public async refresh(): Promise<ValueType | undefined> {
        await this.doFetch(true);
        return this.cached;
    }

    protected abstract fetch(client: MatrixClient): Promise<ValueType>;

    /**
     * Called when a new value is cached.
     * @param value The value that was cached.
     * @protected
     */
    protected valueCached(value: ValueType): void {
        this.logger.trace(`New cachedValue: ${value}`);
        // nop - Use to emit changes if needed
    }

    /**
     * Determines whether a non-transient error should be cached.
     * @param error The error to evaluate.
     * @protected
     */
    protected shouldCacheError(error: any): boolean {
        // By default retry to fetch the value on error
        return false;
    }

    private async doFetch(force: boolean = false): Promise<void> {
        if (this.fetchPromise && !force) {
            await this.fetchPromise;
            return;
        }

        this.fetchPromise = this.fetchWithRetryPolicy();

        try {
            const value = await this.fetchPromise;
            this.cached = value;
            if (this.isStopped) {
                this.fetchPromise = undefined;
                return;
            }
            this.valueCached(value);
            // The value is cached only for a given time.
            if (this.ttlMillis) {
                this.ttlTimeoutHandle = setTimeout(() => {
                    this.fetchPromise = undefined;
                    void this.doFetch();
                }, this.ttlMillis);
            }
        } catch (error) {
            this.logger.debug(`Error fetching server value for ${error}`);
            if (this.isStopped) {
                this.fetchPromise = undefined;
                return;
            }
            if (!this.shouldCacheError(error)) {
                // clear the promise, i.e next tentative will retry to fetch
                this.fetchPromise = undefined;
            }
            throw error;
        }
    }

    /**
     * Gracefully handle transient error retries, respect retry_after_millis for rate limits.
     * @private
     */
    private async fetchWithRetryPolicy(): Promise<ValueType> {
        let currentRetryCount = 0;
        while (true) {
            try {
                return await this.fetch(this.client);
            } catch (e) {
                this.logger.trace(`Failed to fetch retry: ${e}`);
                if (this.isStopped) {
                    throw e;
                }
                currentRetryCount++;
                const backoff = calculateRetryBackoff(e, currentRetryCount, true);
                if (backoff < 0) {
                    // Max number of retries reached, or error is not retryable. rethrow the error
                    throw e;
                }
                // wait for the specified time and then retry the request
                await sleep(backoff);
            }
        }
    }
}
