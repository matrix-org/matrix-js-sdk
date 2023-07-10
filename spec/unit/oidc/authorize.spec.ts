/**
 * @jest-environment jsdom
 */

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
import { mocked } from "jest-mock";
import jwtDecode from "jwt-decode";

import { Method } from "../../../src";
import * as crypto from "../../../src/crypto/crypto";
import { logger } from "../../../src/logger";
import {
    completeAuthorizationCodeGrant,
    generateAuthorizationParams,
    generateAuthorizationUrl,
    generateOidcAuthorizationUrl,
} from "../../../src/oidc/authorize";
import { OidcError } from "../../../src/oidc/error";
import { makeDelegatedAuthConfig, mockOpenIdConfiguration } from "../../test-utils/oidc";

jest.mock("jwt-decode");

// save for resetting mocks
const realSubtleCrypto = crypto.subtleCrypto;

describe("oidc authorization", () => {
    const delegatedAuthConfig = makeDelegatedAuthConfig();
    const authorizationEndpoint = delegatedAuthConfig.metadata.authorization_endpoint;
    const tokenEndpoint = delegatedAuthConfig.metadata.token_endpoint;
    const clientId = "xyz789";
    const baseUrl = "https://test.com";

    beforeAll(() => {
        jest.spyOn(logger, "warn");

        fetchMock.get(delegatedAuthConfig.issuer + ".well-known/openid-configuration", mockOpenIdConfiguration());
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

            expect(authUrl.searchParams.get("response_mode")).toEqual("query");
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
    });

    describe("generateOidcAuthorizationUrl()", () => {
        it("should generate url with correct parameters", async () => {
            const nonce = "abc123";

            const metadata = delegatedAuthConfig.metadata;

            const authUrl = new URL(
                await generateOidcAuthorizationUrl({
                    metadata,
                    homeserverUrl: baseUrl,
                    clientId,
                    redirectUri: baseUrl,
                    nonce,
                }),
            );

            expect(authUrl.searchParams.get("response_mode")).toEqual("query");
            expect(authUrl.searchParams.get("response_type")).toEqual("code");
            expect(authUrl.searchParams.get("client_id")).toEqual(clientId);
            expect(authUrl.searchParams.get("code_challenge_method")).toEqual("S256");
            // scope minus the 10char random device id at the end
            expect(authUrl.searchParams.get("scope")!.slice(0, -10)).toEqual(
                "openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:",
            );
            expect(authUrl.searchParams.get("state")).toBeTruthy();
            expect(authUrl.searchParams.get("nonce")).toEqual(nonce);

            expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
        });
    });

    describe("completeAuthorizationCodeGrant", () => {
        const codeVerifier = "abc123";
        const nonce = "test-nonce";
        const redirectUri = baseUrl;
        const code = "auth_code_xyz";
        const validBearerTokenResponse = {
            token_type: "Bearer",
            access_token: "test_access_token",
            refresh_token: "test_refresh_token",
            id_token: "valid.id.token",
            expires_in: 12345,
        };

        const validDecodedIdToken = {
            // nonce matches
            nonce,
            // not expired
            exp: Date.now() / 1000 + 100000,
            // audience is this client
            aud: clientId,
            // issuer matches
            iss: delegatedAuthConfig.issuer,
        };

        beforeEach(() => {
            fetchMock.mockClear();
            fetchMock.resetBehavior();

            fetchMock.post(tokenEndpoint, {
                status: 200,
                body: JSON.stringify(validBearerTokenResponse),
            });

            mocked(jwtDecode).mockReturnValue(validDecodedIdToken);
        });

        it("should make correct request to the token endpoint", async () => {
            await completeAuthorizationCodeGrant(code, {
                clientId,
                codeVerifier,
                redirectUri,
                delegatedAuthConfig,
                nonce,
            });

            expect(fetchMock).toHaveBeenCalledWith(tokenEndpoint, {
                method: Method.Post,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `grant_type=authorization_code&client_id=${clientId}&code_verifier=${codeVerifier}&redirect_uri=https%3A%2F%2Ftest.com&code=${code}`,
            });
        });

        it("should return with valid bearer token", async () => {
            const result = await completeAuthorizationCodeGrant(code, {
                clientId,
                codeVerifier,
                redirectUri,
                delegatedAuthConfig,
                nonce,
            });

            expect(result).toEqual(validBearerTokenResponse);
        });

        it("should return with valid bearer token where token_type is lowercase", async () => {
            const tokenResponse = {
                ...validBearerTokenResponse,
                token_type: "bearer",
            };
            fetchMock.post(
                tokenEndpoint,
                {
                    status: 200,
                    body: JSON.stringify(tokenResponse),
                },
                { overwriteRoutes: true },
            );

            const result = await completeAuthorizationCodeGrant(code, {
                clientId,
                codeVerifier,
                redirectUri,
                delegatedAuthConfig,
                nonce,
            });

            // results in token that uses 'Bearer' token type
            expect(result).toEqual(validBearerTokenResponse);
            expect(result.token_type).toEqual("Bearer");
        });

        it("should throw with code exchange failed error when request fails", async () => {
            fetchMock.post(
                tokenEndpoint,
                {
                    status: 500,
                },
                { overwriteRoutes: true },
            );
            await expect(() =>
                completeAuthorizationCodeGrant(code, {
                    clientId,
                    codeVerifier,
                    redirectUri,
                    delegatedAuthConfig,
                    nonce,
                }),
            ).rejects.toThrow(new Error(OidcError.CodeExchangeFailed));
        });

        it("should throw invalid token error when token is invalid", async () => {
            const invalidBearerTokenResponse = {
                ...validBearerTokenResponse,
                access_token: null,
            };
            fetchMock.post(
                tokenEndpoint,
                { status: 200, body: JSON.stringify(invalidBearerTokenResponse) },
                { overwriteRoutes: true },
            );
            await expect(() =>
                completeAuthorizationCodeGrant(code, {
                    clientId,
                    codeVerifier,
                    redirectUri,
                    delegatedAuthConfig,
                    nonce,
                }),
            ).rejects.toThrow(new Error(OidcError.InvalidBearerTokenResponse));
        });

        it("should throw invalid id token error when id_token is invalid", async () => {
            mocked(jwtDecode).mockReturnValue({
                ...validDecodedIdToken,
                // invalid audience
                aud: "something-else",
            });
            await expect(() =>
                completeAuthorizationCodeGrant(code, {
                    clientId,
                    codeVerifier,
                    redirectUri,
                    delegatedAuthConfig,
                    nonce,
                }),
            ).rejects.toThrow(new Error(OidcError.InvalidIdToken));
        });
    });
});
