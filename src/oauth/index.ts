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
    type BearerTokenResponse,
    type DeviceAccessTokenError,
    type DeviceAccessTokenResponse,
    type DeviceAuthorizationResponse,
    generateScope,
    normalizeBearerTokenResponseTokenType,
    startDeviceAuthorization,
    validateBearerTokenResponse,
    waitForDeviceAuthorization,
} from "./authorize.ts";
import type { ValidatedAuthMetadata } from "./discover.ts";
import {
    OAuthGrantType,
    type OAuthRegistrationRequest,
    urlHasCommonBase,
    validateRegistrationResponse,
} from "./register.ts";
import { encodeUnpaddedBase64Url } from "../base64.ts";
import { sha256 } from "../digest.ts";
import { HTTPError, Method } from "../http-api";
import { logger } from "../logger.ts";
import { OAuth2Error } from "./error.ts";
import { secureRandomString } from "../randomstring.ts";
import { type NonEmptyArray } from "../@types/common.ts";

export * from "./authorize.ts";
export * from "./error.ts";
export * from "./register.ts";
export * from "./tokenRefresher.ts";
export * from "./discover.ts";

/**
 * Type representing the persistent context needed for typical OAuth flows
 */
type Context = {
    /** The OAuth client ID */
    clientId: string;
    /** The desired device ID */
    deviceId?: string;
    /** The seed used to generate the challenge code */
    codeVerifier?: string;
    /** The URI to redirect the user to with credentials after auth */
    redirectUri: string;
};

export class OAuth2 {
    /**
     * Attempts dynamic registration against the configured registration endpoint.
     * Will ignore any URIs that do not use client_uri as a common base as per the spec.
     * @param authMetadata - Auth config from {@link MatrixClient.getAuthMetadata}
     * @param clientMetadata - The metadata for the client which to register,
     *     grant_types & response_types & token_endpoint_auth_method will be sanely calculated if omitted.
     * @returns Promise<string> resolved with registered clientId
     * @throws when registration is not supported, on failed request or invalid response
     */
    public static async registerClient(
        authMetadata: ValidatedAuthMetadata,
        clientMetadata: OAuthRegistrationRequest,
    ): Promise<string> {
        const defaultGrantTypes: NonEmptyArray<string> = [
            OAuthGrantType.AuthorizationCode,
            OAuthGrantType.RefreshToken,
        ];
        // ask for device authorization grant if supported
        if (authMetadata.grant_types_supported.includes(OAuthGrantType.DeviceAuthorization)) {
            defaultGrantTypes.push(OAuthGrantType.DeviceAuthorization);
        }

        const grantTypes = clientMetadata.grant_types ?? defaultGrantTypes;
        if (grantTypes.some((scope) => !authMetadata.grant_types_supported.includes(scope))) {
            throw new Error(OAuth2Error.DynamicRegistrationNotSupported);
        }

        const commonBase = new URL(clientMetadata.client_uri);

        const request: OAuthRegistrationRequest = {
            // Apply some defaults
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            ...clientMetadata,
            grant_types: grantTypes,
            logo_uri: urlHasCommonBase(commonBase, clientMetadata.logo_uri) ? clientMetadata.logo_uri : undefined,
            policy_uri: urlHasCommonBase(commonBase, clientMetadata.policy_uri) ? clientMetadata.policy_uri : undefined,
            tos_uri: urlHasCommonBase(commonBase, clientMetadata.tos_uri) ? clientMetadata.tos_uri : undefined,
        };

        try {
            const response = await fetch(authMetadata.registration_endpoint, {
                method: Method.Post,
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            });

            if (response.status >= 400) {
                throw new Error(OAuth2Error.DynamicRegistrationFailed);
            }

            const registrationResponse = await response.json();
            if (validateRegistrationResponse(registrationResponse)) {
                return registrationResponse.client_id;
            }

            throw new Error(OAuth2Error.DynamicRegistrationInvalid);
        } catch (error) {
            if (Object.values(OAuth2Error).includes((error as Error).message as OAuth2Error)) {
                throw error;
            } else {
                logger.error("Dynamic registration request failed", error);
                throw new Error(OAuth2Error.DynamicRegistrationFailed, { cause: error });
            }
        }
    }

    public readonly context: Required<Context>;

    public constructor(
        public readonly metadata: ValidatedAuthMetadata,
        context: Context,
    ) {
        this.context = {
            clientId: context.clientId,
            redirectUri: context.redirectUri,
            deviceId: context.deviceId ?? secureRandomString(10),
            codeVerifier: context.codeVerifier ?? secureRandomString(96),
        };
    }

    /**
     * Generate a URL to attempt authorization with the OP
     * See https://spec.matrix.org/v1.18/client-server-api/#authorization-code-flow
     * @param state - A unique opaque identifier, like a transaction ID,
     *     that will allow the client to maintain state between the authorization request and the callback.
     *     The app should use this to key the storage for where the rest of the auth context is saved.
     * @param responseMode - The manner in which the IdP should send the secrets back to the app. Defaults to `fragment` for privacy.
     * @param prompt - Optional prompt parameter to pass to the IdP to signal intent, e.g. `create` for User registration.
     * @param scope - The OAuth2 scope to request, will be generated based on the device ID if omitted.
     * @returns a Promise with the url as a string
     */
    public async generateAuthorizationCodeGrantUrl(
        state: string,
        responseMode: "fragment" | "query" = "fragment",
        prompt?: string,
        scope?: string,
    ): Promise<string> {
        const challenge = encodeUnpaddedBase64Url(await sha256(this.context.codeVerifier));

        const url = new URL(this.metadata.authorization_endpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("response_mode", responseMode);
        url.searchParams.set("client_id", this.context.clientId);
        url.searchParams.set("redirect_uri", this.context.redirectUri);
        url.searchParams.set("scope", scope ?? generateScope(this.context.deviceId));
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("code_challenge", challenge);

        if (prompt) {
            url.searchParams.set("prompt", prompt);
        }

        return url.toString();
    }

    /**
     * Attempt to exchange authorization code for bearer token.
     *
     * Takes the authorization code returned by the OAuth2 Provider via the authorization URL, and makes a
     * request to the Token Endpoint, to obtain the access token, refresh token, etc.
     *
     * @param code - authorization code as returned by IdP during authorization
     * @returns a validated bearer token response
     * @throws An `Error` with `message` set to an entry in {@link OAuth2Error},
     *      when the request fails, or the returned token response is invalid.
     */
    public async completeAuthorizationCodeGrant(code: string): Promise<BearerTokenResponse> {
        const params = new URLSearchParams();
        params.append("grant_type", "authorization_code");
        params.append("client_id", this.context.clientId);
        params.append("code_verifier", this.context.codeVerifier);
        params.append("redirect_uri", this.context.redirectUri);
        params.append("code", code);

        const tokenResponse = await this.fetch("token", params, OAuth2Error.CodeExchangeFailed);

        // throws when response is invalid
        validateBearerTokenResponse(tokenResponse);
        return normalizeBearerTokenResponseTokenType(tokenResponse);
    }

    /**
     * Refresh the access token using the given refresh token and the refresh token grant
     * @param refreshToken - the token to use to refresh the access token
     */
    public async performRefreshTokenGrant(refreshToken: string): Promise<BearerTokenResponse> {
        const params = new URLSearchParams();
        params.append("grant_type", "refresh_token");
        params.append("client_id", this.context.clientId);
        params.append("refresh_token", refreshToken);

        const tokenResponse = await this.fetch("token", params, OAuth2Error.RefreshTokenFailed);

        // throws when response is invalid
        validateBearerTokenResponse(tokenResponse);
        return normalizeBearerTokenResponseTokenType(tokenResponse);
    }

    /**
     * Revokes the given token
     * @param token - the token to remove
     * @param type - the type of token, acts as a hint to the IdP
     */
    public async revokeToken(token: string, type?: "access_token" | "refresh_token"): Promise<void> {
        const params = new URLSearchParams();
        params.append("token", token);
        params.append("client_id", this.context.clientId);
        if (type) {
            params.append("token_type_hint", type);
        }

        await this.fetch("revocation", params, OAuth2Error.RevokeTokenFailed);

        const headers = new Headers();
        headers.set("Content-Type", "application/x-www-form-urlencoded");
    }

    /**
     * Begin OAuth2 device authorization flow.
     * @param scope - the scope to request for authorization.
     * @returns a promise that resolves to a device access token response,
     *   or an error response if the user denies authorization or the device code expires.
     */
    public async startDeviceAuthorizationGrant(scope?: string): Promise<DeviceAuthorizationResponse> {
        return startDeviceAuthorization({
            scope: scope ?? generateScope(this.context.deviceId),
            metadata: this.metadata,
            clientId: this.context.clientId,
        });
    }

    /**
     * Polls the OAuth2 token endpoint until we get a device access token response, or encounter an unrecoverable error.
     * @param session - The session returned from a previous call to {@link OAuth2.startDeviceAuthorizationGrant}.
     * @returns a promise that resolves to a device access token response,
     *   or an error response if the user denies authorization or the device code expires.
     */
    public async waitForDeviceAuthorizationGrant(
        session: DeviceAuthorizationResponse,
    ): Promise<DeviceAccessTokenResponse | DeviceAccessTokenError> {
        return waitForDeviceAuthorization({
            session,
            metadata: this.metadata,
            clientId: this.context.clientId,
        });
    }

    private async fetch(
        target: "token" | "registration" | "revocation",
        params: URLSearchParams,
        error: OAuth2Error,
    ): Promise<unknown> {
        const url = this.metadata[`${target}_endpoint`];
        const res = await fetch(url, {
            method: Method.Post,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            body: params,
        });

        if (res.status >= 400) {
            throw new HTTPError(error, res.status, res.headers);
        }

        return await res.json();
    }
}
