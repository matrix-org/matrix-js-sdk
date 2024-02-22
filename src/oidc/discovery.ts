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

import { MetadataService, OidcClientSettingsStore } from "oidc-client-ts";

import { isValidatedIssuerMetadata, validateOIDCIssuerWellKnown } from "./validate";
import { Method, timeoutSignal } from "../http-api";
import { OidcClientConfig } from "./index";

/**
 * @experimental
 * Discover and validate delegated auth configuration
 * - delegated auth issuer openid-configuration is reachable
 * - delegated auth issuer openid-configuration is configured correctly for us
 * Fetches https://oidc-issuer.example.com/.well-known/openid-configuration and other files linked therein.
 * When successful, validated metadata is returned
 * @param issuer - the OIDC issuer as returned by the /auth_issuer API
 * @returns validated authentication metadata and optionally signing keys
 * @throws when delegated auth config is invalid or unreachable
 */
export const discoverAndValidateOIDCIssuerWellKnown = async (issuer: string): Promise<OidcClientConfig> => {
    const issuerOpenIdConfigUrl = new URL(".well-known/openid-configuration", issuer);
    const issuerWellKnownResponse = await fetch(issuerOpenIdConfigUrl, {
        method: Method.Get,
        signal: timeoutSignal(5000),
    });
    const issuerWellKnown = await issuerWellKnownResponse.json();
    const validatedIssuerConfig = validateOIDCIssuerWellKnown(issuerWellKnown);

    // create a temporary settings store, so we can use metadata service for discovery
    const settings = new OidcClientSettingsStore({
        authority: issuer,
        redirect_uri: "", // Not known yet, this is here to make the type checker happy
        client_id: "", // Not known yet, this is here to make the type checker happy
    });
    const metadataService = new MetadataService(settings);
    const metadata = await metadataService.getMetadata();
    const signingKeys = (await metadataService.getSigningKeys()) ?? undefined;

    isValidatedIssuerMetadata(metadata);

    return {
        ...validatedIssuerConfig,
        metadata,
        signingKeys,
    };
};
