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

import { CRYPTO_BACKENDS, InitCrypto } from "../../test-utils/test-utils";
import { createClient, IAuthDict, MatrixClient } from "../../../src";
import { mockSetupCrossSigningRequests } from "../../test-utils/mockEndpoints";
import { CrossSigningKey } from "../../../src/crypto-api";

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
    let aliceClient: MatrixClient;

    beforeEach(async () => {
        // anything that we don't have a specific matcher for silently returns a 404
        fetchMock.catch(404);
        fetchMock.config.warnOnFallback = false;

        const homeserverUrl = "https://alice-server.com";
        aliceClient = createClient({
            baseUrl: homeserverUrl,
            userId: TEST_USER_ID,
            accessToken: "akjgkrgjs",
            deviceId: TEST_DEVICE_ID,
        });

        await initCrypto(aliceClient);
    });

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
    async function bootstrapCrossSigning(authDict: IAuthDict): Promise<void> {
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

            // Intercept cross singing keys upload
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
});
