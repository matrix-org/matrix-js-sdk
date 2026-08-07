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

import { describe, vi, it, expect, type MockedObject, beforeEach, afterEach } from "vitest";
import { type MatrixClient, MatrixError } from "../../src";
import { logger } from "../../src/logger.ts";
import { createRtcTransportsCachedValue } from "../../src/rtcTransportsCachedValue.ts";
import { type PollingCachedValue } from "../../src/pollingCachedValue.ts";
import { type Transport } from "../../src/matrixrtc";

describe("RtcTransportsCachedValue", () => {
    let mockClient: MockedObject<MatrixClient>;
    let rtcTransportsCachedValue: PollingCachedValue<Transport[]>;

    beforeEach(() => {
        mockClient = {
            _unstable_getRTCTransports: vi.fn(),
            emit: vi.fn(),
        } as unknown as MockedObject<MatrixClient>;
        rtcTransportsCachedValue = createRtcTransportsCachedValue(mockClient, logger);
    });

    it("should fetch the transport using discovery api", async () => {
        const transport: Transport = { type: "livekit", livekit_service_url: "http://test.com" };

        mockClient._unstable_getRTCTransports.mockResolvedValue([transport]);

        const result = await rtcTransportsCachedValue.wait();

        expect(result).toEqual([transport]);
    });

    it("should not hammering server if end-point not supported", async () => {
        mockClient._unstable_getRTCTransports.mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));

        await rtcTransportsCachedValue.wait();
        await rtcTransportsCachedValue.wait();
        await rtcTransportsCachedValue.wait();

        expect(mockClient._unstable_getRTCTransports).toHaveBeenCalledTimes(1);

        expect(rtcTransportsCachedValue.get()).toBeUndefined();
    });

    describe("Auto Refresh", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("Should refresh once a day", async () => {
            const transport: Transport = { type: "livekit", livekit_service_url: "http://test.com" };

            // First no transports, then one
            mockClient._unstable_getRTCTransports.mockResolvedValueOnce([]).mockResolvedValueOnce([transport]);

            const result = await rtcTransportsCachedValue.wait();

            expect(result).toStrictEqual([]);

            await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // Advance 1h
            expect(await rtcTransportsCachedValue.wait()).toStrictEqual([]);

            await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // Advance by one day

            // Should have been refreshed automatically
            expect(rtcTransportsCachedValue.get()).toStrictEqual([transport]);
        });
    });
});
