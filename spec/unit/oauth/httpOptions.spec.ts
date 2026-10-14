/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { OAuth2 } from "../../../src";
import { OAuthGrantType } from "../../../src/oauth/register";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";

describe("OAuth2 http options", () => {
    const metadata = makeDelegatedAuthMetadata("https://issuer.org/", [OAuthGrantType.DeviceAuthorization]);
    const clientId = "test-client-id";
    const tokenResponse = { access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" };

    const jsonResponse = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    describe("fetchFn", () => {
        it("should be used for token endpoint requests", async () => {
            const fetchFn = vi.fn().mockResolvedValue(jsonResponse(tokenResponse));
            const auth = new OAuth2(metadata, { clientId }, undefined, { fetchFn });

            await expect(auth.performRefreshTokenGrant("refresh")).resolves.toEqual(
                expect.objectContaining({ access_token: "new-access" }),
            );

            expect(fetchFn).toHaveBeenCalledWith(metadata.token_endpoint, expect.objectContaining({ method: "POST" }));
            expect(fetchMock).not.toHaveFetched(metadata.token_endpoint);
        });

        it("should be used for revocation endpoint requests", async () => {
            const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
            const auth = new OAuth2(metadata, { clientId }, undefined, { fetchFn });

            await auth.revokeToken("access-token", "access_token");

            expect(fetchFn).toHaveBeenCalledWith(
                metadata.revocation_endpoint,
                expect.objectContaining({ method: "POST" }),
            );
            expect(fetchMock).not.toHaveFetched(metadata.revocation_endpoint);
        });

        it("should be used for device authorization requests", async () => {
            const fetchFn = vi.fn().mockResolvedValue(
                jsonResponse({
                    device_code: "device-code",
                    user_code: "user-code",
                    verification_uri: "https://issuer.org/verify",
                    expires_in: 300,
                }),
            );
            const auth = new OAuth2(metadata, { clientId }, undefined, { fetchFn });

            await expect(auth.startDeviceAuthorizationGrant()).resolves.toEqual(
                expect.objectContaining({ device_code: "device-code" }),
            );

            expect(fetchFn).toHaveBeenCalledWith(
                metadata.device_authorization_endpoint,
                expect.objectContaining({ method: "POST" }),
            );
            expect(fetchMock).not.toHaveFetched(metadata.device_authorization_endpoint);
        });

        it("should default to the global fetch", async () => {
            fetchMock.postOnce(metadata.token_endpoint, { status: 200, body: tokenResponse });
            const auth = new OAuth2(metadata, { clientId });

            await expect(auth.performRefreshTokenGrant("refresh")).resolves.toEqual(
                expect.objectContaining({ access_token: "new-access" }),
            );

            expect(fetchMock).toHaveFetched(metadata.token_endpoint);
        });
    });
});
