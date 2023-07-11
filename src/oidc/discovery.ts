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

import { MetadataService, OidcClientSettingsStore, SigningKey } from "oidc-client-ts";

import { IDelegatedAuthConfig } from "../client";
import { isValidatedIssuerMetadata, ValidatedIssuerMetadata, validateWellKnownAuthentication } from "./validate";

/**
 * @experimental
 * Discover and validate delegated auth configuration
 * - m.authentication config is present and valid
 * - delegated auth issuer openid-configuration is reachable
 * - delegated auth issuer openid-configuration is configured correctly for us
 * When successful, validated metadata is returned
 * @param wellKnown - configuration object as returned
 * by the .well-known auto-discovery endpoint
 * @returns validated authentication metadata and optionally signing keys
 * @throws when delegated auth config is invalid or unreachable
 */
export const discoverAndValidateAuthenticationConfig = async (
    authenticationConfig?: IDelegatedAuthConfig,
): Promise<
    IDelegatedAuthConfig & {
        metadata: ValidatedIssuerMetadata;
        signingKeys?: SigningKey[];
    }
> => {
    const homeserverAuthenticationConfig = validateWellKnownAuthentication(authenticationConfig);

    // create a temporary settings store so we can use metadata service for discovery
    const settings = new OidcClientSettingsStore({
        authority: homeserverAuthenticationConfig.issuer,
        redirect_uri: "", // Not known yet, this is here to make the type checker happy
        client_id: "", // Not known yet, this is here to make the type checker happy
    });
    const metadataService = new MetadataService(settings);
    const metadata = await metadataService.getMetadata();
    const signingKeys = (await metadataService.getSigningKeys()) ?? undefined;

    isValidatedIssuerMetadata(metadata);

    return {
        ...homeserverAuthenticationConfig,
        metadata,
        signingKeys,
    };
};
