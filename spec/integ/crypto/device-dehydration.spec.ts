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
import { RustCrypto } from "../../../src/rust-crypto/rust-crypto";
import { AddSecretStorageKeyOpts } from "../../../src/secret-storage";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";

describe("Device dehydration", () => {
    it("should rehydrate and dehydrate a device", async () => {
        jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

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

        // count the number of times the dehydration key gets set
        let setDehydrationCount = 0;
        matrixClient.on(ClientEvent.AccountData, (event: MatrixEvent) => {
            if (event.getType() === "org.matrix.msc3814") {
                setDehydrationCount++;
            }
        });

        const crypto = matrixClient.getCrypto()!;
        fetchMock.config.overwriteRoutes = true;

        // start dehydration -- we start with no dehydrated device, and we
        // store the dehydrated device that we create
        fetchMock.get("path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device", {
            status: 404,
            body: {
                errcode: "M_NOT_FOUND",
                error: "Not found",
            },
        });
        let dehydratedDeviceBody: any;
        let dehydrationCount = 0;
        let resolveDehydrationPromise: () => void;
        fetchMock.put("path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device", (_, opts) => {
            dehydratedDeviceBody = JSON.parse(opts.body as string);
            dehydrationCount++;
            if (resolveDehydrationPromise) {
                resolveDehydrationPromise();
            }
            return {};
        });
        await crypto.startDehydration();

        expect(dehydrationCount).toEqual(1);

        // a week later, we should have created another dehydrated device
        const dehydrationPromise = new Promise<void>((resolve, reject) => {
            resolveDehydrationPromise = resolve;
        });
        jest.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
        await dehydrationPromise;
        expect(dehydrationCount).toEqual(2);

        // restart dehydration -- rehydrate the device that we created above,
        // and create a new dehydrated device.  We also set `createNewKey`, so
        // a new dehydration key will be set
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
        await crypto.startDehydration(true);
        expect(dehydrationCount).toEqual(3);

        expect(setDehydrationCount).toEqual(2);
        expect(eventsResponse.mock.calls).toHaveLength(2);

        matrixClient.stopClient();
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
    const crypto = matrixClient.getCrypto()! as RustCrypto;
    // we need to process a sync so that the OlmMachine will upload keys
    await crypto.preprocessToDeviceMessages([]);
    await crypto.onSyncCompleted({});

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
