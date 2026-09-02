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
import { type Mocked } from "vitest";

import { type Logger } from "../../../src/logger";
import { OAuth2, startDeviceAuthorization } from "../../../src/oauth";
import { fetchWithLogging } from "../../../src/oauth/fetch";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";
import { OAuthGrantType } from "../../../src/oauth/register";

describe("fetchWithLogging()", () => {
    let mockLogger: Mocked<Logger>;

    beforeEach(() => {
        mockLogger = {
            debug: vi.fn(),
        } as unknown as Mocked<Logger>;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("should log the request and the response", async () => {
        vi.useFakeTimers();
        const responseResolvers = Promise.withResolvers<Response>();
        fetchMock.post("https://auth.org/token", responseResolvers.promise);

        const prom = fetchWithLogging(mockLogger, "https://auth.org/token", { method: "POST" });
        vi.advanceTimersByTime(1234);
        responseResolvers.resolve(new Response("{}", { status: 200 }));
        await prom;

        expect(mockLogger.debug).toHaveBeenCalledTimes(2);
        expect(mockLogger.debug.mock.calls[0]).toEqual(["OAuth2: --> POST https://auth.org/token"]);
        expect(mockLogger.debug.mock.calls[1]).toEqual(["OAuth2: <-- POST https://auth.org/token [1234ms 200]"]);
    });

    it("should not log the values of query parameters", async () => {
        fetchMock.get("https://auth.org/whatever?token=super-secret", { status: 200, body: "{}" });

        await fetchWithLogging(mockLogger, "https://auth.org/whatever?token=super-secret");

        for (const call of mockLogger.debug.mock.calls) {
            expect(call[0]).not.toContain("super-secret");
        }
        expect(mockLogger.debug.mock.calls[0]).toEqual(["OAuth2: --> GET https://auth.org/whatever?token=xxx"]);
    });

    it("should log the response status even when it is an error", async () => {
        fetchMock.post("https://auth.org/token", { status: 400, body: "{}" });

        await fetchWithLogging(mockLogger, "https://auth.org/token", { method: "POST" });

        expect(mockLogger.debug.mock.calls[1]).toEqual([
            expect.stringMatching(/^OAuth2: <-- POST https:\/\/auth\.org\/token \[\d+ms 400\]$/),
        ]);
    });

    it("should log and rethrow network errors", async () => {
        const error = new Error("Network error");
        fetchMock.post("https://auth.org/token", { throws: error });

        await expect(fetchWithLogging(mockLogger, "https://auth.org/token", { method: "POST" })).rejects.toThrow(error);

        expect(mockLogger.debug.mock.calls[1]).toEqual([
            expect.stringMatching(/^OAuth2: <-- POST https:\/\/auth\.org\/token \[\d+ms Error: Network error\]$/),
        ]);
    });

    describe("integration", () => {
        const delegatedAuthConfig = makeDelegatedAuthMetadata("https://auth.org/", [
            OAuthGrantType.DeviceAuthorization,
        ]);

        it("should log token endpoint requests made by OAuth2", async () => {
            fetchMock.post(delegatedAuthConfig.token_endpoint, {
                status: 200,
                body: { access_token: "abc123", token_type: "Bearer", expires_in: 300 },
            });

            const auth = new OAuth2(
                delegatedAuthConfig,
                { clientId: "test-client-id", redirectUri: "https://test.com" },
                mockLogger,
            );
            await auth.completeAuthorizationCodeGrant("code123");

            expect(mockLogger.debug.mock.calls).toEqual([
                ["OAuth2: --> POST https://auth.org/token"],
                [expect.stringMatching(/^OAuth2: <-- POST https:\/\/auth\.org\/token \[\d+ms 200\]$/)],
            ]);
        });

        it("should log revocation endpoint requests made by OAuth2", async () => {
            fetchMock.post(delegatedAuthConfig.revocation_endpoint, { status: 200, body: "{}" });

            const auth = new OAuth2(
                delegatedAuthConfig,
                { clientId: "test-client-id", redirectUri: "https://test.com" },
                mockLogger,
            );
            await auth.revokeToken("abc123", "access_token");

            expect(mockLogger.debug.mock.calls[0]).toEqual(["OAuth2: --> POST https://auth.org/revoke"]);
        });

        it("should log registration endpoint requests made by registerClient", async () => {
            fetchMock.post(delegatedAuthConfig.registration_endpoint, {
                status: 200,
                body: { client_id: "xyz789" },
            });

            await OAuth2.registerClient(
                delegatedAuthConfig,
                {
                    client_uri: "https://just.testing",
                    redirect_uris: ["https://just.testing"],
                    client_name: "Element",
                    application_type: "web",
                },
                mockLogger,
            );

            expect(mockLogger.debug.mock.calls[0]).toEqual(["OAuth2: --> POST https://auth.org/registration"]);
        });

        it("should log device authorization endpoint requests", async () => {
            fetchMock.post(delegatedAuthConfig.device_authorization_endpoint!, {
                status: 200,
                body: {
                    device_code: "device123",
                    user_code: "USER123",
                    verification_uri: "https://auth.org/link",
                    expires_in: 300,
                },
            });

            await startDeviceAuthorization({
                clientId: "test-client-id",
                scope: "test-scope",
                metadata: delegatedAuthConfig,
                logger: mockLogger,
            });

            expect(mockLogger.debug.mock.calls[0]).toEqual(["OAuth2: --> POST https://auth.org/device"]);
        });
    });
});
