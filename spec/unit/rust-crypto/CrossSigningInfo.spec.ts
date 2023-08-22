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

import { CrossSigningInfoImpl } from "../../../src/rust-crypto/CrossSigningInfoImpl";
import { SIGNED_CROSS_SIGNING_KEYS_DATA, TEST_USER_ID } from "../../test-utils/test-data";
import { CrossSigningKey } from "../../../src/crypto-api";
import { HttpApiEvent, HttpApiEventHandlerMap, IHttpOpts, MatrixHttpApi, TypedEventEmitter } from "../../../src";

describe("CrossSigningInfo", () => {
    let httpApi: MatrixHttpApi<IHttpOpts & { onlyData: true }>;

    beforeEach(async () => {
        const dummyEventEmitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
        httpApi = new MatrixHttpApi(dummyEventEmitter, {
            baseUrl: "https://example.com",
            prefix: "/_matrix",
            onlyData: true,
        });
    });

    afterEach(() => fetchMock.mockReset());

    describe("CrossSigningInfo.create", () => {
        it("should return null when the master keys are missing", async () => {
            fetchMock.post("https://example.com/_matrix/client/v3/keys/query", {});

            const crossSigningInfo = await CrossSigningInfoImpl.create(TEST_USER_ID, httpApi);
            expect(crossSigningInfo).toBeNull();
        });

        it("should return null when the self signing keys are missing", async () => {
            fetchMock.post("https://example.com/_matrix/client/v3/keys/query", {
                master_keys: {
                    [TEST_USER_ID]: {
                        keys: {
                            "ed25519:pubKey": "pubKey",
                        },
                    },
                },
            });

            const crossSigningInfo = await CrossSigningInfoImpl.create(TEST_USER_ID, httpApi);
            expect(crossSigningInfo).toBeNull();
        });

        it("should return null when the user signing keys are missing", async () => {
            fetchMock.post("https://example.com/_matrix/client/v3/keys/query", {
                master_keys: {
                    [TEST_USER_ID]: {
                        keys: {
                            "ed25519:pubKey": "pubKey",
                        },
                    },
                },
                self_signing_keys: {
                    [TEST_USER_ID]: {
                        keys: {
                            "ed25519:pubKey": "pubKey",
                        },
                    },
                },
            });

            const crossSigningInfo = await CrossSigningInfoImpl.create(TEST_USER_ID, httpApi);
            expect(crossSigningInfo).toBeNull();
        });
    });

    describe("getId", () => {
        beforeEach(() => {
            fetchMock.post("https://example.com/_matrix/client/v3/keys/query", SIGNED_CROSS_SIGNING_KEYS_DATA);
        });

        const pubMasterKey = Object.values(SIGNED_CROSS_SIGNING_KEYS_DATA.master_keys![TEST_USER_ID].keys)[0];
        const pubSelfSigningKey = Object.values(
            SIGNED_CROSS_SIGNING_KEYS_DATA.self_signing_keys![TEST_USER_ID].keys,
        )[0];
        const pubUserSigningKey = Object.values(
            SIGNED_CROSS_SIGNING_KEYS_DATA.user_signing_keys![TEST_USER_ID].keys,
        )[0];

        let crossSigningInfo: CrossSigningInfoImpl;

        beforeEach(async () => {
            crossSigningInfo = (await CrossSigningInfoImpl.create(TEST_USER_ID, httpApi))!;
        });

        it.each([
            { type: CrossSigningKey.Master, expected: pubMasterKey },
            { type: CrossSigningKey.SelfSigning, expected: pubSelfSigningKey },
            { type: CrossSigningKey.UserSigning, expected: pubUserSigningKey },
            { type: undefined, expected: pubMasterKey },
            { type: null, expected: null },
        ])("should return $expected for $type", async ({ type, expected }) => {
            // @ts-ignore force wrong type value to test edge case
            expect(crossSigningInfo.getPublicKey(type)).toBe(expected);
        });
    });
});
