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

import * as crypto from "../../../src/crypto/crypto";
import { logger } from "../../../src/logger";
import { generateAuthorizationParams, generateAuthorizationUrl } from "../../../src/oidc/authorize";

// save for resetting mocks
const realSubtleCrypto = crypto.subtleCrypto;

describe("oidc authorization", () => {
    const authorizationEndpoint = "https://auth.com/authorization";
    const clientId = "xyz789";
    const baseUrl = "https://test.com";

    beforeAll(() => {
        jest.spyOn(logger, "warn");
    });

    afterEach(() => {
        // @ts-ignore reset any ugly mocking we did
        crypto.subtleCrypto = realSubtleCrypto;
    });

    it("should generate authorization params", () => {
        const result = generateAuthorizationParams({ redirectUri: baseUrl });

        expect(result.redirectUri).toEqual(baseUrl);

        // random strings
        expect(result.state.length).toEqual(8);
        expect(result.nonce.length).toEqual(8);
        expect(result.codeVerifier.length).toEqual(64);

        const expectedScope =
            "openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:";
        expect(result.scope.startsWith(expectedScope)).toBeTruthy();
        // deviceId of 10 characters is appended to the device scope
        expect(result.scope.length).toEqual(expectedScope.length + 10);
    });

    describe("generateAuthorizationUrl()", () => {
        it("should generate url with correct parameters", async () => {
            // test the no crypto case here
            // @ts-ignore mocking
            crypto.subtleCrypto = undefined;

            const authorizationParams = generateAuthorizationParams({ redirectUri: baseUrl });
            const authUrl = new URL(
                await generateAuthorizationUrl(authorizationEndpoint, clientId, authorizationParams),
            );

            expect(authUrl.searchParams.get("response_mode")).toEqual("fragment");
            expect(authUrl.searchParams.get("response_type")).toEqual("code");
            expect(authUrl.searchParams.get("client_id")).toEqual(clientId);
            expect(authUrl.searchParams.get("code_challenge_method")).toEqual("S256");
            expect(authUrl.searchParams.get("scope")).toEqual(authorizationParams.scope);
            expect(authUrl.searchParams.get("state")).toEqual(authorizationParams.state);
            expect(authUrl.searchParams.get("nonce")).toEqual(authorizationParams.nonce);

            // crypto not available, plain text code_challenge is used
            expect(authUrl.searchParams.get("code_challenge")).toEqual(authorizationParams.codeVerifier);
            expect(logger.warn).toHaveBeenCalledWith(
                "A secure context is required to generate code challenge. Using plain text code challenge",
            );
        });

        it("uses a s256 code challenge when crypto is available", async () => {
            jest.spyOn(crypto.subtleCrypto, "digest");
            const authorizationParams = generateAuthorizationParams({ redirectUri: baseUrl });
            const authUrl = new URL(
                await generateAuthorizationUrl(authorizationEndpoint, clientId, authorizationParams),
            );

            const codeChallenge = authUrl.searchParams.get("code_challenge");
            expect(crypto.subtleCrypto.digest).toHaveBeenCalledWith("SHA-256", expect.any(Object));

            // didn't use plain text code challenge
            expect(authorizationParams.codeVerifier).not.toEqual(codeChallenge);
            expect(codeChallenge).toBeTruthy();
        });
    });
});
