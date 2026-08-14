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

import { afterEach, beforeEach, describe, vi, it, expect, type Mock } from "vitest";
import { PollingCachedValue } from "../../src/pollingCachedValue.ts";
import { MatrixError } from "../../src";
import { logger } from "../../src/logger.ts";

describe("PollingCachedValue", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const TTL = 10000;
    let fetchFn: Mock<() => Promise<string>>;
    let cachedCallback: Mock<(value: string) => void>;
    let clientCachedValue: PollingCachedValue<string>;

    beforeEach(() => {
        fetchFn = vi.fn<() => Promise<string>>();
        cachedCallback = vi.fn<(value: string) => void>();
        clientCachedValue = new PollingCachedValue({
            name: "mock",
            logger,
            ttlMillis: TTL,
            fetch: fetchFn,
            onValueCached: cachedCallback,
        });
    });

    it("should fetch and cache the value", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        const value = await clientCachedValue.wait();

        expect(value).toBe("HelloWorld!");
        expect(clientCachedValue.get()).toBe("HelloWorld!");
        expect(cachedCallback).toHaveBeenCalledWith("HelloWorld!");
    });

    it("should not call again once the value is cached", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        const value = await clientCachedValue.wait();

        expect(value).toBe("HelloWorld!");

        // ask the value again
        await clientCachedValue.wait();

        expect(clientCachedValue.get()).toBe("HelloWorld!");
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should expire the cache after the specified time", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        const value = await clientCachedValue.wait();
        expect(value).toBe("HelloWorld!");

        fetchFn.mockResolvedValue("NewValue!");

        // Within the refresh period, so still the old value
        await vi.advanceTimersByTimeAsync(TTL / 2);
        expect(await clientCachedValue.wait()).toBe("HelloWorld!");

        // advance time by 1001ms to trigger cache expiration
        await vi.advanceTimersByTimeAsync(TTL / 2 + 10);

        const newValue = await clientCachedValue.wait();
        expect(newValue).toBe("NewValue!");

        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should automatically retry limit exceeded transient errors", async () => {
        fetchFn.mockImplementation(() => {
            throw new MatrixError(
                { errcode: "M_LIMIT_EXCEEDED", error: "Too many requests", retry_after_ms: 1000 },
                429,
            );
        });

        const fetchPromise = clientCachedValue.wait();
        let settled = false;
        void fetchPromise.finally(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(100);

        // should still be pending
        await Promise.resolve(); // flush microtasks
        expect(settled).toBe(false); // still pending

        fetchFn.mockResolvedValue("OOO");
        await vi.advanceTimersByTimeAsync(2000);

        const value = await fetchPromise;
        expect(value).toBe("OOO");
        expect(settled).toBe(true);

        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should start fetching and avoid scheduling refresh once stopped", async () => {
        const resolver = Promise.withResolvers<string>();
        fetchFn.mockImplementation(() => resolver.promise);

        clientCachedValue.start();
        expect(fetchFn).toHaveBeenCalledTimes(1);

        clientCachedValue.stop();
        resolver.resolve("FromStart");
        await clientCachedValue.wait();

        expect(clientCachedValue.get()).toBe("FromStart");

        await vi.advanceTimersByTimeAsync(TTL + 10);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should clear an existing timeout handle when stopped", async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        setTimeoutSpy.mockReturnValue(123 as unknown as ReturnType<typeof setTimeout>);

        clientCachedValue.start();
        await vi.advanceTimersByTimeAsync(100);
        clientCachedValue.stop();

        expect(clearTimeoutSpy).toHaveBeenCalledWith(123);
        clearTimeoutSpy.mockRestore();
        setTimeoutSpy.mockRestore();
    });

    it("should not arm a refresh trigger if no ttl is provided", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        setTimeoutSpy.mockReturnValue(123 as unknown as ReturnType<typeof setTimeout>);

        clientCachedValue = new PollingCachedValue({ name: "mock", logger, fetch: fetchFn });
        clientCachedValue.start();
        await vi.advanceTimersByTimeAsync(100);

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        setTimeoutSpy.mockRestore();
    });

    it("should let start() override the configured ttl", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        // Configured with TTL, but started with a shorter one
        clientCachedValue.start(TTL / 10);
        await vi.advanceTimersByTimeAsync(TTL / 10 + 10);

        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should keep the configured ttl when start() is given none", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        clientCachedValue.start();

        await vi.advanceTimersByTimeAsync(TTL / 2);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(TTL / 2 + 10);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should retry fetch on next wait for non-cacheable errors", async () => {
        const nonRetryableError = new MatrixError({ errcode: "M_FORBIDDEN", error: "Forbidden" }, 403);
        fetchFn.mockRejectedValueOnce(nonRetryableError).mockResolvedValueOnce("Recovered");

        const firstValue = clientCachedValue.wait();
        await expect(firstValue).rejects.toThrow(nonRetryableError);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(clientCachedValue.get()).toBeUndefined();

        const secondValue = await clientCachedValue.wait();
        expect(secondValue).toBe("Recovered");
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should stop retrying immediately when stopped during fetch error", async () => {
        const retryableError = new MatrixError(
            { errcode: "M_LIMIT_EXCEEDED", error: "Too many requests", retry_after_ms: 1000 },
            429,
        );
        fetchFn.mockRejectedValue(retryableError);
        clientCachedValue.stop();

        const value = await clientCachedValue.wait();
        expect(value).toBeUndefined();
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should reuse same promise for rapid calls", async () => {
        const loader = Promise.withResolvers<string>();
        fetchFn.mockImplementation(() => loader.promise);

        const race = Promise.race([clientCachedValue.wait(), clientCachedValue.wait(), clientCachedValue.wait()]);

        await vi.runOnlyPendingTimersAsync();

        loader.resolve("FOO");
        const value = await race;
        expect(value).toBe("FOO");
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should reuse rejected promise when error is marked cacheable", async () => {
        const cacheableError = new MatrixError({ errcode: "M_FORBIDDEN", error: "Forbidden" }, 403);
        const cacheableClientCachedValue = new PollingCachedValue({
            name: "mock",
            logger,
            ttlMillis: TTL,
            fetch: fetchFn,
            shouldCacheError: () => true,
        });
        fetchFn.mockRejectedValue(cacheableError);

        const firstValue = cacheableClientCachedValue.wait();
        await expect(firstValue).rejects.toThrow(cacheableError);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        const secondValue = cacheableClientCachedValue.wait();
        await expect(secondValue).rejects.toThrow(cacheableError);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});
