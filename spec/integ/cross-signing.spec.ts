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

import { CRYPTO_BACKENDS, InitCrypto } from "../test-utils/test-utils";
import { createClient, MatrixClient, UIAuthCallback } from "../../src";

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

    describe("bootstrapCrossSigning (before initialsync completes)", () => {
        it("publishes keys if none were yet published", async () => {
            // have account_data requests return an empty object
            fetchMock.get("express:/_matrix/client/r0/user/:userId/account_data/:type", {});

            // we expect a request to upload signatures for our device ...
            fetchMock.post({ url: "path:/_matrix/client/v3/keys/signatures/upload", name: "upload-sigs" }, {});

            // ... and one to upload the cross-signing keys (with UIA)
            fetchMock.post(
                // legacy crypto uses /unstable/; /v3/ is correct
                {
                    url: new RegExp("/_matrix/client/(unstable|v3)/keys/device_signing/upload"),
                    name: "upload-keys",
                },
                {},
            );

            // provide a UIA callback, so that the cross-signing keys are uploaded
            const authDict = { type: "test" };
            const uiaCallback: UIAuthCallback<void> = async (makeRequest) => {
                await makeRequest(authDict);
            };

            // now bootstrap cross signing, and check it resolves successfully
            await aliceClient.bootstrapCrossSigning({
                authUploadDeviceSigningKeys: uiaCallback,
            });

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
});
