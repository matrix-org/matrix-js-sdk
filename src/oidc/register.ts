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

import { type OidcClientConfig } from "./index.ts";
import { OidcError } from "./error.ts";
import { Method } from "../http-api/index.ts";
import { logger } from "../logger.ts";
import { type NonEmptyArray } from "../@types/common.ts";

/**
 * Client metadata passed to registration endpoint
 */
export type OidcRegistrationClientMetadata = {
    clientName: OidcRegistrationRequestBody["client_name"];
    clientUri: OidcRegistrationRequestBody["client_uri"];
    logoUri?: OidcRegistrationRequestBody["logo_uri"];
    applicationType: OidcRegistrationRequestBody["application_type"];
    redirectUris: OidcRegistrationRequestBody["redirect_uris"];
    contacts: OidcRegistrationRequestBody["contacts"];
    tosUri: OidcRegistrationRequestBody["tos_uri"];
    policyUri: OidcRegistrationRequestBody["policy_uri"];
};

/**
 * Request body for dynamic registration as defined by https://github.com/matrix-org/matrix-spec-proposals/pull/2966
 */
interface OidcRegistrationRequestBody {
    client_name?: string;
    client_uri: string;
    logo_uri?: string;
    contacts?: string[];
    tos_uri?: string;
    policy_uri?: string;
    redirect_uris?: NonEmptyArray<string>;
    response_types?: NonEmptyArray<string>;
    grant_types?: NonEmptyArray<string>;
    id_token_signed_response_alg?: string;
    token_endpoint_auth_method: string;
    application_type: "web" | "native";
}

export const DEVICE_CODE_SCOPE = "urn:ietf:params:oauth:grant-type:device_code";

// Check that URIs have a common base, as per the MSC2966 definition
const urlHasCommonBase = (base: URL, urlStr?: string): boolean => {
    if (!urlStr) return false;
    const url = new URL(urlStr);
    if (url.protocol !== base.protocol) return false;
    if (url.hostname !== base.hostname && !url.hostname.endsWith(`.${base.hostname}`)) return false;
    return true;
};

/**
 * Attempts dynamic registration against the configured registration endpoint.
 * Will ignore any URIs that do not use client_uri as a common base as per the spec.
 * @param delegatedAuthConfig - Auth config from {@link discoverAndValidateOIDCIssuerWellKnown}
 * @param clientMetadata - The metadata for the client which to register
 * @returns Promise<string> resolved with registered clientId
 * @throws when registration is not supported, on failed request or invalid response
 */
export const registerOidcClient = async (
    delegatedAuthConfig: OidcClientConfig,
    clientMetadata: OidcRegistrationClientMetadata,
): Promise<string> => {
    if (!delegatedAuthConfig.registration_endpoint) {
        throw new Error(OidcError.DynamicRegistrationNotSupported);
    }

    const grantTypes: NonEmptyArray<string> = ["authorization_code", "refresh_token"];
    if (grantTypes.some((scope) => !delegatedAuthConfig.grant_types_supported.includes(scope))) {
        throw new Error(OidcError.DynamicRegistrationNotSupported);
    }

    const commonBase = new URL(clientMetadata.clientUri);

    // https://openid.net/specs/openid-connect-registration-1_0.html
    const metadata: OidcRegistrationRequestBody = {
        client_name: clientMetadata.clientName,
        client_uri: clientMetadata.clientUri,
        response_types: ["code"],
        grant_types: grantTypes,
        redirect_uris: clientMetadata.redirectUris,
        id_token_signed_response_alg: "RS256",
        token_endpoint_auth_method: "none",
        application_type: clientMetadata.applicationType,
        contacts: clientMetadata.contacts,
        logo_uri: urlHasCommonBase(commonBase, clientMetadata.logoUri) ? clientMetadata.logoUri : undefined,
        policy_uri: urlHasCommonBase(commonBase, clientMetadata.policyUri) ? clientMetadata.policyUri : undefined,
        tos_uri: urlHasCommonBase(commonBase, clientMetadata.tosUri) ? clientMetadata.tosUri : undefined,
    };

    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    };

    try {
        const response = await fetch(delegatedAuthConfig.registration_endpoint, {
            method: Method.Post,
            headers,
            body: JSON.stringify(metadata),
        });

        if (response.status >= 400) {
            throw new Error(OidcError.DynamicRegistrationFailed);
        }

        const body = await response.json();
        const clientId = body["client_id"];
        if (!clientId || typeof clientId !== "string") {
            throw new Error(OidcError.DynamicRegistrationInvalid);
        }

        return clientId;
    } catch (error) {
        if (Object.values(OidcError).includes((error as Error).message as OidcError)) {
            throw error;
        } else {
            logger.error("Dynamic registration request failed", error);
            throw new Error(OidcError.DynamicRegistrationFailed);
        }
    }
};
