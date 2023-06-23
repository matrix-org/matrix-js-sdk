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

import { IDelegatedAuthConfig } from "../client";
import { OidcError } from "./error";
import { Method } from "../http-api";
import { logger } from "../logger";
import { ValidatedIssuerConfig } from "./validate";

/**
 * Client metadata passed to registration endpoint
 */
export type OidcRegistrationClientMetadata = {
    clientName: string;
    clientUri: string;
    redirectUris: string[];
};

/**
 * Make the client registration request
 * @param registrationEndpoint - URL as returned from issuer ./well-known/openid-configuration
 * @param clientMetadata - registration metadata
 * @returns resolves to the registered client id when registration is successful
 * @throws when registration request fails, or response is invalid
 */
const doRegistration = async (
    registrationEndpoint: string,
    clientMetadata: OidcRegistrationClientMetadata,
): Promise<string> => {
    // https://openid.net/specs/openid-connect-registration-1_0.html
    const metadata = {
        client_name: clientMetadata.clientName,
        client_uri: clientMetadata.clientUri,
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: clientMetadata.redirectUris,
        id_token_signed_response_alg: "RS256",
        token_endpoint_auth_method: "none",
        application_type: "web",
    };
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    };

    try {
        const response = await fetch(registrationEndpoint, {
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

/**
 * Attempts dynamic registration against the configured registration endpoint
 * @param delegatedAuthConfig - Auth config from ValidatedServerConfig
 * @param clientName - Client name to register with the OP, eg 'Element'
 * @param baseUrl - URL of the home page of the Client, eg 'https://app.element.io/'
 * @returns Promise<string> resolved with registered clientId
 * @throws when registration is not supported, on failed request or invalid response
 */
export const registerOidcClient = async (
    delegatedAuthConfig: IDelegatedAuthConfig & ValidatedIssuerConfig,
    clientName: string,
    baseUrl: string,
): Promise<string> => {
    const clientMetadata = {
        clientName,
        clientUri: baseUrl,
        redirectUris: [baseUrl],
    };
    if (!delegatedAuthConfig.registrationEndpoint) {
        throw new Error(OidcError.DynamicRegistrationNotSupported);
    }
    const clientId = await doRegistration(delegatedAuthConfig.registrationEndpoint, clientMetadata);

    return clientId;
};
