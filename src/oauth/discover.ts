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

import {
    hasOptionalStringProperty,
    hasRequiredStringProperty,
    isRecord,
    optionalStringArrayProperty,
    requiredArrayValue,
} from "../@types/type-guards.ts";
import { OAuthGrantType } from "./index.ts";

/**
 * Metadata from OAuth 2.0 client authentication API as per
 * https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv1auth_metadata
 * With validated properties required in type
 */
export interface ValidatedAuthMetadata {
    /** List of actions that the account management URL supports. */
    account_management_actions_supported?: string[];
    /** The URL where the user is able to access the account management capabilities of the homeserver. */
    account_management_uri?: string;
    /** URL of the authorization endpoint, necessary to use the authorization code grant. */
    authorization_endpoint: string;
    /**
     * List of OAuth 2.0 Proof Key for Code Exchange (PKCE) code challenge methods that the server supports at the authorization endpoint.
     *
     * This array MUST contain at least the S256 value, for improved security in the authorization code grant.
     */
    code_challenge_methods_supported: string[];
    /** URL of the device authorization endpoint, as defined in RFC 8628, necessary to use the device authorization grant. */
    device_authorization_endpoint?: string;
    /**
     * List of OAuth 2.0 grant type strings that the server supports at the token endpoint.
     *
     * This array MUST contain at least the authorization_code and refresh_token values,
     * for clients to be able to use the authorization code grant and refresh token grant, respectively.
     */
    grant_types_supported: string[];
    /** The authorization server’s issuer identifier, which is a URL that uses the https scheme and has no query or fragment components. */
    issuer: string;
    /** List of OpenID Connect prompt values that the server supports at the authorization endpoint. */
    prompt_values_supported?: string[];
    /** URL of the client registration endpoint, necessary to perform dynamic registration of a client. */
    registration_endpoint: string;
    /**
     * List of OAuth 2.0 response mode strings that the server supports at the authorization endpoint.
     *
     * This array MUST contain at least the query and fragment values, for improved security in the authorization code grant.
     */
    response_modes_supported: string[];
    /**
     * List of OAuth 2.0 response type strings that the server supports at the authorization endpoint.
     *
     * This array MUST contain at least the code value, for clients to be able to use the authorization code grant.
     */
    response_types_supported: string[];
    /** URL of the revocation endpoint, necessary to log out a client by invalidating its access and refresh tokens. */
    revocation_endpoint: string;
    /** URL of the token endpoint, used by the grants. */
    token_endpoint: string;
}

/**
 * Validates OAuth 2.0 auth metadata as defined by
 * https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv1auth_metadata
 * @param authMetadata - json object
 * @returns boolean of whether the input is valid
 */
export const isValidAuthMetadata = (authMetadata: unknown): authMetadata is ValidatedAuthMetadata => {
    return (
        isRecord(authMetadata) &&
        hasRequiredStringProperty(authMetadata, "issuer") &&
        hasRequiredStringProperty(authMetadata, "authorization_endpoint") &&
        hasRequiredStringProperty(authMetadata, "token_endpoint") &&
        hasRequiredStringProperty(authMetadata, "revocation_endpoint") &&
        hasRequiredStringProperty(authMetadata, "registration_endpoint") &&
        hasOptionalStringProperty(authMetadata, "account_management_uri") &&
        hasOptionalStringProperty(authMetadata, "device_authorization_endpoint") &&
        optionalStringArrayProperty(authMetadata, "account_management_actions_supported") &&
        optionalStringArrayProperty(authMetadata, "prompt_values_supported") &&
        requiredArrayValue(authMetadata, "response_modes_supported", "query") &&
        requiredArrayValue(authMetadata, "response_modes_supported", "fragment") &&
        requiredArrayValue(authMetadata, "response_types_supported", "code") &&
        requiredArrayValue(authMetadata, "grant_types_supported", OAuthGrantType.AuthorizationCode) &&
        requiredArrayValue(authMetadata, "grant_types_supported", OAuthGrantType.RefreshToken) &&
        requiredArrayValue(authMetadata, "code_challenge_methods_supported", "S256")
    );
};
