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

import { OidcClientConfig, ValidatedAuthMetadata } from "../../src";

/**
 * Makes a valid OidcClientConfig with minimum valid values
 * @param issuer used as the base for all other urls
 * @param additionalGrantTypes to add to the default grant types
 * @returns OidcClientConfig
 * @experimental
 */
export const makeDelegatedAuthConfig = (
    issuer = "https://auth.org/",
    additionalGrantTypes: string[] = [],
): OidcClientConfig => {
    const metadata = mockOpenIdConfiguration(issuer, additionalGrantTypes);

    return {
        ...metadata,
        signingKeys: null,
    };
};

/**
 * Useful for mocking <issuer>/.well-known/openid-configuration
 * @param issuer used as the base for all other urls
 * @param additionalGrantTypes to add to the default grant types
 * @returns ValidatedAuthMetadata
 * @experimental
 */
export const mockOpenIdConfiguration = (
    issuer = "https://auth.org/",
    additionalGrantTypes: string[] = [],
): ValidatedAuthMetadata => ({
    issuer,
    revocation_endpoint: issuer + "revoke",
    token_endpoint: issuer + "token",
    authorization_endpoint: issuer + "auth",
    registration_endpoint: issuer + "registration",
    device_authorization_endpoint: issuer + "device",
    jwks_uri: issuer + "jwks",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", ...additionalGrantTypes],
    code_challenge_methods_supported: ["S256"],
});
