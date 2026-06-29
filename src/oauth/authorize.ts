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

import { secureRandomString } from "../randomstring.ts";
import { OAuth2Error } from "./error.ts";
import { type ValidatedAuthMetadata } from "./discover.ts";
import {
    hasOptionalNumberProperty,
    hasOptionalStringProperty,
    hasRequiredNumberProperty,
    hasRequiredStringProperty,
    isRecord,
} from "../@types/type-guards.ts";
import { Method } from "../http-api";
import { OAuthGrantType } from "./register.ts";
import { sleep } from "../utils.ts";

/**
 * The expected response type from the token endpoint during authorization code flow
 * Normalized to always use capitalized 'Bearer' for token_type
 *
 * See https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.4
 */
export type BearerTokenResponse = Omit<ValidTokenResponse, "token_type"> & {
    token_type: "Bearer";
};

/**
 * Metadata from OAuth 2.0 token_endpoint as per
 * https://datatracker.ietf.org/doc/html/rfc6749#section-5.1
 * With validated properties required in type
 *
 * This response is expected for the authorization code grant and refresh token grant,
 * as defined in the Matrix spec.
 */
interface ValidTokenResponse {
    token_type: "Bearer" | "bearer";
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
}

/**
 * Validate the given response matches the format expected for a {@link ValidTokenResponse}
 * @param response - the response to validate
 * @throws if the response does not match the expected format
 */
export function validateBearerTokenResponse(response: unknown): asserts response is ValidTokenResponse {
    if (
        !isRecord(response) ||
        !hasRequiredStringProperty(response, "token_type") ||
        // token_type is case-insensitive, some OPs return `token_type: "bearer"`
        response["token_type"].toLowerCase() !== "bearer" ||
        !hasRequiredStringProperty(response, "access_token") ||
        !hasOptionalNumberProperty(response, "expires_in") ||
        !hasOptionalStringProperty(response, "refresh_token") ||
        !hasOptionalStringProperty(response, "scope")
    ) {
        throw new Error(OAuth2Error.InvalidBearerTokenResponse);
    }
}

/**
 * Generate the scope used in authorization request with OAuth2 IdP
 * @returns scope
 */
export const generateScope = (deviceId?: string): string => {
    const safeDeviceId = deviceId ?? secureRandomString(10);
    return `urn:matrix:client:api:* urn:matrix:client:device:${safeDeviceId}`;
};

/**
 * Parameters for {@link generateAuthorizationCodeGrantUrl}.
 */
export type AuthorizationCodeGrantParams = {
    /**
     * The auth metadata received from {@link MatrixClient.getAuthMetadata}.
     */
    metadata: ValidatedAuthMetadata;
    /**
     * The client ID returned from client registration.
     */
    clientId: string;
    /**
     * The redirect URI that MUST match one of the values registered in the client metadata
     */
    redirectUri: string;
    /**
     * The device ID to use for the new device, will be generated if omitted.
     */
    deviceId?: string;
    /**
     * A cryptographically random value that will allow to make sure that the client that makes the token request
     * for a given code is the same one that made the authorization request.
     *
     * Needs to be persisted and passed back to the SDK after the user returns from the IdP.
     *
     * It is defined in RFC 7636 as a high-entropy cryptographic random string using the characters
     * [A-Z], [a-z], [0-9], -, ., _ and ~ with a minimum length of 43 characters and a maximum length of 128 characters.
     */
    verifier: string;
    /**
     * A unique opaque identifier, like a transaction ID,
     * that will allow the client to maintain state between the authorization request and the callback.
     *
     * The app should use this to key the storage for where the rest of the auth context is saved.
     */
    state: string;
    /**
     * Optional prompt parameter to pass to the IdP to signal intent, e.g. `create` for User registration.
     */
    prompt?: string;
    /**
     * The manner in which the IdP should send the secrets back to the app. Defaults to `fragment` for privacy.
     */
    responseMode?: "query" | "fragment";
};

/**
 * Normalize token_type to use capital case to make consuming the token response easier
 * token_type is case insensitive, and it is spec-compliant for OPs to return token_type: "bearer"
 * Later, when used in auth headers it is case sensitive and must be Bearer
 * See: https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.4
 *
 * @param response - validated token response
 * @returns response with token_type set to 'Bearer'
 */
export const normalizeBearerTokenResponseTokenType = (response: ValidTokenResponse): BearerTokenResponse => ({
    ...response,
    token_type: "Bearer",
});

/**
 * Response from the OAuth2 token endpoint when exchanging a token for grant_type device_code.
 * TODO
 */
export interface DeviceAccessTokenResponse {
    id_token?: string;
    access_token: string;
    token_type: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    session_state?: string;
}

/**
 * Validate the given response matches the format expected for a {@link DeviceAccessTokenResponse}
 * @param response - the response to validate
 * @throws if the response does not match the expected format
 */
export function isValidDeviceAccessTokenResponse(response: unknown): response is DeviceAccessTokenResponse {
    return (
        isRecord(response) &&
        hasRequiredStringProperty(response, "access_token") &&
        hasRequiredStringProperty(response, "token_type") &&
        hasOptionalStringProperty(response, "id_token") &&
        hasOptionalStringProperty(response, "refresh_token") &&
        hasOptionalStringProperty(response, "scope") &&
        hasOptionalStringProperty(response, "session_state") &&
        hasOptionalNumberProperty(response, "expires_in")
    );
}

/**
 * Error from the OAuth2 token endpoint when exchanging a token for grant_type device_code.
 * TODO
 */
export interface DeviceAccessTokenError {
    error: string;
    error_description?: string;
    error_uri?: string;
    session_state?: string;
}

/**
 * Response from the OAuth2 device authorization endpoint.
 * As specified in https://datatracker.ietf.org/doc/html/rfc8628#section-3.2
 */
export interface DeviceAuthorizationResponse {
    /** The device verification code. */
    device_code: string;
    /** The end-user verification code. */
    user_code: string;
    /**
     * The end-user verification URI on the authorization server.
     * The URI should be short and easy to remember as end users will be asked to manually type it into their user agent.
     */
    verification_uri: string;
    /**
     * The URI which doesn’t require the user to manually type the user_code, designed for non-textual transmission.
     */
    verification_uri_complete?: string;
    /** The lifetime in seconds of the "device_code" and "user_code". */
    expires_in: number;
    /**
     * The minimum amount of time in seconds that the client SHOULD wait between polling requests to the token endpoint.
     * If no value is provided, clients MUST use 5 as the default.
     */
    interval?: number;
}

/**
 * Validate the given response matches the format expected for a {@link DeviceAuthorizationResponse}
 * @param response - the response to validate
 * @throws if the response does not match the expected format
 */
export function validateDeviceAuthorizationResponse(
    response: unknown,
): asserts response is DeviceAuthorizationResponse {
    if (
        !isRecord(response) ||
        !hasRequiredStringProperty(response, "device_code") ||
        !hasRequiredStringProperty(response, "user_code") ||
        !hasRequiredStringProperty(response, "verification_uri") ||
        !hasRequiredNumberProperty(response, "expires_in") ||
        !hasOptionalStringProperty(response, "verification_uri_complete") ||
        !hasOptionalNumberProperty(response, "interval")
    ) {
        throw new Error(OAuth2Error.InvalidDeviceAuthorizationResponse);
    }
}

/**
 * Begin OIDC device authorization flow.
 * @param options - The device authorization parameters.
 * @param options.clientId - the client ID returned from client registration.
 * @param options.scope - the scope to request for authorization.
 * @param options.metadata - the validated OIDC metadata for the Identity Provider.
 * @returns a promise that resolves to a device access token response,
 *   or an error response if the user denies authorization or the device code expires.
 */
export const startDeviceAuthorization = async ({
    clientId,
    scope,
    metadata,
}: {
    clientId: string;
    scope: string;
    metadata: ValidatedAuthMetadata;
}): Promise<DeviceAuthorizationResponse> => {
    const body = new URLSearchParams({ client_id: clientId, scope: scope }).toString();

    const url = metadata.device_authorization_endpoint;
    if (!url) {
        throw new Error("No device_authorization_endpoint given");
    }

    const response = await fetch(url, {
        method: Method.Post,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });

    const data = await response.json();
    validateDeviceAuthorizationResponse(data);
    return data;
};

/**
 * Polls the OIDC token endpoint until we get a device access token response, or encounter an unrecoverable error.
 * @param options - The device authorization parameters.
 * @param options.session - The session returned from a previous call to {@link startDeviceAuthorization}.
 * @param options.metadata - The validated OIDC metadata for the Identity Provider.
 * @param options.clientId - The client ID returned from client registration.
 * @returns a promise that resolves to a device access token response,
 *   or an error response if the user denies authorization or the device code expires.
 */
export const waitForDeviceAuthorization = async ({
    session,
    metadata,
    clientId,
}: {
    session: DeviceAuthorizationResponse;
    metadata: ValidatedAuthMetadata;
    clientId: string;
}): Promise<DeviceAccessTokenResponse | DeviceAccessTokenError> => {
    let interval = (session.interval ?? 5) * 1000; // poll interval
    const expiration = Date.now() + session.expires_in * 1000;
    do {
        const body = new URLSearchParams({
            device_code: session.device_code,
            grant_type: OAuthGrantType.DeviceAuthorization,
            client_id: clientId,
        }).toString();
        const response = await fetch(metadata.token_endpoint, {
            method: Method.Post,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });

        const data = await response.json();

        if (response.ok && isValidDeviceAccessTokenResponse(data)) {
            return data;
        }
        const errorResponse = data as DeviceAccessTokenError;
        switch (errorResponse.error) {
            case "authorization_pending":
                break;
            case "slow_down":
                interval += 5000;
                break;
            case "access_denied":
            case "expired_token":
                return errorResponse;
        }
        await sleep(interval);
    } while (Date.now() < expiration);
    return { error: "expired" };
};
