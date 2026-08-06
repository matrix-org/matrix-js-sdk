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

import { hasOptionalStringProperty, hasRequiredStringProperty, isRecord } from "../@types/type-guards.ts";
import { HTTPError } from "../http-api/errors.ts";

/**
 * Errors expected to be encountered during OAuth2 discovery, client registration, and authentication.
 * Not intended to be displayed directly to the user.
 */
export enum OAuth2Error {
    General = "Something went wrong with OAuth2 discovery",
    OpSupport = "Configured OAuth2 OP does not support required functions",
    DynamicRegistrationNotSupported = "Dynamic registration not supported",
    DynamicRegistrationFailed = "Dynamic registration failed",
    DynamicRegistrationInvalid = "Dynamic registration invalid response",
    CodeExchangeFailed = "Failed to exchange code for token",
    InvalidBearerTokenResponse = "Invalid bearer token response",
    InvalidDeviceAuthorizationResponse = "Invalid device authorization response",
    MissingOrInvalidStoredState = "State required to finish logging in is not found in storage.",
    RefreshTokenFailed = "Failed to refresh token",
    RevokeTokenFailed = "Failed to revoke token",
    DeviceAuthorizationGrantFailed = "Failed to perform device authorization grant",
}

/**
 * An error response from an OAuth 2.0 endpoint,
 * as specified in https://datatracker.ietf.org/doc/html/rfc6749#section-5.2
 */
export interface OAuth2ErrorResponse {
    /** A single ASCII error code, e.g. `invalid_grant`. */
    error: string;
    /** Human-readable ASCII text providing additional information about the error. */
    error_description?: string;
    /** A URI identifying a human-readable web page with information about the error. */
    error_uri?: string;
}

/**
 * Check whether the given (JSON-parsed) response body is an OAuth 2.0 error response
 * as specified in https://datatracker.ietf.org/doc/html/rfc6749#section-5.2
 * @param response - the parsed response body to check
 * @returns whether the response is a valid {@link OAuth2ErrorResponse}
 */
export function isOAuth2ErrorResponse(response: unknown): response is OAuth2ErrorResponse {
    return (
        isRecord(response) &&
        hasRequiredStringProperty(response, "error") &&
        hasOptionalStringProperty(response, "error_description") &&
        hasOptionalStringProperty(response, "error_uri")
    );
}

/**
 * An error thrown when a request to an OAuth 2.0 endpoint fails.
 *
 * If the endpoint responded with a JSON body matching the error response format specified in
 * https://datatracker.ietf.org/doc/html/rfc6749#section-5.2 then it is available as {@link errorResponse}.
 */
export class OAuth2HTTPError extends HTTPError implements OAuth2ErrorResponse {
    /**
     * RFC 6749 section 5.2 error code, e.g. `invalid_grant`
     *
     * IANA matains a registry of valid values at
     * https://www.iana.org/assignments/oauth-parameters/oauth-parameters.xhtml#extensions-error
     */
    public error: string;

    /**
     * RFC 6749 section 5.2 human-readable ASCII text providing additional information about the error.
     * This field is optional and may be omitted by the endpoint.
     */
    public error_description?: string;

    /**
     * RFC 6749 section 5.2 URI identifying a human-readable web page with information about the error.
     * This field is optional and may be omitted by the endpoint.
     */
    public error_uri?: string;

    public constructor(
        msg: string,
        httpStatus: number | undefined,
        httpHeaders: Headers | undefined,
        { error, error_description, error_uri }: OAuth2ErrorResponse,
    ) {
        super(msg, httpStatus, httpHeaders);
        this.error = error;
        this.error_description = error_description;
        this.error_uri = error_uri;
    }
}
