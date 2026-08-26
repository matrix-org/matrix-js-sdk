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

import debug from "debug";
import { type MockInstance, type Mocked } from "vitest";

import { DebugLogger, type ISyncResponse } from "../../src";
import { SyncApi } from "../../src/sync";
import { type SyncCryptoCallbacks } from "../../src/common-crypto/CryptoBackend";
import { TestClient } from "../TestClient";

describe("SyncApi", () => {
    describe("processSyncResponse", () => {
        let cryptoCallbacks: Mocked<SyncCryptoCallbacks>;
        let syncApi: SyncApi;

        beforeEach(() => {
            cryptoCallbacks = {
                preprocessToDeviceMessages: vi.fn().mockResolvedValue([]),
                processKeyCounts: vi.fn().mockResolvedValue(undefined),
                processDeviceLists: vi.fn().mockResolvedValue(undefined),
                onCryptoEvent: vi.fn().mockResolvedValue(undefined),
                onSyncCompleted: vi.fn(),
            } as unknown as Mocked<SyncCryptoCallbacks>;

            const testClient = new TestClient("@alice:localhost", "DEVICE_ID");
            syncApi = new SyncApi(testClient.client, undefined, {
                cryptoCallbacks,
                logger: new DebugLogger(debug("matrix-js-sdk:test:sync")),
            });
        });

        /** The position of the first call to `mock` in the overall sequence of mock invocations */
        function firstCallOrder(mock: MockInstance): number {
            return mock.mock.invocationCallOrder[0];
        }

        it("processes one-time key counts before to-device messages and device list changes", async () => {
            const toDeviceEvent = { type: "org.example.test", sender: "@bob:localhost", content: {} };
            const syncResponse: ISyncResponse = {
                next_batch: "1",
                rooms: { invite: {}, join: {}, leave: {}, knock: {} },
                account_data: { events: [] },
                to_device: { events: [toDeviceEvent] },
                device_lists: { changed: ["@bob:localhost"] },
                device_one_time_keys_count: { signed_curve25519: 42 },
                device_unused_fallback_key_types: ["signed_curve25519"],
            };

            // @ts-ignore calling a private method
            await syncApi.processSyncResponse({ nextSyncToken: "1" }, syncResponse);

            expect(cryptoCallbacks.processKeyCounts).toHaveBeenCalledExactlyOnceWith({ signed_curve25519: 42 }, [
                "signed_curve25519",
            ]);
            expect(cryptoCallbacks.preprocessToDeviceMessages).toHaveBeenCalledExactlyOnceWith([toDeviceEvent]);
            expect(cryptoCallbacks.processDeviceLists).toHaveBeenCalledExactlyOnceWith({ changed: ["@bob:localhost"] });

            // The crypto layer has to give the OlmMachine a one-time key count when processing to-device messages
            // and device list changes, so it must learn the count from this sync response first.
            expect(firstCallOrder(cryptoCallbacks.processKeyCounts)).toBeLessThan(
                firstCallOrder(cryptoCallbacks.preprocessToDeviceMessages),
            );
            expect(firstCallOrder(cryptoCallbacks.processKeyCounts)).toBeLessThan(
                firstCallOrder(cryptoCallbacks.processDeviceLists),
            );
        });

        it("passes the unstable-prefixed unused fallback key types to the crypto layer", async () => {
            const syncResponse: ISyncResponse = {
                "next_batch": "1",
                "rooms": { invite: {}, join: {}, leave: {}, knock: {} },
                "account_data": { events: [] },
                "device_one_time_keys_count": { signed_curve25519: 42 },
                "org.matrix.msc2732.device_unused_fallback_key_types": ["signed_curve25519"],
            };

            // @ts-ignore calling a private method
            await syncApi.processSyncResponse({ nextSyncToken: "1" }, syncResponse);

            expect(cryptoCallbacks.processKeyCounts).toHaveBeenCalledExactlyOnceWith({ signed_curve25519: 42 }, [
                "signed_curve25519",
            ]);
        });
    });
});
