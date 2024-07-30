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
import { jwtDecode } from "jwt-decode";
import { Crypto } from "@peculiar/webcrypto";
import { getRandomValues } from "node:crypto";
import { TextEncoder } from "node:util";

import { Method } from "../../../src";
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

describe("oidc authorization", () => {
    const delegatedAuthConfig = makeDelegatedAuthConfig();
    const authorizationEndpoint = delegatedAuthConfig.authorizationEndpoint;
    const tokenEndpoint = delegatedAuthConfig.tokenEndpoint;
    const clientId = "xyz789";
    const baseUrl = "https://test.com";

    // 14.03.2022 16:15
    const now = 1647270879403;

    beforeAll(() => {
        jest.spyOn(logger, "warn");
        jest.setSystemTime(now);

        fetchMock.get(
            delegatedAuthConfig.metadata.issuer + ".well-known/openid-configuration",
            mockOpenIdConfiguration(),
        );
        global.TextEncoder = TextEncoder;
    });

    beforeEach(() => {
        const webCrypto = new Crypto();
        Object.defineProperty(window, "crypto", {
            value: {
                getRandomValues,
                randomUUID: jest.fn().mockReturnValue("not-random-uuid"),
                subtle: webCrypto.subtle,
            },
        });
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
            const authorizationParams = generateAuthorizationParams({ redirectUri: baseUrl });
            authorizationParams.codeVerifier = "test-code-verifier";
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
            expect(authUrl.searchParams.get("code_challenge")).toEqual("0FLIKahrX7kqxncwhV5WD82lu_wi5GA8FsRSLubaOpU");
        });

        it("should log a warning if crypto is not available", async () => {
            // test the no crypto case here
            // @ts-ignore mocking
            globalThis.crypto.subtle = undefined;

            const authorizationParams = generateAuthorizationParams({ redirectUri: baseUrl });
            const authUrl = new URL(
                await generateAuthorizationUrl(authorizationEndpoint, clientId, authorizationParams),
            );

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

        it("should generate url with create prompt", async () => {
            const nonce = "abc123";

            const metadata = delegatedAuthConfig.metadata;

            const authUrl = new URL(
                await generateOidcAuthorizationUrl({
                    metadata,
                    homeserverUrl: baseUrl,
                    clientId,
                    redirectUri: baseUrl,
                    nonce,
                    prompt: "create",
                }),
            );

            expect(authUrl.searchParams.get("prompt")).toEqual("create");
        });
    });

    describe("completeAuthorizationCodeGrant", () => {
        const homeserverUrl = "https://server.org/";
        const identityServerUrl = "https://id.org/";
        const nonce = "test-nonce";
        const redirectUri = baseUrl;
        const code = "auth_code_xyz";
        const validBearerTokenResponse = {
            token_type: "Bearer",
            access_token: "test_access_token",
            refresh_token: "test_refresh_token",
            id_token:
                "eyJhbGciOiJSUzI1NiIsImtpZCI6Imh4ZEhXb0Y5bW4ifQ.eyJleHAiOjE3MDgzNTY3NjcsInN1YiI6IjAxSFBQMkZTQllERTlQOUVNTThERDdXWkhSIiwiYXVkIjoiMDFIUTBXSDUyV0paV1JSU1k5V0VFUTVUMlEiLCJub25jZSI6ImhScEI2cGtFMDYiLCJhdXRoX3RpbWUiOjE3MDc5OTAzMTIsImlhdCI6MTcwODM1MzE2NywiYXRfaGFzaCI6Il9HSEU4cDhocHFnMW1ac041YUlycVEiLCJpc3MiOiJodHRwczovL2F1dGgtb2lkYy5sYWIuZWxlbWVudC5kZXYvIiwiY19oYXNoIjoib2hJRmNuaUZWd3pGSzVJdXlsX1RlQSJ9.SGUG78dCC3sTWgQBDTicKwamKiPpb6REiz79CM2ml_kVJCoS7gT0TlztC4h25FKi3c9aB3XCVn9J8UzvJgvG8Rt_oS--FIuhK6oRm7NdcN0bCkbG7iZEWGxx-kQnifcCFHyZ6T1CxR8X00Uvc6_lRfBZVlTyuuQaJ_PHiiKMlV93FbxvQUIq6FTkQP2Z56p4JIXIzjOONzA91skTqQGycl5f9Vhp6cqXFzl6ARK30M7A-8UI5qCxClUJ7kD9KgN5YZ7uivLp1x01WBnik2DXH0eSwXcTX2WLkYtMXgMxylJhIiO586apIC5nr7sfip-Y_4PgBlSjRRgrmOGC-VUFCA",
            expires_in: 300,
        };

        const metadata = mockOpenIdConfiguration();

        const validDecodedIdToken = {
            // nonce matches
            nonce,
            // not expired
            exp: Date.now() / 1000 + 100000,
            // audience is this client
            aud: clientId,
            // issuer matches
            iss: metadata.issuer,
            sub: "123",
        };

        const mockSessionStorage = (state: Record<string, unknown>): void => {
            jest.spyOn(sessionStorage.__proto__, "getItem").mockImplementation((key: unknown) => {
                return state[key as string] ?? null;
            });
            jest.spyOn(sessionStorage.__proto__, "setItem").mockImplementation(
                // @ts-ignore mock type
                (key: string, value: unknown) => (state[key] = value),
            );
            jest.spyOn(sessionStorage.__proto__, "removeItem").mockImplementation((key: unknown) => {
                const { [key as string]: value, ...newState } = state;
                state = newState;
                return value;
            });
        };

        const getValueFromStorage = <T = string>(state: string, key: string): T => {
            const storedState = window.sessionStorage.getItem(`mx_oidc_${state}`)!;
            return JSON.parse(storedState)[key] as unknown as T;
        };

        /**
         * These tests kind of integration test oidc auth, by using `generateOidcAuthorizationUrl` and mocked storage
         * to mock the use case of initiating oidc auth, putting state in storage, redirecting to OP,
         * then returning and using state to verfiy.
         * Returns random state string used to access storage
         * @param params
         */
        const setupState = async (params = {}): Promise<string> => {
            const url = await generateOidcAuthorizationUrl({
                metadata,
                redirectUri,
                clientId,
                homeserverUrl,
                identityServerUrl,
                nonce,
                ...params,
            });

            const state = new URL(url).searchParams.get("state")!;

            // add the scope with correct deviceId to the mocked bearer token response
            const scope = getValueFromStorage(state, "scope");
            fetchMock.post(metadata.token_endpoint, {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
                ...validBearerTokenResponse,
                scope,
            });

            return state;
        };

        beforeEach(() => {
            fetchMock.mockClear();
            fetchMock.resetBehavior();

            fetchMock.get(`${metadata.issuer}.well-known/openid-configuration`, metadata);
            fetchMock.get(`${metadata.issuer}jwks`, {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
                keys: [],
            });

            mockSessionStorage({});

            mocked(jwtDecode).mockReturnValue(validDecodedIdToken);
        });

        it("should make correct request to the token endpoint", async () => {
            const state = await setupState();
            const codeVerifier = getValueFromStorage(state, "code_verifier");
            await completeAuthorizationCodeGrant(code, state);

            expect(fetchMock).toHaveBeenCalledWith(
                metadata.token_endpoint,
                expect.objectContaining({
                    method: Method.Post,
                    credentials: "same-origin",
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                }),
            );

            // check body is correctly formed
            const queryParams = fetchMock.mock.calls.find(([endpoint]) => endpoint === metadata.token_endpoint)![1]!
                .body as URLSearchParams;
            expect(queryParams.get("grant_type")).toEqual("authorization_code");
            expect(queryParams.get("client_id")).toEqual(clientId);
            expect(queryParams.get("code_verifier")).toEqual(codeVerifier);
            expect(queryParams.get("redirect_uri")).toEqual(redirectUri);
            expect(queryParams.get("code")).toEqual(code);
        });

        it("should return with valid bearer token", async () => {
            const state = await setupState();
            const scope = getValueFromStorage(state, "scope");
            const result = await completeAuthorizationCodeGrant(code, state);

            expect(result).toEqual({
                homeserverUrl,
                identityServerUrl,
                oidcClientSettings: {
                    clientId,
                    issuer: metadata.issuer,
                },
                tokenResponse: {
                    access_token: validBearerTokenResponse.access_token,
                    id_token: validBearerTokenResponse.id_token,
                    refresh_token: validBearerTokenResponse.refresh_token,
                    token_type: validBearerTokenResponse.token_type,
                    // this value is slightly unstable because it uses the clock
                    expires_at: result.tokenResponse.expires_at,
                    scope,
                },
                idTokenClaims: result.idTokenClaims,
            });
        });

        it("should return with valid bearer token where token_type is lowercase", async () => {
            const state = await setupState();
            const scope = getValueFromStorage(state, "scope");
            const tokenResponse = {
                ...validBearerTokenResponse,
                scope,
                token_type: "bearer",
            };
            fetchMock.post(
                tokenEndpoint,
                {
                    headers: {
                        "Content-Type": "application/json",
                    },
                    ...tokenResponse,
                },
                { overwriteRoutes: true },
            );

            const result = await completeAuthorizationCodeGrant(code, state);

            expect(result).toEqual({
                homeserverUrl,
                identityServerUrl,
                oidcClientSettings: {
                    clientId,
                    issuer: metadata.issuer,
                },
                // results in token that uses 'Bearer' token type
                tokenResponse: {
                    access_token: validBearerTokenResponse.access_token,
                    id_token: validBearerTokenResponse.id_token,
                    refresh_token: validBearerTokenResponse.refresh_token,
                    token_type: "Bearer",
                    // this value is slightly unstable because it uses the clock
                    expires_at: result.tokenResponse.expires_at,
                    scope,
                },
                idTokenClaims: result.idTokenClaims,
            });

            expect(result.tokenResponse.token_type).toEqual("Bearer");
        });

        it("should throw when state is not found in storage", async () => {
            // don't setup sessionStorage with expected state
            const state = "abc123";
            fetchMock.post(
                metadata.token_endpoint,
                {
                    status: 500,
                },
                { overwriteRoutes: true },
            );
            await expect(() => completeAuthorizationCodeGrant(code, state)).rejects.toThrow(
                new Error(OidcError.MissingOrInvalidStoredState),
            );
        });

        it("should throw with code exchange failed error when request fails", async () => {
            const state = await setupState();
            fetchMock.post(
                metadata.token_endpoint,
                {
                    status: 500,
                },
                { overwriteRoutes: true },
            );
            await expect(() => completeAuthorizationCodeGrant(code, state)).rejects.toThrow(
                new Error(OidcError.CodeExchangeFailed),
            );
        });

        it("should throw invalid token error when token is invalid", async () => {
            const state = await setupState();
            const invalidBearerTokenResponse = {
                ...validBearerTokenResponse,
                access_token: null,
            };
            fetchMock.post(
                metadata.token_endpoint,
                {
                    headers: {
                        "Content-Type": "application/json",
                    },
                    ...invalidBearerTokenResponse,
                },
                { overwriteRoutes: true },
            );
            await expect(() => completeAuthorizationCodeGrant(code, state)).rejects.toThrow(
                new Error(OidcError.InvalidBearerTokenResponse),
            );
        });

        it("should throw invalid id token error when id_token is invalid", async () => {
            const state = await setupState();
            mocked(jwtDecode).mockReturnValue({
                ...validDecodedIdToken,
                // invalid audience
                aud: "something-else",
            });
            await expect(() => completeAuthorizationCodeGrant(code, state)).rejects.toThrow(
                new Error(OidcError.InvalidIdToken),
            );
        });
    });
});
