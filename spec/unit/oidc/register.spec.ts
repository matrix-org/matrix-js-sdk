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

import fetchMockJest from "fetch-mock-jest";

import { OidcError } from "../../../src/oidc/error";
import { registerOidcClient } from "../../../src/oidc/register";

describe("registerOidcClient()", () => {
    const issuer = "https://auth.com/";
    const registrationEndpoint = "https://auth.com/register";
    const clientName = "Element";
    const baseUrl = "https://just.testing";
    const dynamicClientId = "xyz789";

    const delegatedAuthConfig = {
        issuer,
        registrationEndpoint,
        authorizationEndpoint: issuer + "auth",
        tokenEndpoint: issuer + "token",
    };
    beforeEach(() => {
        fetchMockJest.mockClear();
        fetchMockJest.resetBehavior();
    });

    it("should make correct request to register client", async () => {
        fetchMockJest.post(registrationEndpoint, {
            status: 200,
            body: JSON.stringify({ client_id: dynamicClientId }),
        });
        expect(await registerOidcClient(delegatedAuthConfig, clientName, baseUrl)).toEqual(dynamicClientId);
        expect(fetchMockJest).toHaveBeenCalledWith(registrationEndpoint, {
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method: "POST",
            body: JSON.stringify({
                client_name: clientName,
                client_uri: baseUrl,
                response_types: ["code"],
                grant_types: ["authorization_code", "refresh_token"],
                redirect_uris: [baseUrl],
                id_token_signed_response_alg: "RS256",
                token_endpoint_auth_method: "none",
                application_type: "web",
            }),
        });
    });

    it("should throw when registration request fails", async () => {
        fetchMockJest.post(registrationEndpoint, {
            status: 500,
        });
        expect(() => registerOidcClient(delegatedAuthConfig, clientName, baseUrl)).rejects.toThrow(
            OidcError.DynamicRegistrationFailed,
        );
    });

    it("should throw when registration response is invalid", async () => {
        fetchMockJest.post(registrationEndpoint, {
            status: 200,
            // no clientId in response
            body: "{}",
        });
        expect(() => registerOidcClient(delegatedAuthConfig, clientName, baseUrl)).rejects.toThrow(
            OidcError.DynamicRegistrationInvalid,
        );
    });
});
