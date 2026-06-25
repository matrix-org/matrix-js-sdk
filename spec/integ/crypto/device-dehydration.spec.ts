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
import { IDBFactory } from "fake-indexeddb";
import fetchMock from "@fetch-mock/vitest";
import { type CallLog } from "fetch-mock";
import debug from "debug";

import { ClientEvent, createClient, DebugLogger, type MatrixClient, MatrixEvent } from "../../../src";
import { encodeBase64 } from "../../../src/base64";
import { type CryptoApi, CryptoEvent } from "../../../src/crypto-api/index";
import { type RustCrypto } from "../../../src/rust-crypto/rust-crypto";
import { type AddSecretStorageKeyOpts } from "../../../src/secret-storage";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { emitPromise, EventCounter } from "../../test-utils/test-utils";

describe("Device dehydration", () => {
    it("should rehydrate and dehydrate a device", async () => {
        vi.useFakeTimers();

        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
            cryptoCallbacks: {
                getSecretStorageKey: async (keys: any, name: string) => {
                    return [Object.keys(keys.keys)[0], new Uint8Array(32)];
                },
            },
            logger: new DebugLogger(debug(`matrix-js-sdk:dehydration`)),
        });

        await initializeSecretStorage(matrixClient, "@alice:localhost", "http://test.server");

        const creationEventCounter = new EventCounter(matrixClient, CryptoEvent.DehydratedDeviceCreated);
        const dehydrationKeyCachedEventCounter = new EventCounter(matrixClient, CryptoEvent.DehydrationKeyCached);
        const rehydrationStartedCounter = new EventCounter(matrixClient, CryptoEvent.RehydrationStarted);
        const rehydrationCompletedCounter = new EventCounter(matrixClient, CryptoEvent.RehydrationCompleted);
        const rehydrationProgressCounter = new EventCounter(matrixClient, CryptoEvent.RehydrationProgress);

        // count the number of times the dehydration key gets set
        let setDehydrationCount = 0;
        matrixClient.on(ClientEvent.AccountData, (event: MatrixEvent) => {
            if (event.getType() === "org.matrix.msc3814") {
                setDehydrationCount++;
            }
        });

        const crypto = matrixClient.getCrypto()!;

        // start dehydration -- we start with no dehydrated device, and we
        // store the dehydrated device that we create
        fetchMock.get(
            "path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device",
            {
                status: 404,
                body: {
                    errcode: "M_NOT_FOUND",
                    error: "Not found",
                },
            },
            { name: "get-dehydrated-device" },
        );
        let dehydratedDeviceBody: any;
        let dehydrationCount = 0;
        let resolveDehydrationPromise: () => void;
        fetchMock.put(
            "path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device",
            (callLog) => {
                dehydratedDeviceBody = JSON.parse(callLog.options.body as string);
                dehydrationCount++;
                if (resolveDehydrationPromise) {
                    resolveDehydrationPromise();
                }
                return {};
            },
            { name: "put-dehydrated-device" },
        );
        await crypto.startDehydration();

        expect(dehydrationCount).toEqual(1);
        expect(creationEventCounter.counter).toEqual(1);
        expect(dehydrationKeyCachedEventCounter.counter).toEqual(1);

        // a week later, we should have created another dehydrated device
        const dehydrationPromise = new Promise<void>((resolve, reject) => {
            resolveDehydrationPromise = resolve;
        });
        vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
        await dehydrationPromise;

        expect(dehydrationKeyCachedEventCounter.counter).toEqual(1);
        expect(dehydrationCount).toEqual(2);
        expect(creationEventCounter.counter).toEqual(2);

        // restart dehydration -- rehydrate the device that we created above,
        // and create a new dehydrated device.  We also set `createNewKey`, so
        // a new dehydration key will be set
        fetchMock.modifyRoute("get-dehydrated-device", {
            response: {
                device_id: dehydratedDeviceBody.device_id,
                device_data: dehydratedDeviceBody.device_data,
            },
        });
        const eventsResponse = vi.fn((callLog: CallLog) => {
            // rehydrating should make two calls to the /events endpoint.
            // The first time will return a single event, and the second
            // time will return no events (which will signal to the
            // rehydration function that it can stop)
            const body = JSON.parse(callLog.options.body as string);
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

        expect(rehydrationStartedCounter.counter).toEqual(1);
        expect(rehydrationCompletedCounter.counter).toEqual(1);
        expect(creationEventCounter.counter).toEqual(3);
        expect(rehydrationProgressCounter.counter).toEqual(1);
        expect(dehydrationKeyCachedEventCounter.counter).toEqual(2);

        // test that if we get an error when we try to rotate, it emits an event
        fetchMock.modifyRoute("put-dehydrated-device", {
            response: {
                status: 500,
                body: {
                    errcode: "M_UNKNOWN",
                    error: "Unknown error",
                },
            },
        });
        const rotationErrorEventPromise = emitPromise(matrixClient, CryptoEvent.DehydratedDeviceRotationError);
        vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
        await rotationErrorEventPromise;

        // Restart dehydration, but return an error for GET /dehydrated_device so that rehydration fails.
        fetchMock.modifyRoute("get-dehydrated-device", {
            response: {
                status: 500,
                body: {
                    errcode: "M_UNKNOWN",
                    error: "Unknown error",
                },
            },
        });
        fetchMock.modifyRoute("put-dehydrated-device", { response: { body: {} } });
        const rehydrationErrorEventPromise = emitPromise(matrixClient, CryptoEvent.RehydrationError);
        await crypto.startDehydration(true);
        await rehydrationErrorEventPromise;

        matrixClient.stopClient();
    });
});

describe("reconciling the dehydration key with secret storage", () => {
    const DEHYDRATED_DEVICE_PATH = "path:/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device";
    let matrixClient: MatrixClient;
    let crypto: CryptoApi;
    let keyCachedCounter: EventCounter;

    beforeEach(async () => {
        vi.useFakeTimers();
        // The rust crypto store uses a fixed indexeddb prefix, so reset the database for a fresh account.
        indexedDB = new IDBFactory();
        matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
            cryptoCallbacks: {
                getSecretStorageKey: async (keys: any) => [Object.keys(keys.keys)[0], new Uint8Array(32)],
            },
        });
        await initializeSecretStorage(matrixClient, "@alice:localhost", "http://test.server");
        crypto = matrixClient.getCrypto()!;

        // Start dehydration: this stores a fresh key in secret storage and caches it locally.
        fetchMock.get(DEHYDRATED_DEVICE_PATH, { status: 404, body: { errcode: "M_NOT_FOUND", error: "Not found" } });
        fetchMock.put(DEHYDRATED_DEVICE_PATH, {});
        await crypto.startDehydration();

        // Count dehydration-key caching from here on (i.e. only what reconciliation triggers).
        keyCachedCounter = new EventCounter(matrixClient, CryptoEvent.DehydrationKeyCached);
    });

    afterEach(() => {
        matrixClient.stopClient();
        vi.useRealTimers();
    });

    it("keeps using the cached key when secret storage is unchanged", async () => {
        await crypto.startDehydration({ rehydrate: false });
        expect(keyCachedCounter.counter).toBe(0);
    });

    it("adopts a dehydration key that another device rotated in secret storage", async () => {
        // Another of the user's devices replaced the key in 4S with a different one.
        const rotatedKey = encodeBase64(new Uint8Array(32).fill(1));
        await matrixClient.secretStorage.store("org.matrix.msc3814", rotatedKey);

        await crypto.startDehydration({ rehydrate: false });

        // The changed key was read from 4S and adopted (re-cached) locally.
        expect(keyCachedCounter.counter).toBe(1);
    });

    it("keeps the cached key (best-effort) when secret storage can't be read", async () => {
        vi.spyOn(matrixClient.secretStorage, "get").mockRejectedValueOnce(new Error("4S is locked"));

        // Reconciliation must not throw or block on a recovery-key prompt.
        await expect(crypto.startDehydration({ rehydrate: false })).resolves.toBeUndefined();
        expect(keyCachedCounter.counter).toBe(0);
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
    const accountData: Map<string, object> = new Map();
    fetchMock.get("glob:http://*/_matrix/client/v3/user/*/account_data/*", (callLog) => {
        const name = callLog.url.split("/").pop()!;
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
    fetchMock.put("glob:http://*/_matrix/client/v3/user/*/account_data/*", (callLog) => {
        const name = callLog.url.split("/").pop()!;
        const value = JSON.parse(callLog.options.body as string);
        accountData.set(name, value);
        matrixClient.emit(ClientEvent.AccountData, new MatrixEvent({ type: name, content: value }));
        return {};
    });

    await matrixClient.initRustCrypto();
    const crypto = matrixClient.getCrypto()! as RustCrypto;
    // we need to process a sync so that the OlmMachine will upload keys
    await crypto.preprocessToDeviceMessages([]);
    crypto.onSyncCompleted({});

    // create initial secret storage
    async function createSecretStorageKey() {
        return {
            keyInfo: {} as AddSecretStorageKeyOpts,
            privateKey: new Uint8Array(32),
        };
    }
    await matrixClient.getCrypto()!.bootstrapCrossSigning({ setupNewCrossSigning: true });
    await matrixClient.getCrypto()!.bootstrapSecretStorage({
        createSecretStorageKey,
        setupNewSecretStorage: true,
        setupNewKeyBackup: false,
    });
}
