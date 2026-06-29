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

import { type OAuthRegistrationRequest, OAuth2, OAuth2Error } from "../../../src/oauth";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";

describe("registerOidcClient()", () => {
    const issuer = "https://auth.com/";
    const clientName = "Element";
    const baseUrl = "https://just.testing";
    const metadata: OAuthRegistrationRequest = {
        client_uri: baseUrl,
        redirect_uris: [baseUrl],
        client_name: clientName,
        application_type: "web",
        tos_uri: "https://just.testing/tos",
        policy_uri: "https://policy.just.testing",
        logo_uri: `${baseUrl}:8443/logo.png`,
    };
    const dynamicClientId = "xyz789";

    const delegatedAuthConfig = makeDelegatedAuthMetadata(issuer);

    it("should make correct request to register client", async () => {
        fetchMock.post(delegatedAuthConfig.registration_endpoint!, {
            status: 200,
            body: JSON.stringify({ client_id: dynamicClientId }),
        });
        expect(await OAuth2.registerOidcClient(delegatedAuthConfig, metadata)).toEqual(dynamicClientId);
        expect(fetchMock.fetchHandler).toHaveFetched(
            delegatedAuthConfig.registration_endpoint,
            expect.objectContaining({
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                method: "POST",
            }),
        );
        expect(JSON.parse(fetchMock.callHistory.callLogs[0].options!.body as string)).toEqual(
            expect.objectContaining({
                client_name: clientName,
                client_uri: baseUrl,
                response_types: ["code"],
                grant_types: ["authorization_code", "refresh_token"],
                redirect_uris: [baseUrl],
                token_endpoint_auth_method: "none",
                application_type: "web",
                tos_uri: "https://just.testing/tos",
                policy_uri: "https://policy.just.testing",
                logo_uri: `${baseUrl}:8443/logo.png`,
            }),
        );
    });

    it("should throw when registration request fails", async () => {
        fetchMock.post(delegatedAuthConfig.registration_endpoint!, {
            status: 500,
        });
        await expect(() => OAuth2.registerOidcClient(delegatedAuthConfig, metadata)).rejects.toThrow(
            OAuth2Error.DynamicRegistrationFailed,
        );
    });

    it("should throw when registration response is invalid", async () => {
        fetchMock.post(delegatedAuthConfig.registration_endpoint!, {
            status: 200,
            // no clientId in response
            body: "{}",
        });
        await expect(() => OAuth2.registerOidcClient(delegatedAuthConfig, metadata)).rejects.toThrow(
            OAuth2Error.DynamicRegistrationInvalid,
        );
    });

    it("should throw when required scopes are unavailable", async () => {
        await expect(() =>
            OAuth2.registerOidcClient(
                {
                    ...delegatedAuthConfig,
                    grant_types_supported: [delegatedAuthConfig.grant_types_supported[0]],
                },
                metadata,
            ),
        ).rejects.toThrow(OAuth2Error.DynamicRegistrationNotSupported);
    });

    it("should filter out invalid URIs", async () => {
        fetchMock.post(delegatedAuthConfig.registration_endpoint!, {
            status: 200,
            body: JSON.stringify({ client_id: dynamicClientId }),
        });
        expect(
            await OAuth2.registerOidcClient(delegatedAuthConfig, {
                ...metadata,
                tos_uri: "http://just.testing/tos",
                policy_uri: "https://policy-uri/",
            }),
        ).toEqual(dynamicClientId);
        expect(JSON.parse(fetchMock.callHistory.callLogs[0].options!.body as string)).not.toEqual(
            expect.objectContaining({
                tos_uri: "http://just.testing/tos",
                policy_uri: "https://policy-uri/",
            }),
        );
    });

    it("should ask for device_code grant if supported", async () => {
        const config = {
            ...delegatedAuthConfig,
            grant_types_supported: [
                ...delegatedAuthConfig.grant_types_supported,
                "urn:ietf:params:oauth:grant-type:device_code",
            ],
        };

        fetchMock.post(config.registration_endpoint!, {
            status: 200,
            body: JSON.stringify({ client_id: dynamicClientId }),
        });
        expect(await OAuth2.registerOidcClient(config, metadata)).toEqual(dynamicClientId);
        expect(fetchMock.fetchHandler).toHaveFetched(
            config.registration_endpoint,
            expect.objectContaining({
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                method: "POST",
            }),
        );
        expect(JSON.parse(fetchMock.callHistory.callLogs[0].options!.body as string)).toEqual(
            expect.objectContaining({
                client_name: clientName,
                client_uri: baseUrl,
                response_types: ["code"],
                grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
                redirect_uris: [baseUrl],
                token_endpoint_auth_method: "none",
                application_type: "web",
                tos_uri: "https://just.testing/tos",
                policy_uri: "https://policy.just.testing",
                logo_uri: `${baseUrl}:8443/logo.png`,
            }),
        );
    });
});
