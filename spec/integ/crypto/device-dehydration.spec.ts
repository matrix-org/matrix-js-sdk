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

import "fake-indexeddb/auto";
import fetchMock from "fetch-mock-jest";

import { createClient, ClientEvent, MatrixClient, MatrixEvent } from "../../../src";
import { AddSecretStorageKeyOpts } from "../../../src/secret-storage";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";

describe("Device dehydration", () => {
    it("should rehydrate and dehydrate a device", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
            cryptoCallbacks: {
                getSecretStorageKey: async (keys: any, name: string) => {
                    return [[...Object.keys(keys.keys)][0], new Uint8Array(32)];
                },
            },
        });

        await initializeSecretStorage(matrixClient, "@alice:localhost", "http://test.server");

        const crypto = matrixClient.getCrypto()!;
        fetchMock.config.overwriteRoutes = true;

        // try to rehydrate, but there isn't any dehydrated device yet
        fetchMock.get("path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device", {
            status: 404,
            body: {
                errcode: "M_NOT_FOUND",
                error: "Not found",
            },
        });
        expect(await crypto.rehydrateDeviceIfAvailable()).toBe(false);

        // create a dehydrated device
        let dehydratedDeviceBody: any;
        fetchMock.put("path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device", (_, opts) => {
            dehydratedDeviceBody = JSON.parse(opts.body as string);
            return {};
        });
        await crypto.createAndUploadDehydratedDevice();

        // rehydrate the device that we just created
        fetchMock.get("path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device", {
            device_id: dehydratedDeviceBody.device_id,
            device_data: dehydratedDeviceBody.device_data,
        });
        const eventsResponse = jest.fn((url, opts) => {
            // rehydrating should make two calls to the /events endpoint.
            // The first time will return a single event, and the second
            // time will return no events (which will signal to the
            // rehydration function that it can stop)
            const body = JSON.parse(opts.body as string);
            const nextBatch = body.next_batch ?? "0";
            const events = nextBatch === "0" ? [{ sender: "@alice:localhost", type: "m.dummy", content: {} }] : [];
            return {
                events,
                next_batch: nextBatch + "1",
            };
        });
        fetchMock.post(
            `path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device/${encodeURIComponent(dehydratedDeviceBody.device_id)}/events`,
            eventsResponse,
        );

        expect(await crypto.rehydrateDeviceIfAvailable()).toBe(true);
        expect(eventsResponse.mock.calls).toHaveLength(2);
    });
});

/** create a new secret storage and cross-signing keys */
async function initializeSecretStorage(
    matrixClient: MatrixClient,
    userId: string,
    homeserverUrl: string,
): Promise<void> {
    fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
        status: 404,
        body: {
            errcode: "M_NOT_FOUND",
            error: "Not found",
        },
    });
    const e2eKeyReceiver = new E2EKeyReceiver(homeserverUrl);
    const e2eKeyResponder = new E2EKeyResponder(homeserverUrl);
    e2eKeyResponder.addKeyReceiver(userId, e2eKeyReceiver);
    fetchMock.post("path:/_matrix/client/v3/keys/device_signing/upload", {});
    fetchMock.post("path:/_matrix/client/v3/keys/signatures/upload", {});
    const accountData: Map<string, object> = new Map();
    fetchMock.get("glob:http://*/_matrix/client/v3/user/*/account_data/*", (url, opts) => {
        const name = url.split("/").pop()!;
        const value = accountData.get(name);
        if (value) {
            return value;
        } else {
            return {
                status: 404,
                body: {
                    errcode: "M_NOT_FOUND",
                    error: "Not found",
                },
            };
        }
    });
    fetchMock.put("glob:http://*/_matrix/client/v3/user/*/account_data/*", (url, opts) => {
        const name = url.split("/").pop()!;
        const value = JSON.parse(opts.body as string);
        accountData.set(name, value);
        matrixClient.emit(ClientEvent.AccountData, new MatrixEvent({ type: name, content: value }));
        return {};
    });

    await matrixClient.initRustCrypto();

    // create initial secret storage
    async function createSecretStorageKey() {
        return {
            keyInfo: {} as AddSecretStorageKeyOpts,
            privateKey: new Uint8Array(32),
        };
    }
    await matrixClient.bootstrapCrossSigning({ setupNewCrossSigning: true });
    await matrixClient.bootstrapSecretStorage({
        createSecretStorageKey,
        setupNewSecretStorage: true,
        setupNewKeyBackup: false,
    });
}
