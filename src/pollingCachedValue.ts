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

import { calculateRetryBackoff } from "./http-api/index.ts";
import { type Logger } from "./logger.ts";
import { sleep } from "./utils.ts";

/**
 * How to fetch and cache a given value, as passed to {@link PollingCachedValue}.
 */
export interface PollingCachedValueOptions<ValueType> {
    /** The name of the cached value (for tracing/logs). */
    name: string;
    /** The logger to derive this value's child logger from. */
    logger: Logger;
    /** Fetches a fresh value. Rejections are retried according to the retry policy. */
    fetch: () => Promise<ValueType>;
    /**
     * The default time-to-live before the value gets refreshed, overridable per run
     * via {@link PollingCachedValue.start}.
     * If undefined the value never expires; use {@link PollingCachedValue.refresh} to clear the cache.
     */
    ttlMillis?: number;
    /** Called when a new value is cached. Use to emit changes if needed. */
    onValueCached?: (value: ValueType) => void;
    /**
     * Determines whether a non-transient error should be cached.
     * By default errors are not cached, i.e. the next attempt retries the fetch.
     */
    shouldCacheError?: (error: unknown) => boolean;
}

/**
 * Defines a generic mechanism to fetch and cache a value, refreshing it periodically.
 */
export class PollingCachedValue<ValueType> {
    private cached?: ValueType;
    private fetchPromise?: Promise<ValueType>;
    private ttlTimeoutHandle?: ReturnType<typeof setTimeout>;

    private isStopped = false;
    private ttlMillis?: number;

    private readonly logger: Logger;

    /**
     * Build a generic mechanism allowing to fetch and cache a given value.
     * @param opts - Describes what to fetch and how to cache it, see {@link PollingCachedValueOptions}.
     */
    public constructor(private readonly opts: PollingCachedValueOptions<ValueType>) {
        this.ttlMillis = opts.ttlMillis;
        this.logger = opts.logger.getChild(`PollingCachedValue<${opts.name}>`);
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
        await this.doFetch();
        return this.cached;
    }

    /**
     * Call this as early as possible and when the value can already be fetched.
     * @param ttlMillis - The time-to-live before the value gets refreshed, overriding the one
     *     given at construction. If omitted the configured default is kept.
     */
    public start(ttlMillis?: number): void {
        if (ttlMillis !== undefined) {
            this.ttlMillis = ttlMillis;
        }
        this.isStopped = false;
        // Request a fetch as soon as possible
        this.doFetch().catch((err) => {
            this.logger.debug("Cached value fetch on start did fail", err);
        });
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

    /**
     * Internal fetch method
     * @param force - if set to true will force a fetch of the value even if a fetch is already in progress.
     * @private
     */
    private async doFetch(force: boolean = false): Promise<void> {
        if (this.fetchPromise && !force) {
            await this.fetchPromise;
            return;
        }

        this.fetchPromise = this.fetchWithRetryPolicy();

        try {
            this.cached = await this.fetchPromise;
            if (this.isStopped) {
                this.fetchPromise = undefined;
                return;
            }
            this.logger.trace(`New cachedValue: ${this.cached}`);
            this.opts.onValueCached?.(this.cached);
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
            if (!this.opts.shouldCacheError?.(error)) {
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
                return await this.opts.fetch();
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
