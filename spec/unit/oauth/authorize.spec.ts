/**
 * @vitest-environment happy-dom
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

import fetchMock from "@fetch-mock/vitest";

import { logger } from "../../../src/logger";
import { OAuth2, generateScope, startDeviceAuthorization, waitForDeviceAuthorization } from "../../../src/oauth";
import { OAuth2Error } from "../../../src/oauth/error";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";
import { HTTPError } from "../../../src";

describe("authorization", () => {
    const delegatedAuthConfig = makeDelegatedAuthMetadata();
    const clientId = "xyz789";
    const deviceId = "deadbeef";
    const baseUrl = "https://test.com";

    const auth = new OAuth2(delegatedAuthConfig, {
        clientId,
        redirectUri: baseUrl,
        deviceId,
        codeVerifier: "test-code-verifier",
    });

    // 14.03.2022 16:15
    const now = 1647270879403;

    beforeEach(() => {
        vi.spyOn(logger, "warn");
        vi.useFakeTimers();
        vi.setSystemTime(now);
    });

    describe("generateAuthorizationCodeGrantUrl()", () => {
        const state = "abc123";

        it("should generate url with correct parameters", async () => {
            const authUrl = new URL(await auth.generateAuthorizationCodeGrantUrl(state));

            expect(authUrl.searchParams.get("response_mode")).toEqual("fragment");
            expect(authUrl.searchParams.get("response_type")).toEqual("code");
            expect(authUrl.searchParams.get("client_id")).toEqual(clientId);
            expect(authUrl.searchParams.get("code_challenge_method")).toEqual("S256");
            expect(authUrl.searchParams.get("scope")!.slice(0, -deviceId.length)).toEqual(
                "urn:matrix:client:api:* urn:matrix:client:device:",
            );
            expect(authUrl.searchParams.get("state")).toBe(state);

            expect(authUrl.searchParams.get("code_challenge")).toEqual("0FLIKahrX7kqxncwhV5WD82lu_wi5GA8FsRSLubaOpU");
        });

        it("should generate url with create prompt", async () => {
            const authUrl = new URL(await auth.generateAuthorizationCodeGrantUrl(state, "fragment", "create"));

            expect(authUrl.searchParams.get("prompt")).toEqual("create");
        });

        it("should generate url with response_mode=query", async () => {
            const authUrl = new URL(await auth.generateAuthorizationCodeGrantUrl(state, "query"));

            expect(authUrl.searchParams.get("response_mode")).toEqual("query");
        });
    });

    describe("completeAuthorizationCodeGrant", () => {
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

        const metadata = makeDelegatedAuthMetadata();

        /**
         * These tests kind of integration test oauth2 auth, by using `generateOidcAuthorizationUrl` and mocked storage
         * to mock the use case of initiating oauth2 auth, putting state in storage, redirecting to IdP,
         * then returning and using state to verify.
         * Returns random state string used to access storage
         * @param params
         */
        const setupState = async (params = {}): Promise<[code: string, scope: string]> => {
            const scope = generateScope();
            fetchMock.post(
                metadata.token_endpoint,
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: { ...validBearerTokenResponse, scope },
                },
                { name: "token-endpoint" },
            );

            return [code, scope];
        };

        it("should make correct request to the token endpoint", async () => {
            const [code] = await setupState();
            const codeVerifier = auth.context.codeVerifier;
            await auth.completeAuthorizationCodeGrant(code);

            expect(fetchMock.callHistory.lastCall(metadata.token_endpoint)?.options).toStrictEqual(
                expect.objectContaining({
                    method: "post",
                    headers: {
                        "accept": "application/json",
                        "content-type": "application/x-www-form-urlencoded",
                    },
                }),
            );

            // check body is correctly formed
            const queryParams = fetchMock.callHistory.lastCall(metadata.token_endpoint)!.options
                .body as URLSearchParams;
            expect(queryParams.get("grant_type")).toEqual("authorization_code");
            expect(queryParams.get("client_id")).toEqual(clientId);
            expect(queryParams.get("code_verifier")).toEqual(codeVerifier);
            expect(queryParams.get("redirect_uri")).toEqual(redirectUri);
            expect(queryParams.get("code")).toEqual(code);
        });

        it("should make correct request to the token endpoint with response_mode=fragment", async () => {
            const [code] = await setupState({ responseMode: "fragment" });
            const codeVerifier = auth.context.codeVerifier;
            await auth.completeAuthorizationCodeGrant(code);

            expect(fetchMock.callHistory.lastCall(metadata.token_endpoint)?.options).toStrictEqual(
                expect.objectContaining({
                    method: "post",
                    headers: {
                        "accept": "application/json",
                        "content-type": "application/x-www-form-urlencoded",
                    },
                }),
            );

            // check body is correctly formed
            const queryParams = fetchMock.callHistory.lastCall(metadata.token_endpoint)!.options
                .body as URLSearchParams;
            expect(queryParams.get("grant_type")).toEqual("authorization_code");
            expect(queryParams.get("client_id")).toEqual(clientId);
            expect(queryParams.get("code_verifier")).toEqual(codeVerifier);
            expect(queryParams.get("redirect_uri")).toEqual(redirectUri);
            expect(queryParams.get("code")).toEqual(code);
        });

        it("should return with valid bearer token", async () => {
            const [code, scope] = await setupState();
            const result = await auth.completeAuthorizationCodeGrant(code);

            expect(result).toEqual({
                access_token: validBearerTokenResponse.access_token,
                id_token: validBearerTokenResponse.id_token,
                refresh_token: validBearerTokenResponse.refresh_token,
                token_type: validBearerTokenResponse.token_type,
                // this value is slightly unstable because it uses the clock
                expires_in: result.expires_in,
                scope,
            });
        });

        it("should return with valid bearer token where token_type is lowercase", async () => {
            const [code, scope] = await setupState();
            const tokenResponse = {
                ...validBearerTokenResponse,
                scope,
                token_type: "bearer",
            };
            fetchMock.modifyRoute("token-endpoint", {
                response: tokenResponse,
            });

            const result = await auth.completeAuthorizationCodeGrant(code);

            expect(result).toEqual({
                access_token: validBearerTokenResponse.access_token,
                id_token: validBearerTokenResponse.id_token,
                refresh_token: validBearerTokenResponse.refresh_token,
                token_type: "Bearer",
                // this value is slightly unstable because it uses the clock
                expires_in: result.expires_in,
                scope,
            });

            expect(result.token_type).toEqual("Bearer");
        });

        it("should throw with code exchange failed error when request fails", async () => {
            const [code] = await setupState();
            fetchMock.modifyRoute("token-endpoint", {
                response: { status: 500 },
            });
            await expect(auth.completeAuthorizationCodeGrant(code)).rejects.toThrow(
                new HTTPError(OAuth2Error.CodeExchangeFailed, 500, expect.anything()),
            );
        });

        it("should throw invalid token error when token is invalid", async () => {
            const [code] = await setupState();
            const invalidBearerTokenResponse = {
                ...validBearerTokenResponse,
                access_token: null,
            };
            fetchMock.modifyRoute("token-endpoint", {
                response: invalidBearerTokenResponse,
            });
            await expect(auth.completeAuthorizationCodeGrant(code)).rejects.toThrow(
                new Error(OAuth2Error.InvalidBearerTokenResponse),
            );
        });
    });

    describe("startDeviceAuthorization", () => {
        it("should make the request with the expected parameters", async () => {
            const metadata = makeDelegatedAuthMetadata();

            fetchMock.postOnce(metadata.device_authorization_endpoint!, {
                device_code: "test",
                user_code: "uc",
                verification_uri: "https://url",
                expires_in: 9999,
            });

            const scope = generateScope(deviceId);
            const response = await startDeviceAuthorization({ clientId, metadata, scope });

            expect(response).toStrictEqual({
                device_code: "test",
                user_code: "uc",
                verification_uri: "https://url",
                expires_in: 9999,
            });
            expect(fetchMock).toHavePosted(metadata.device_authorization_endpoint!, {
                matcherFunction: (callLog) => {
                    expect(callLog.options.body).toBe(
                        "client_id=xyz789&scope=urn%3Amatrix%3Aclient%3Aapi%3A*+urn%3Amatrix%3Aclient%3Adevice%3Adeadbeef",
                    );
                    return true;
                },
            });
        });
    });

    describe("waitForDeviceAuthorization", () => {
        const metadata = makeDelegatedAuthMetadata();
        const session = {
            device_code: "device",
            user_code: "user",
            verification_uri: "https://verification.uri",
            expires_in: 10000,
        };

        it("should resolve to token payload on success", async () => {
            fetchMock.postOnce(metadata.token_endpoint, { access_token: "test", token_type: "Bearer" });
            const response = await waitForDeviceAuthorization({ clientId, metadata, session });

            expect(response).toStrictEqual({ access_token: "test", token_type: "Bearer" });
            expect(fetchMock).toHavePosted(metadata.token_endpoint, {
                matcherFunction: (callLog) => {
                    expect(callLog.options.body).toBe(
                        "device_code=device&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=xyz789",
                    );
                    return true;
                },
            });
        });

        it("should handle 'authorization_pending' error", async () => {
            fetchMock.postOnce(metadata.token_endpoint, { status: 400, body: { error: "authorization_pending" } });
            fetchMock.postOnce(metadata.token_endpoint, { status: 400, body: { error: "authorization_pending" } });
            fetchMock.postOnce(metadata.token_endpoint, { access_token: "test", token_type: "Bearer" });
            const promise = waitForDeviceAuthorization({ clientId, metadata, session });

            await vi.advanceTimersByTimeAsync(10000); // two sleeps

            await expect(promise).resolves.toStrictEqual({ access_token: "test", token_type: "Bearer" });
            expect(fetchMock).toHavePostedTimes(3, metadata.token_endpoint, {
                matcherFunction: (callLog) => {
                    expect(callLog.options.body).toBe(
                        "device_code=device&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=xyz789",
                    );
                    return true;
                },
            });
        });

        it("should handle 'slow_down' error", async () => {
            fetchMock.postOnce(metadata.token_endpoint, { status: 400, body: { error: "slow_down" } });
            fetchMock.postOnce(metadata.token_endpoint, { access_token: "test", token_type: "Bearer" });
            const promise = waitForDeviceAuthorization({ clientId, metadata, session });

            await vi.advanceTimersByTimeAsync(9000);
            // We were asked to slow down so should not have retried yet
            expect(fetchMock).toHavePostedTimes(1, metadata.token_endpoint);

            await vi.advanceTimersByTimeAsync(1000);

            await expect(promise).resolves.toStrictEqual({ access_token: "test", token_type: "Bearer" });
            expect(fetchMock).toHavePostedTimes(2, metadata.token_endpoint, {
                matcherFunction: (callLog) => {
                    expect(callLog.options.body).toBe(
                        "device_code=device&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=xyz789",
                    );
                    return true;
                },
            });
        });

        it.each(["access_denied", "expired_token"])("should handle '%s' error", async (error) => {
            fetchMock.postOnce(metadata.token_endpoint, { status: 400, body: { error } });
            const response = await waitForDeviceAuthorization({ clientId, metadata, session });

            expect(response).toStrictEqual({ error });
            expect(fetchMock).toHavePostedTimes(1, metadata.token_endpoint, {
                matcherFunction: (callLog) => {
                    expect(callLog.options.body).toBe(
                        "device_code=device&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=xyz789",
                    );
                    return true;
                },
            });
        });

        it("should handle session expiration", async () => {
            fetchMock.post(metadata.token_endpoint, { status: 400, body: { error: "authorization_pending" } });
            const promise = waitForDeviceAuthorization({ clientId, metadata, session });

            vi.setSystemTime(Date.now() + session.expires_in * 1000);
            await vi.runOnlyPendingTimersAsync();

            await expect(promise).resolves.toStrictEqual({ error: "expired" });
            expect(fetchMock).toHavePostedTimes(1, metadata.token_endpoint, {
                matcherFunction: (callLog) => {
                    expect(callLog.options.body).toBe(
                        "device_code=device&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=xyz789",
                    );
                    return true;
                },
            });
        });
    });
});
