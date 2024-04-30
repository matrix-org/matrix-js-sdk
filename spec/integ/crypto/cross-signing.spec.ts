/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import fetchMock from "fetch-mock-jest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { CRYPTO_BACKENDS, InitCrypto, syncPromise } from "../../test-utils/test-utils";
import { AuthDict, createClient, CryptoEvent, MatrixClient } from "../../../src";
import { mockInitialApiRequests, mockSetupCrossSigningRequests } from "../../test-utils/mockEndpoints";
import { encryptAES } from "../../../src/crypto/aes";
import { CryptoCallbacks, CrossSigningKey } from "../../../src/crypto-api";
import { SECRET_STORAGE_ALGORITHM_V1_AES } from "../../../src/secret-storage";
import { ISyncResponder, SyncResponder } from "../../test-utils/SyncResponder";
import { E2EKeyReceiver } from "../../test-utils/E2EKeyReceiver";
import {
    MASTER_CROSS_SIGNING_PRIVATE_KEY_BASE64,
    SELF_CROSS_SIGNING_PRIVATE_KEY_BASE64,
    SELF_CROSS_SIGNING_PUBLIC_KEY_BASE64,
    SIGNED_CROSS_SIGNING_KEYS_DATA,
    SIGNED_TEST_DEVICE_DATA,
    USER_CROSS_SIGNING_PRIVATE_KEY_BASE64,
} from "../../test-utils/test-data";
import * as testData from "../../test-utils/test-data";
import { E2EKeyResponder } from "../../test-utils/E2EKeyResponder";
import { AccountDataAccumulator } from "../../test-utils/AccountDataAccumulator";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

const TEST_USER_ID = "@alice:localhost";
const TEST_DEVICE_ID = "xzcvb";

/**
 * Integration tests for cross-signing functionality.
 *
 * These tests work by intercepting HTTP requests via fetch-mock rather than mocking out bits of the client, so as
 * to provide the most effective integration tests possible.
 */
describe.each(Object.entries(CRYPTO_BACKENDS))("cross-signing (%s)", (backend: string, initCrypto: InitCrypto) => {
    // newBackendOnly is the opposite to `oldBackendOnly`: it will skip the test if we are running against the legacy
    // backend. Once we drop support for legacy crypto, it will go away.
    const newBackendOnly = backend === "rust-sdk" ? test : test.skip;

    let aliceClient: MatrixClient;

    /** an object which intercepts `/sync` requests from {@link #aliceClient} */
    let syncResponder: ISyncResponder;

    /** an object which intercepts `/keys/query` requests on the test homeserver */
    let e2eKeyResponder: E2EKeyResponder;

    // Encryption key used to encrypt cross signing keys
    const encryptionKey = new Uint8Array(32);

    /**
     * Create the {@link CryptoCallbacks}
     */
    function createCryptoCallbacks(): CryptoCallbacks {
        return {
            getSecretStorageKey: (keys, name) => {
                return Promise.resolve<[string, Uint8Array]>(["key_id", encryptionKey]);
            },
        };
    }

    beforeEach(
        async () => {
            // anything that we don't have a specific matcher for silently returns a 404
            fetchMock.catch(404);
            fetchMock.config.warnOnFallback = false;

            const homeserverUrl = "https://alice-server.com";
            aliceClient = createClient({
                baseUrl: homeserverUrl,
                userId: TEST_USER_ID,
                accessToken: "akjgkrgjs",
                deviceId: TEST_DEVICE_ID,
                cryptoCallbacks: createCryptoCallbacks(),
            });

            syncResponder = new SyncResponder(homeserverUrl);
            e2eKeyResponder = new E2EKeyResponder(homeserverUrl);
            /** an object which intercepts `/keys/upload` requests on the test homeserver */
            new E2EKeyReceiver(homeserverUrl);

            // Silence warnings from the backup manager
            fetchMock.getOnce(new URL("/_matrix/client/v3/room_keys/version", homeserverUrl).toString(), {
                status: 404,
                body: { errcode: "M_NOT_FOUND" },
            });

            await initCrypto(aliceClient);
        },
        /* it can take a while to initialise the crypto library on the first pass, so bump up the timeout. */
        10000,
    );

    afterEach(async () => {
        await aliceClient.stopClient();
        fetchMock.mockReset();
    });

    /**
     * Create cross-signing keys and publish the keys
     *
     * @param authDict - The parameters to as the `auth` dict in the key upload request.
     * @see https://spec.matrix.org/v1.6/client-server-api/#authentication-types
     */
    async function bootstrapCrossSigning(authDict: AuthDict): Promise<void> {
        await aliceClient.getCrypto()?.bootstrapCrossSigning({
            authUploadDeviceSigningKeys: (makeRequest) => makeRequest(authDict).then(() => undefined),
        });
    }

    describe("bootstrapCrossSigning (before initialsync completes)", () => {
        it("publishes keys if none were yet published", async () => {
            mockSetupCrossSigningRequests();

            // provide a UIA callback, so that the cross-signing keys are uploaded
            const authDict = { type: "test" };
            await bootstrapCrossSigning(authDict);

            // check the cross-signing keys upload
            expect(fetchMock.called("upload-keys")).toBeTruthy();
            const [, keysOpts] = fetchMock.lastCall("upload-keys")!;
            const keysBody = JSON.parse(keysOpts!.body as string);
            expect(keysBody.auth).toEqual(authDict); // check uia dict was passed
            // there should be a key of each type
            // master key is signed by the device
            expect(keysBody).toHaveProperty(`master_key.signatures.[${TEST_USER_ID}].[ed25519:${TEST_DEVICE_ID}]`);
            const masterKeyId = Object.keys(keysBody.master_key.keys)[0];
            // ssk and usk are signed by the master key
            expect(keysBody).toHaveProperty(`self_signing_key.signatures.[${TEST_USER_ID}].[${masterKeyId}]`);
            expect(keysBody).toHaveProperty(`user_signing_key.signatures.[${TEST_USER_ID}].[${masterKeyId}]`);
            const sskId = Object.keys(keysBody.self_signing_key.keys)[0];

            // check the publish call
            expect(fetchMock.called("upload-sigs")).toBeTruthy();
            const [, sigsOpts] = fetchMock.lastCall("upload-sigs")!;
            const body = JSON.parse(sigsOpts!.body as string);
            // there should be a signature for our device, by our self-signing key.
            expect(body).toHaveProperty(
                `[${TEST_USER_ID}].[${TEST_DEVICE_ID}].signatures.[${TEST_USER_ID}].[${sskId}]`,
            );
        });

        newBackendOnly("get cross signing keys from secret storage and import them", async () => {
            // Return public cross signing keys
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);

            mockInitialApiRequests(aliceClient.getHomeserverUrl());

            // Encrypt the private keys and return them in the /sync response as if they are in Secret Storage
            const masterKey = await encryptAES(
                MASTER_CROSS_SIGNING_PRIVATE_KEY_BASE64,
                encryptionKey,
                "m.cross_signing.master",
            );
            const selfSigningKey = await encryptAES(
                SELF_CROSS_SIGNING_PRIVATE_KEY_BASE64,
                encryptionKey,
                "m.cross_signing.self_signing",
            );
            const userSigningKey = await encryptAES(
                USER_CROSS_SIGNING_PRIVATE_KEY_BASE64,
                encryptionKey,
                "m.cross_signing.user_signing",
            );

            syncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                account_data: {
                    events: [
                        {
                            type: "m.cross_signing.master",
                            content: {
                                encrypted: {
                                    key_id: masterKey,
                                },
                            },
                        },
                        {
                            type: "m.cross_signing.self_signing",
                            content: {
                                encrypted: {
                                    key_id: selfSigningKey,
                                },
                            },
                        },
                        {
                            type: "m.cross_signing.user_signing",
                            content: {
                                encrypted: {
                                    key_id: userSigningKey,
                                },
                            },
                        },
                        {
                            type: "m.secret_storage.key.key_id",
                            content: {
                                key: "key_id",
                                algorithm: SECRET_STORAGE_ALGORITHM_V1_AES,
                            },
                        },
                    ],
                },
            });
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            // we expect a request to upload signatures for our device ...
            fetchMock.post({ url: "path:/_matrix/client/v3/keys/signatures/upload", name: "upload-sigs" }, {});

            // we expect the UserTrustStatusChanged event to be fired after the cross signing keys import
            const userTrustStatusChangedPromise = new Promise<string>((resolve) =>
                aliceClient.on(CryptoEvent.UserTrustStatusChanged, resolve),
            );

            const authDict = { type: "test" };
            await bootstrapCrossSigning(authDict);

            // Check if the UserTrustStatusChanged event was fired
            expect(await userTrustStatusChangedPromise).toBe(aliceClient.getUserId());

            // Expect the signature to be uploaded
            expect(fetchMock.called("upload-sigs")).toBeTruthy();
            const [, sigsOpts] = fetchMock.lastCall("upload-sigs")!;
            const body = JSON.parse(sigsOpts!.body as string);
            // the device should have a signature with the public self cross signing keys.
            expect(body).toHaveProperty(
                `[${TEST_USER_ID}].[${TEST_DEVICE_ID}].signatures.[${TEST_USER_ID}].[ed25519:${SELF_CROSS_SIGNING_PUBLIC_KEY_BASE64}]`,
            );
        });

        it("can bootstrapCrossSigning twice", async () => {
            mockSetupCrossSigningRequests();

            const authDict = { type: "test" };
            await bootstrapCrossSigning(authDict);

            // a second call should do nothing except GET requests
            fetchMock.mockClear();
            await bootstrapCrossSigning(authDict);
            const calls = fetchMock.calls((url, opts) => opts.method != "GET");
            expect(calls.length).toEqual(0);
        });

        newBackendOnly("will upload existing cross-signing keys to an established secret storage", async () => {
            // This rather obscure codepath covers the case that:
            //   - 4S is set up and working
            //   - our device has private cross-signing keys, but has not published them to 4S
            //
            // To arrange that, we call `bootstrapCrossSigning` on our main device, and then (pretend to) set up 4S from
            // a *different* device. Then, when we call `bootstrapCrossSigning` again, it should do the honours.

            mockSetupCrossSigningRequests();
            const accountDataAccumulator = new AccountDataAccumulator();
            accountDataAccumulator.interceptGetAccountData();

            const authDict = { type: "test" };
            await bootstrapCrossSigning(authDict);

            // Pretend that another device has uploaded a 4S key
            accountDataAccumulator.accountDataEvents.set("m.secret_storage.default_key", { key: "key_id" });
            accountDataAccumulator.accountDataEvents.set("m.secret_storage.key.key_id", {
                key: "keykeykey",
                algorithm: SECRET_STORAGE_ALGORITHM_V1_AES,
            });

            // Prepare for the cross-signing keys
            const p = accountDataAccumulator.interceptSetAccountData(":type(m.cross_signing..*)");

            await bootstrapCrossSigning(authDict);
            await p;

            // The cross-signing keys should have been uploaded
            expect(accountDataAccumulator.accountDataEvents.has("m.cross_signing.master")).toBeTruthy();
            expect(accountDataAccumulator.accountDataEvents.has("m.cross_signing.self_signing")).toBeTruthy();
            expect(accountDataAccumulator.accountDataEvents.has("m.cross_signing.user_signing")).toBeTruthy();
        });
    });

    describe("getCrossSigningStatus()", () => {
        it("should return correct values without bootstrapping cross-signing", async () => {
            mockSetupCrossSigningRequests();

            const crossSigningStatus = await aliceClient.getCrypto()!.getCrossSigningStatus();

            // Expect the cross signing keys to be unavailable
            expect(crossSigningStatus).toStrictEqual({
                publicKeysOnDevice: false,
                privateKeysInSecretStorage: false,
                privateKeysCachedLocally: { masterKey: false, userSigningKey: false, selfSigningKey: false },
            });
        });

        it("should return correct values after bootstrapping cross-signing", async () => {
            mockSetupCrossSigningRequests();

            // provide a UIA callback, so that the cross-signing keys are uploaded
            const authDict = { type: "test" };
            await bootstrapCrossSigning(authDict);

            const crossSigningStatus = await aliceClient.getCrypto()!.getCrossSigningStatus();

            // Expect the cross signing keys to be available
            expect(crossSigningStatus).toStrictEqual({
                publicKeysOnDevice: true,
                privateKeysInSecretStorage: false,
                privateKeysCachedLocally: { masterKey: true, userSigningKey: true, selfSigningKey: true },
            });
        });
    });

    describe("isCrossSigningReady()", () => {
        it("should return false if cross-signing is not bootstrapped", async () => {
            mockSetupCrossSigningRequests();

            const isCrossSigningReady = await aliceClient.getCrypto()!.isCrossSigningReady();

            expect(isCrossSigningReady).toBeFalsy();
        });

        it("should return true after bootstrapping cross-signing", async () => {
            mockSetupCrossSigningRequests();
            await bootstrapCrossSigning({ type: "test" });

            const isCrossSigningReady = await aliceClient.getCrypto()!.isCrossSigningReady();

            expect(isCrossSigningReady).toBeTruthy();
        });

        it("should return false if identity is not trusted, even if the secrets are in 4S", async () => {
            e2eKeyResponder.addCrossSigningData(SIGNED_CROSS_SIGNING_KEYS_DATA);

            // Complete initial sync, to get the 4S account_data events stored
            mockInitialApiRequests(aliceClient.getHomeserverUrl());

            // For this test we need to have a well-formed 4S setup.
            const mockSecretInfo = {
                encrypted: {
                    // Don't care about the actual values here, just need to be present for validation
                    KeyId: {
                        iv: "IVIVIVIVIVIVIV",
                        ciphertext: "CIPHERTEXTB64",
                        mac: "MACMACMAC",
                    },
                },
            };
            syncResponder.sendOrQueueSyncResponse({
                next_batch: 1,
                account_data: {
                    events: [
                        {
                            type: "m.secret_storage.key.KeyId",
                            content: {
                                algorithm: "m.secret_storage.v1.aes-hmac-sha2",
                                // iv and mac not relevant for this test
                            },
                        },
                        {
                            type: "m.secret_storage.default_key",
                            content: {
                                key: "KeyId",
                            },
                        },
                        {
                            type: "m.cross_signing.master",
                            content: mockSecretInfo,
                        },
                        {
                            type: "m.cross_signing.user_signing",
                            content: mockSecretInfo,
                        },
                        {
                            type: "m.cross_signing.self_signing",
                            content: mockSecretInfo,
                        },
                    ],
                },
            });
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            // Sanity: ensure that the secrets are in 4S
            const status = await aliceClient.getCrypto()!.getCrossSigningStatus();
            expect(status.privateKeysInSecretStorage).toBeTruthy();

            const isCrossSigningReady = await aliceClient.getCrypto()!.isCrossSigningReady();

            expect(isCrossSigningReady).toBeFalsy();
        });
    });

    describe("getCrossSigningKeyId", () => {
        /**
         * Intercept /keys/device_signing/upload request and return the cross signing keys
         * https://spec.matrix.org/v1.7/client-server-api/#post_matrixclientv3keysdevice_signingupload
         *
         * @returns the cross signing keys
         */
        function awaitCrossSigningKeysUpload() {
            return new Promise<any>((resolve) => {
                fetchMock.post(
                    // legacy crypto uses /unstable/; /v3/ is correct
                    {
                        url: new RegExp("/_matrix/client/(unstable|v3)/keys/device_signing/upload"),
                        name: "upload-keys",
                    },
                    (url, options) => {
                        const content = JSON.parse(options.body as string);
                        resolve(content);
                        return {};
                    },
                    // Override the routes define in `mockSetupCrossSigningRequests`
                    { overwriteRoutes: true },
                );
            });
        }

        it("should return the cross signing key id for each cross signing key", async () => {
            mockSetupCrossSigningRequests();

            // Intercept cross signing keys upload
            const crossSigningKeysPromise = awaitCrossSigningKeysUpload();

            // provide a UIA callback, so that the cross-signing keys are uploaded
            const authDict = { type: "test" };
            await bootstrapCrossSigning(authDict);
            // Get the cross signing keys
            const crossSigningKeys = await crossSigningKeysPromise;

            const getPubKey = (crossSigningKey: any) => Object.values(crossSigningKey!.keys)[0];

            const masterKeyId = await aliceClient.getCrypto()!.getCrossSigningKeyId();
            expect(masterKeyId).toBe(getPubKey(crossSigningKeys.master_key));

            const selfSigningKeyId = await aliceClient.getCrypto()!.getCrossSigningKeyId(CrossSigningKey.SelfSigning);
            expect(selfSigningKeyId).toBe(getPubKey(crossSigningKeys.self_signing_key));

            const userSigningKeyId = await aliceClient.getCrypto()!.getCrossSigningKeyId(CrossSigningKey.UserSigning);
            expect(userSigningKeyId).toBe(getPubKey(crossSigningKeys.user_signing_key));
        });
    });

    describe("crossSignDevice", () => {
        beforeEach(async () => {
            // We want to use fake timers, but the wasm bindings of matrix-sdk-crypto rely on a working `queueMicrotask`.
            jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });

            // make sure that there is another device which we can sign
            e2eKeyResponder.addDeviceKeys(SIGNED_TEST_DEVICE_DATA);

            // Complete initialsync, to get the outgoing requests going
            mockInitialApiRequests(aliceClient.getHomeserverUrl());
            syncResponder.sendOrQueueSyncResponse({ next_batch: 1 });
            await aliceClient.startClient();
            await syncPromise(aliceClient);

            // Wait for legacy crypto to find the device
            await jest.advanceTimersByTimeAsync(10);

            const devices = await aliceClient.getCrypto()!.getUserDeviceInfo([aliceClient.getSafeUserId()]);
            expect(devices.get(aliceClient.getSafeUserId())!.has(testData.TEST_DEVICE_ID)).toBeTruthy();
        });

        afterEach(async () => {
            jest.useRealTimers();
        });

        it("fails for an unknown device", async () => {
            await expect(aliceClient.getCrypto()!.crossSignDevice("unknown")).rejects.toThrow("Unknown device");
        });

        it("cross-signs the device", async () => {
            mockSetupCrossSigningRequests();
            await aliceClient.getCrypto()!.bootstrapCrossSigning({});

            fetchMock.mockClear();
            await aliceClient.getCrypto()!.crossSignDevice(testData.TEST_DEVICE_ID);

            // check that a sig for the device was uploaded
            const calls = fetchMock.calls("upload-sigs");
            expect(calls.length).toEqual(1);
            const body = JSON.parse(calls[0][1]!.body as string);
            const deviceSig = body[aliceClient.getSafeUserId()][testData.TEST_DEVICE_ID];
            expect(deviceSig).toHaveProperty("signatures");
        });
    });
});
