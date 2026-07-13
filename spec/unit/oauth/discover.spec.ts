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

import { logger } from "../../../src/logger";
import { isValidAuthMetadata } from "../../../src/oauth/discover";
import { makeDelegatedAuthMetadata } from "../../../src/testing.ts";

describe("isValidAuthMetadata", () => {
    const validWk = makeDelegatedAuthMetadata();

    beforeEach(() => {
        // stub to avoid console litter
        vi.spyOn(logger, "error")
            .mockClear()
            .mockImplementation(() => {});
    });

    it("should return false when wellKnown is not an object", () => {
        expect(isValidAuthMetadata([])).toBeFalsy();
    });

    it("should return true for config with all fields", () => {
        expect(isValidAuthMetadata(validWk)).toBeTruthy();
    });

    type TestCase = [string, any];
    it.each<TestCase>([
        ["authorization_endpoint", undefined],
        ["authorization_endpoint", { not: "a string" }],
        ["token_endpoint", undefined],
        ["token_endpoint", { not: "a string" }],
        ["registration_endpoint", { not: "a string" }],
        ["response_types_supported", undefined],
        ["response_types_supported", "not an array"],
        ["response_types_supported", ["doesnt include code"]],
        ["grant_types_supported", undefined],
        ["grant_types_supported", "not an array"],
        ["grant_types_supported", ["doesn't include authorization_code", "refresh_token"]],
        ["grant_types_supported", ["authorization_code", "doesn't include refresh_token"]],
        ["code_challenge_methods_supported", undefined],
        ["code_challenge_methods_supported", "not an array"],
        ["code_challenge_methods_supported", ["doesnt include S256"]],
        ["account_management_uri", { not: "a string" }],
        ["account_management_actions_supported", { not: "an array" }],
        ["response_modes_supported", ["code", "missing fragment"]],
    ])("should return false when %s is %s", (key, value) => {
        const wk = {
            ...validWk,
            [key]: value,
        };
        expect(isValidAuthMetadata(wk)).toBeFalsy();
    });
});
