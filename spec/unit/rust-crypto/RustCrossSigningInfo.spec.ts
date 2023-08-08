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

import { Mocked } from "jest-mock";
import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { RustCrossSigningInfo } from "../../../src/rust-crypto/RustCrossSigningInfo";
import { SIGNED_CROSS_SIGNING_KEYS_DATA, TEST_USER_ID } from "../../test-utils/test-data";
import { CrossSigningKey } from "../../../src/crypto-api";
import { CrossSigningInfo } from "../../../src/crypto-api/CrossSigningInfo";

describe("RustCrossSigningInfo", () => {
    describe("getCrossSigningInfo", () => {
        it("should return null when the userId is unknown", async () => {
            const olmMachine = {
                getIdentity: jest.fn(),
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

            const crossSigningInfo = await RustCrossSigningInfo.getCrossSigningInfo(TEST_USER_ID, olmMachine);
            expect(crossSigningInfo).toBeNull();
        });

        it("should return the cross signing info", async () => {
            const olmMachine = {
                getIdentity: () => {},
            } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

            const crossSigningInfo = await RustCrossSigningInfo.getCrossSigningInfo(TEST_USER_ID, olmMachine);
            expect(crossSigningInfo).toBeDefined();
        });
    });

    describe("getId", () => {
        const pubMasterKey = Object.values(SIGNED_CROSS_SIGNING_KEYS_DATA.master_keys![TEST_USER_ID].keys)[0];
        const pubSelfSigningKey = Object.values(
            SIGNED_CROSS_SIGNING_KEYS_DATA.self_signing_keys![TEST_USER_ID].keys,
        )[0];

        const identity = {
            masterKey: JSON.stringify(SIGNED_CROSS_SIGNING_KEYS_DATA.master_keys![TEST_USER_ID]),
            selfSigningKey: JSON.stringify(SIGNED_CROSS_SIGNING_KEYS_DATA.self_signing_keys![TEST_USER_ID]),
        };

        const olmMachine = {
            getIdentity: jest.fn().mockReturnValue(identity),
        } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;

        let crossSigningInfo: CrossSigningInfo;

        beforeEach(async () => {
            crossSigningInfo = (await RustCrossSigningInfo.getCrossSigningInfo(TEST_USER_ID, olmMachine))!;
        });

        it.each([
            { type: CrossSigningKey.Master, expected: pubMasterKey },
            { type: CrossSigningKey.SelfSigning, expected: pubSelfSigningKey },
            { type: undefined, expected: pubMasterKey },
            { type: null, expected: null },
        ])("should return $expected for $type", async ({ type, expected }) => {
            // @ts-ignore force wrong type value to test edge case
            expect(crossSigningInfo.getId(type)).toBe(expected);
        });
    });
});
