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

import { OidcTokenRefresher } from "../../../src";
import { logger } from "../../../src/logger";
import { makeDelegatedAuthConfig } from "../../test-utils/oidc";

describe("OidcTokenRefresher", () => {
    // OidcTokenRefresher props
    // see class declaration for info
    const authConfig = {
        issuer: "https://issuer.org/",
    };
    const clientId = "test-client-id";
    const redirectUri = "https://test.org";
    const deviceId = "abc123";
    const idTokenClaims = {
        exp: Date.now() / 1000 + 100000,
        aud: clientId,
        iss: authConfig.issuer,
        sub: "123",
        iat: 123,
    };
    // used to mock a valid token response, as consumed by OidcClient library
    const scope = `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`;

    // auth config used in mocked calls to OP .well-known
    const config = makeDelegatedAuthConfig(authConfig.issuer);

    const makeTokenResponse = (accessToken: string, refreshToken?: string) => ({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 300,
        scope: scope,
    });

    beforeEach(() => {
        fetchMock.get(`${config.metadata.issuer}.well-known/openid-configuration`, config.metadata);
        fetchMock.get(`${config.metadata.issuer}jwks`, {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
            keys: [],
        });

        fetchMock.post(config.tokenEndpoint, {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
            ...makeTokenResponse("new-access-token", "new-refresh-token"),
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fetchMock.resetBehavior();
    });

    it("throws when oidc client cannot be initialised", async () => {
        jest.spyOn(logger, "error");
        fetchMock.get(
            `${config.metadata.issuer}.well-known/openid-configuration`,
            {
                ok: false,
                status: 404,
            },
            { overwriteRoutes: true },
        );
        const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
        await expect(refresher.oidcClientReady).rejects.toThrow();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to initialise OIDC client.",
            // error from OidcClient
            expect.any(Error),
        );
    });

    it("initialises oidc client", async () => {
        const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
        await refresher.oidcClientReady;

        // @ts-ignore peek at private property to see we initialised the client correctly
        expect(refresher.oidcClient.settings).toEqual(
            expect.objectContaining({
                client_id: clientId,
                redirect_uri: redirectUri,
                authority: authConfig.issuer,
                scope,
            }),
        );
    });

    describe("doRefreshAccessToken()", () => {
        it("should throw when oidcClient has not been initialised", async () => {
            const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
            await expect(refresher.doRefreshAccessToken("token")).rejects.toThrow(
                "Cannot get new token before OIDC client is initialised.",
            );
        });

        it("should refresh the tokens", async () => {
            const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
            await refresher.oidcClientReady;

            const result = await refresher.doRefreshAccessToken("refresh-token");

            expect(fetchMock).toHaveFetched(config.tokenEndpoint, {
                method: "POST",
            });

            expect(result).toEqual({
                accessToken: "new-access-token",
                refreshToken: "new-refresh-token",
            });
        });

        it("should persist the new tokens", async () => {
            const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
            await refresher.oidcClientReady;
            // spy on our stub
            jest.spyOn(refresher, "persistTokens");

            await refresher.doRefreshAccessToken("refresh-token");

            expect(refresher.persistTokens).toHaveBeenCalledWith({
                accessToken: "new-access-token",
                refreshToken: "new-refresh-token",
            });
        });

        it("should only have one inflight refresh request at once", async () => {
            fetchMock
                .postOnce(
                    config.tokenEndpoint,
                    {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                        },
                        ...makeTokenResponse("first-new-access-token", "first-new-refresh-token"),
                    },
                    { overwriteRoutes: true },
                )
                .postOnce(
                    config.tokenEndpoint,
                    {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                        },
                        ...makeTokenResponse("second-new-access-token", "second-new-refresh-token"),
                    },
                    { overwriteRoutes: false },
                );

            const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
            await refresher.oidcClientReady;
            // reset call counts
            fetchMock.resetHistory();

            const refreshToken = "refresh-token";
            const first = refresher.doRefreshAccessToken(refreshToken);
            const second = refresher.doRefreshAccessToken(refreshToken);

            const result1 = await second;
            const result2 = await first;

            // only one call to token endpoint
            expect(fetchMock).toHaveFetchedTimes(1, config.tokenEndpoint);
            expect(result1).toEqual({
                accessToken: "first-new-access-token",
                refreshToken: "first-new-refresh-token",
            });
            // same response
            expect(result1).toEqual(result2);

            // call again after first request resolves
            const third = await refresher.doRefreshAccessToken("first-new-refresh-token");

            // called token endpoint, got new tokens
            expect(third).toEqual({
                accessToken: "second-new-access-token",
                refreshToken: "second-new-refresh-token",
            });
        });

        it("should log and rethrow when token refresh fails", async () => {
            fetchMock.post(
                config.tokenEndpoint,
                {
                    status: 503,
                    headers: {
                        "Content-Type": "application/json",
                    },
                },
                { overwriteRoutes: true },
            );

            const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
            await refresher.oidcClientReady;

            await expect(refresher.doRefreshAccessToken("refresh-token")).rejects.toThrow();
        });

        it("should make fresh request after a failed request", async () => {
            // make sure inflight request is cleared after a failure
            fetchMock
                .postOnce(
                    config.tokenEndpoint,
                    {
                        status: 503,
                        headers: {
                            "Content-Type": "application/json",
                        },
                    },
                    { overwriteRoutes: true },
                )
                .postOnce(
                    config.tokenEndpoint,
                    {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                        },
                        ...makeTokenResponse("second-new-access-token", "second-new-refresh-token"),
                    },
                    { overwriteRoutes: false },
                );

            const refresher = new OidcTokenRefresher(authConfig.issuer, clientId, redirectUri, deviceId, idTokenClaims);
            await refresher.oidcClientReady;
            // reset call counts
            fetchMock.resetHistory();

            // first call fails
            await expect(refresher.doRefreshAccessToken("refresh-token")).rejects.toThrow();

            // call again after first request resolves
            const result = await refresher.doRefreshAccessToken("first-new-refresh-token");

            // called token endpoint, got new tokens
            expect(result).toEqual({
                accessToken: "second-new-access-token",
                refreshToken: "second-new-refresh-token",
            });
        });
    });
});
