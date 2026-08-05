/*
Copyright 2023-2026 The Matrix.org Foundation C.I.C.

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

import { type NonEmptyArray } from "../@types/common.ts";
import { hasRequiredStringProperty, isRecord } from "../@types/type-guards.ts";

type LocalizableKeys = "client_name" | "client_uri" | "policy_uri" | "tos_uri" | "logo_uri";

/**
 * Request body for dynamic registration as defined by https://spec.matrix.org/v1.18/client-server-api/#client-registration
 */
export type OAuthRegistrationRequest = {
    /**
     * Kind of the application.
     *
     * The homeserver MUST support the web and native values to be able to perform redirect URI validation.
     *
     * Defaults to web if omitted.
     */
    application_type?: "web" | "native";
    /**
     * Human-readable name of the client to be presented to the user.
     *
     * This field can be localized by specifying `client_name#$lang`.
     */
    client_name?: string;
    /**
     * A URL to a valid web page that SHOULD give the user more information about the client.
     *
     * This URL MUST use the https scheme and SHOULD NOT require authentication to access.
     * It MUST NOT use a user or password in the authority component of the URI.
     *
     * The server MAY reject client registrations if this field is invalid or missing.
     *
     * This URI is a common base for all the other URIs in the metadata:
     * those MUST be either on the same host or on a subdomain of the host of the client_uri.
     * The port number, path and query components MAY be different.
     *
     * For example, if the client_uri is https://example.com/,
     * then one of the redirect_uris can be https://example.com/callback or https://app.example.com/callback,
     * but not https://app.com/callback.
     *
     * This field can be localized by specifying `client_uri#$lang`.
     */
    client_uri: string;
    /**
     * Array of the OAuth 2.0 grant types that the client may use.
     *
     * This MUST include:
     *
     * the authorization_code value to use the authorization code grant,
     * the refresh_token value to use the refresh token grant.
     */
    grant_types?: NonEmptyArray<string>;
    /**
     * URL that references a logo for the client.
     *
     * This URL MUST use the https scheme.
     *
     * This field can be localized by specifying `logo_uri#$lang`.
     */
    logo_uri?: string;
    /**
     * URL that points to a human-readable policy document for the client.
     *
     * This URL MUST use the https scheme and SHOULD NOT require authentication to access.
     * It MUST NOT use a user or password in the authority component of the URI.
     *
     * This field can be localized by specifying `policy_uri#$lang`.
     */
    policy_uri?: string;
    /**
     * Array of redirection URIs for use in redirect-based flows.
     *
     * At least one URI is required to use the authorization code grant.
     */
    redirect_uris?: NonEmptyArray<string>;
    /**
     * Array of the OAuth 2.0 response types that the client may use.
     *
     * This MUST include the code value to use the authorization code grant.
     */
    response_types?: NonEmptyArray<string>;
    /**
     * String indicator of the requested authentication method for the token endpoint.
     */
    token_endpoint_auth_method?: string;
    /**
     * URL that points to a human-readable terms of service document for the client.
     *
     * This URL MUST use the https scheme and SHOULD NOT require authentication to access.
     * It MUST NOT use a user or password in the authority component of the URI.
     *
     * This field can be localized by specifying `tos_uri#$lang`.
     */
    tos_uri?: string;
} & {
    // --- Dynamic Localized Fields (e.g., client_name#es-ES) ---
    [K in `${LocalizableKeys}#${string}`]?: string;
};

/**
 * The OAuth 2.0 grant types that are defined for Matrix in https://spec.matrix.org/v1.17/client-server-api/#grant-types
 */
export enum OAuthGrantType {
    /**
     * As per RFC 6749 section 4.1, the authorization code grant lets the client obtain an access token through a browser redirect.
     *
     * See https://spec.matrix.org/v1.18/client-server-api/#authorization-code-grant
     */
    AuthorizationCode = "authorization_code",
    /**
     * As per RFC 6749 section 6, the refresh token grant lets the client exchange a refresh token for an access token.
     *
     * https://spec.matrix.org/v1.18/client-server-api/#refresh-token-grant
     */
    RefreshToken = "refresh_token",
    /**
     * As per RFC 8628, the device authorization grant lets clients on devices with limited input capabilities obtain
     * an access token by having the user complete authorization on a separate device with a web browser.
     *
     * See https://spec.matrix.org/v1.18/client-server-api/#device-authorization-grant
     */
    DeviceAuthorization = "urn:ietf:params:oauth:grant-type:device_code",
}

/**
 * Check that URIs have a common base,
 * as per https://spec.matrix.org/v1.18/client-server-api/#redirect-uri-validation
 */
export function urlHasCommonBase(base: URL, urlStr?: string): boolean {
    if (!urlStr) return false;
    const url = new URL(urlStr);
    if (url.protocol !== base.protocol) return false;
    if (url.hostname !== base.hostname && !url.hostname.endsWith(`.${base.hostname}`)) return false;
    return true;
}

/**
 * Response from dynamic registration
 */
type RegistrationResponse = {
    client_id: string;
};

/**
 * Validate the given response matches the format expected for a {@link RegistrationResponse}
 * @param response - the response to validate
 * @throws if the response does not match the expected format
 */
export function validateRegistrationResponse(response: unknown): response is RegistrationResponse {
    return isRecord(response) && hasRequiredStringProperty(response, "client_id");
}
