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

import { afterEach, beforeEach, describe, vi, it, expect } from "vitest";
import { ClientCachedValue } from "../../src/clientCachedValue.ts";
import { MatrixError } from "../../src";
import { logger } from "../../src/logger.ts";

class MockClientCachedValue extends ClientCachedValue<string> {
    public fetchFn = vi.fn();
    public cachedCallback = vi.fn();

    protected async fetch(client: any): Promise<string> {
        return this.fetchFn();
    }

    protected valueCached(value: string) {
        this.cachedCallback(value);
    }
}

class ShouldCacheErrorClientCachedValue extends MockClientCachedValue {
    protected override shouldCacheError(error: any): boolean {
        return true;
    }
}

describe("ClientCachedValue", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const TTL = 10000;
    const mockClient = {} as any;
    let clientCachedValue: MockClientCachedValue;

    beforeEach(() => {
        clientCachedValue = new MockClientCachedValue("mock", mockClient, TTL, logger);
    });

    it("should fetch and cache the value", async () => {
        clientCachedValue.fetchFn.mockResolvedValue("HelloWorld!");

        const value = await clientCachedValue.wait();

        expect(value).toBe("HelloWorld!");
        expect(clientCachedValue.get()).toBe("HelloWorld!");
        expect(clientCachedValue.cachedCallback).toHaveBeenCalledWith("HelloWorld!");
    });

    it("should not call again once the value is cached", async () => {
        clientCachedValue.fetchFn.mockResolvedValue("HelloWorld!");

        const value = await clientCachedValue.wait();

        expect(value).toBe("HelloWorld!");

        // ask the value again
        await clientCachedValue.wait();

        expect(clientCachedValue.get()).toBe("HelloWorld!");
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should expire the cache after the specified time", async () => {
        clientCachedValue.fetchFn.mockResolvedValue("HelloWorld!");

        const value = await clientCachedValue.wait();
        expect(value).toBe("HelloWorld!");

        clientCachedValue.fetchFn.mockResolvedValue("NewValue!");

        // Within the refresh period, so still the old value
        await vi.advanceTimersByTimeAsync(TTL / 2);
        expect(await clientCachedValue.wait()).toBe("HelloWorld!");

        // advance time by 1001ms to trigger cache expiration
        await vi.advanceTimersByTimeAsync(TTL / 2 + 10);

        const newValue = await clientCachedValue.wait();
        expect(newValue).toBe("NewValue!");

        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should automatically retry limit exceeded transient errors", async () => {
        clientCachedValue.fetchFn.mockImplementation(() => {
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

        clientCachedValue.fetchFn.mockResolvedValue("OOO");
        await vi.advanceTimersByTimeAsync(2000);

        const value = await fetchPromise;
        expect(value).toBe("OOO");
        expect(settled).toBe(true);

        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should start fetching and avoid scheduling refresh once stopped", async () => {
        const resolver = Promise.withResolvers<string>();
        clientCachedValue.fetchFn.mockImplementation(() => resolver.promise);

        clientCachedValue.start();
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(1);

        clientCachedValue.stop();
        resolver.resolve("FromStart");
        await clientCachedValue.wait();

        expect(clientCachedValue.get()).toBe("FromStart");

        await vi.advanceTimersByTimeAsync(TTL + 10);
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(1);
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

        clientCachedValue = new MockClientCachedValue("mock", mockClient, undefined, logger);
        clientCachedValue.start();
        await vi.advanceTimersByTimeAsync(100);

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        setTimeoutSpy.mockRestore();
    });

    it("should retry fetch on next wait for non-cacheable errors", async () => {
        const nonRetryableError = new MatrixError({ errcode: "M_FORBIDDEN", error: "Forbidden" }, 403);
        clientCachedValue.fetchFn.mockRejectedValueOnce(nonRetryableError).mockResolvedValueOnce("Recovered");

        const firstValue = await clientCachedValue.wait();
        expect(firstValue).toBeUndefined();
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(1);
        expect(clientCachedValue.get()).toBeUndefined();

        const secondValue = await clientCachedValue.wait();
        expect(secondValue).toBe("Recovered");
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should stop retrying immediately when stopped during fetch error", async () => {
        const retryableError = new MatrixError(
            { errcode: "M_LIMIT_EXCEEDED", error: "Too many requests", retry_after_ms: 1000 },
            429,
        );
        clientCachedValue.fetchFn.mockRejectedValue(retryableError);
        clientCachedValue.stop();

        const value = await clientCachedValue.wait();
        expect(value).toBeUndefined();
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should reuse same promise for rapid calls", async () => {
        const loader = Promise.withResolvers<string>();
        clientCachedValue.fetchFn.mockImplementation(() => loader.promise);

        const race = Promise.race([clientCachedValue.wait(), clientCachedValue.wait(), clientCachedValue.wait()]);

        await vi.runOnlyPendingTimersAsync();

        loader.resolve("FOO");
        const value = await race;
        expect(value).toBe("FOO");
        expect(clientCachedValue.fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should reuse rejected promise when error is marked cacheable", async () => {
        const cacheableError = new MatrixError({ errcode: "M_FORBIDDEN", error: "Forbidden" }, 403);
        const cacheableClientCachedValue = new ShouldCacheErrorClientCachedValue("mock", mockClient, TTL, logger);
        cacheableClientCachedValue.fetchFn.mockRejectedValue(cacheableError);

        const firstValue = await cacheableClientCachedValue.wait();
        expect(firstValue).toBeUndefined();
        expect(cacheableClientCachedValue.fetchFn).toHaveBeenCalledTimes(1);

        const secondValue = await cacheableClientCachedValue.wait();
        expect(secondValue).toBeUndefined();
        expect(cacheableClientCachedValue.fetchFn).toHaveBeenCalledTimes(1);
    });
});
