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

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { CapabilityPoller } from "../../src/capabilityPoller.ts";
import type { MatrixHttpApi, IHttpOpts } from "../../src/http-api/index.ts";
import { logger } from "../../src/logger.ts";

const CAPABILITIES_CACHE_MS = 6 * 60 * 60 * 1000;
const CAPABILITIES_RETRY_MS = 30 * 1000;

class MockCapabilityPoller extends CapabilityPoller<string> {
    public constructor(
        http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
        public readonly fetchFn: Mock<() => Promise<string>>,
    ) {
        super(logger, http, "mock capabilities");
    }

    public async fetch(): Promise<string> {
        const val = await this.fetchFn();
        this.cached = val;
        return val;
    }

    // Expose cached for testing purposes
    public setCached(value: string | undefined): void {
        this.cached = value;
    }
}

describe("CapabilityPoller", () => {
    let fetchFn: Mock<() => Promise<string>>;
    let poller: MockCapabilityPoller;
    let http: MatrixHttpApi<IHttpOpts & { onlyData: true }>;
    let updateCallback: Mock<(value: string) => void>;

    beforeEach(() => {
        vi.useFakeTimers();
        fetchFn = vi.fn();
        updateCallback = vi.fn();
        http = {} as MatrixHttpApi<IHttpOpts & { onlyData: true }>;
        poller = new MockCapabilityPoller(http, fetchFn);
        poller.on("update", updateCallback);
    });

    afterEach(() => {
        poller.stop();
        vi.useRealTimers();
    });

    it("should fetch and cache the value", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        poller.start();
        await vi.advanceTimersByTimeAsync(1);

        expect(poller.getCached()).toBe("HelloWorld!");
        expect(updateCallback).toHaveBeenCalledWith("HelloWorld!");
    });

    it("should not emit update if the value hasn't changed", async () => {
        poller.setCached("HelloWorld!");
        fetchFn.mockResolvedValue("HelloWorld!");

        poller.start();
        await vi.advanceTimersByTimeAsync(1);

        expect(poller.getCached()).toBe("HelloWorld!");
        expect(updateCallback).not.toHaveBeenCalled();
    });

    it("should schedule a refresh after caching", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        poller.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        fetchFn.mockResolvedValue("NewValue!");
        await vi.advanceTimersByTimeAsync(CAPABILITIES_CACHE_MS);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(poller.getCached()).toBe("NewValue!");
        expect(updateCallback).toHaveBeenCalledWith("NewValue!");
    });

    it("should schedule a retry on failure", async () => {
        fetchFn.mockRejectedValue(new Error("Network Error"));

        poller.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        fetchFn.mockResolvedValue("Recovered!");
        // The retry adds a random jitter of up to 5000ms
        await vi.advanceTimersByTimeAsync(CAPABILITIES_RETRY_MS + 5000);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(poller.getCached()).toBe("Recovered!");
        expect(updateCallback).toHaveBeenCalledWith("Recovered!");
    });

    it("should not schedule timeouts or emit if stopped while fetching resolves", async () => {
        const { promise, resolve } = Promise.withResolvers<string>();
        fetchFn.mockReturnValue(promise);

        poller.start();

        // Wait for the poll to start awaiting fetch
        await Promise.resolve();

        poller.stop();
        resolve("HelloWorld!");

        await vi.advanceTimersByTimeAsync(1);

        expect(updateCallback).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("should not schedule timeouts if stopped while fetching rejects", async () => {
        const { promise, reject } = Promise.withResolvers<string>();
        fetchFn.mockReturnValue(promise);

        poller.start();

        // Wait for the poll to start awaiting fetch
        await Promise.resolve();

        poller.stop();
        reject(new Error("Failed"));

        await vi.advanceTimersByTimeAsync(1);

        expect(vi.getTimerCount()).toBe(0);
    });

    it("should cancel existing timeouts when stopped", async () => {
        fetchFn.mockResolvedValue("HelloWorld!");

        poller.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(vi.getTimerCount()).toBe(1);

        poller.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
