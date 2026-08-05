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

import { OAuth2, TokenRefresher, TokenRefreshLogoutError } from "../../../src";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";

describe("OidcTokenRefresher", () => {
    // OidcTokenRefresher props
    // see class declaration for info
    const authConfig = {
        issuer: "https://issuer.org/",
    };
    const clientId = "test-client-id";
    const redirectUri = "https://test.org";
    const deviceId = "abc123";
    // used to mock a valid token response
    const scope = `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`;

    // auth config used in mocked calls to OP .well-known
    const config = makeDelegatedAuthMetadata(authConfig.issuer);

    const auth = new OAuth2(config, { clientId, redirectUri, deviceId });

    const makeTokenResponse = (accessToken: string, refreshToken?: string) => ({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 300,
        scope: scope,
    });

    beforeEach(() => {
        fetchMock.post(
            config.token_endpoint,
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
                ...makeTokenResponse("new-access-token", "new-refresh-token"),
            },
            { name: "token-endpoint" },
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("doRefreshAccessToken()", () => {
        it("should refresh the tokens", async () => {
            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);

            const result = await refresher.tokenRefreshFunction("refresh-token");

            expect(fetchMock).toHaveFetched(config.token_endpoint, {
                method: "POST",
            });

            expect(result).toEqual(
                expect.objectContaining({
                    accessToken: "new-access-token",
                    refreshToken: "new-refresh-token",
                }),
            );
        });

        it("should persist the new tokens", async () => {
            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);

            await refresher.tokenRefreshFunction("refresh-token");

            expect(fn).toHaveBeenCalledWith(
                expect.objectContaining({
                    accessToken: "new-access-token",
                    refreshToken: "new-refresh-token",
                }),
            );
        });

        it("should only have one inflight refresh request at once", async () => {
            fetchMock.removeRoute("token-endpoint");
            fetchMock
                .postOnce(config.token_endpoint, {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    ...makeTokenResponse("first-new-access-token", "first-new-refresh-token"),
                })
                .postOnce(config.token_endpoint, {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    ...makeTokenResponse("second-new-access-token", "second-new-refresh-token"),
                });

            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);
            // reset call counts
            fetchMock.clearHistory();

            const refreshToken = "refresh-token";
            const first = refresher.tokenRefreshFunction(refreshToken);
            const second = refresher.tokenRefreshFunction(refreshToken);

            const result1 = await second;
            const result2 = await first;

            // only one call to token endpoint
            expect(fetchMock).toHaveFetchedTimes(1, config.token_endpoint);
            expect(result1).toEqual(
                expect.objectContaining({
                    accessToken: "first-new-access-token",
                    refreshToken: "first-new-refresh-token",
                }),
            );
            // same response
            expect(result1).toEqual(result2);

            // call again after first request resolves
            const third = await refresher.tokenRefreshFunction("first-new-refresh-token");

            // called token endpoint, got new tokens
            expect(third).toEqual(
                expect.objectContaining({
                    accessToken: "second-new-access-token",
                    refreshToken: "second-new-refresh-token",
                }),
            );
        });

        it("should log and rethrow when token refresh fails", async () => {
            fetchMock.modifyRoute("token-endpoint", {
                response: {
                    status: 503,
                    headers: {
                        "Content-Type": "application/json",
                    },
                },
            });

            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);

            await expect(refresher.tokenRefreshFunction("refresh-token")).rejects.toThrow();
        });

        it("should make fresh request after a failed request", async () => {
            // make sure inflight request is cleared after a failure
            fetchMock.removeRoute("token-endpoint");
            fetchMock
                .postOnce(config.token_endpoint, {
                    status: 503,
                    headers: {
                        "Content-Type": "application/json",
                    },
                })
                .postOnce(config.token_endpoint, {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    ...makeTokenResponse("second-new-access-token", "second-new-refresh-token"),
                });

            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);
            // reset call counts
            fetchMock.clearHistory();

            // first call fails
            await expect(refresher.tokenRefreshFunction("refresh-token")).rejects.toThrow();

            // call again after first request resolves
            const result = await refresher.tokenRefreshFunction("first-new-refresh-token");

            // called token endpoint, got new tokens
            expect(result).toEqual(
                expect.objectContaining({
                    accessToken: "second-new-access-token",
                    refreshToken: "second-new-refresh-token",
                }),
            );
        });

        it("should throw TokenRefreshLogoutError when expired", async () => {
            fetchMock.modifyRoute("token-endpoint", {
                response: {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: {
                        error: "invalid_grant",
                        error_description: "The provided access grant is invalid, expired, or revoked.",
                    },
                },
            });

            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);

            await expect(refresher.tokenRefreshFunction("refresh-token")).rejects.toThrow(TokenRefreshLogoutError);
        });

        it("should not throw TokenRefreshLogoutError when hitting temporal http error", async () => {
            fetchMock.modifyRoute("token-endpoint", {
                response: {
                    status: 500,
                },
            });

            const fn = vi.fn();
            const refresher = new TokenRefresher(auth, fn);

            await expect(refresher.tokenRefreshFunction("refresh-token")).rejects.not.toThrow(TokenRefreshLogoutError);
        });
    });
});
