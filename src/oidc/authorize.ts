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
import { Method } from "../http-api";
import { subtleCrypto, TextEncoder } from "../crypto/crypto";
import { logger } from "../logger";
import { randomString } from "../randomstring";
import { OidcError } from "./error";
import { ValidatedIssuerConfig } from "./validate";

/**
 * Authorization parameters which are used in the authentication request of an OIDC auth code flow.
 *
 * See https://openid.net/specs/openid-connect-basic-1_0.html#RequestParameters.
 */
export type AuthorizationParams = {
    state: string;
    scope: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
};

const generateScope = (): string => {
    const deviceId = randomString(10);
    return `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`;
};

// https://www.rfc-editor.org/rfc/rfc7636
const generateCodeChallenge = async (codeVerifier: string): Promise<string> => {
    if (!subtleCrypto) {
        // @TODO(kerrya) should this be allowed? configurable?
        logger.warn("A secure context is required to generate code challenge. Using plain text code challenge");
        return codeVerifier;
    }
    const utf8 = new TextEncoder().encode(codeVerifier);

    const digest = await subtleCrypto.digest("SHA-256", utf8);

    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
};

/**
 * Generate authorization params to pass to {@link #generateAuthorizationUrl}.
 *
 * Used as part of an authorization code OIDC flow: see https://openid.net/specs/openid-connect-basic-1_0.html#CodeFlow.
 *
 * @param redirectUri - absolute url for OP to redirect to after authorization
 * @returns AuthorizationParams
 */
export const generateAuthorizationParams = ({ redirectUri }: { redirectUri: string }): AuthorizationParams => ({
    scope: generateScope(),
    redirectUri,
    state: randomString(8),
    nonce: randomString(8),
    codeVerifier: randomString(64), // https://tools.ietf.org/html/rfc7636#section-4.1 length needs to be 43-128 characters
});

/**
 * Generate a URL to attempt authorization with the OP
 * See https://openid.net/specs/openid-connect-basic-1_0.html#CodeRequest
 * @param authorizationUrl - endpoint to attempt authorization with the OP
 * @param clientId - id of this client as registered with the OP
 * @param authorizationParams - params to be used in the url
 * @returns a Promise with the url as a string
 */
export const generateAuthorizationUrl = async (
    authorizationUrl: string,
    clientId: string,
    { scope, redirectUri, state, nonce, codeVerifier }: AuthorizationParams,
): Promise<string> => {
    const url = new URL(authorizationUrl);
    url.searchParams.append("response_mode", "query");
    url.searchParams.append("response_type", "code");
    url.searchParams.append("redirect_uri", redirectUri);
    url.searchParams.append("client_id", clientId);
    url.searchParams.append("state", state);
    url.searchParams.append("scope", scope);
    url.searchParams.append("nonce", nonce);

    url.searchParams.append("code_challenge_method", "S256");
    url.searchParams.append("code_challenge", await generateCodeChallenge(codeVerifier));

    return url.toString();
};

export type BearerToken = {
    token_type: "Bearer";
    access_token: string;
    scope: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
};
const isValidBearerToken = (token: any): token is BearerToken =>
    typeof token == "object" &&
    token["token_type"] === "Bearer" &&
    typeof token["access_token"] === "string" &&
    (!("refresh_token" in token) || typeof token["refresh_token"] === "string") &&
    (!("expires_in" in token) || typeof token["expires_in"] === "number");

/**
 * Attempt to exchange authorization code for bearer token.
 *
 * Takes the authorization code returned by the OpenID Provider via the authorization URL, and makes a
 * request to the Token Endpoint, to obtain the access token, refresh token, etc.
 *
 * @param code - authorization code as returned by OP during authorization
 * @param storedAuthorizationParams - stored params from start of oidc login flow
 * @returns valid bearer token
 * @throws when request fails, or returned token is invalid
 */
export const completeAuthorizationCodeGrant = async (
    code: string,
    {
        clientId,
        codeVerifier,
        redirectUri,
        delegatedAuthConfig,
    }: {
        clientId: string;
        codeVerifier: string;
        redirectUri: string;
        delegatedAuthConfig: IDelegatedAuthConfig & ValidatedIssuerConfig;
    },
): Promise<BearerToken> => {
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("client_id", clientId);
    params.append("code_verifier", codeVerifier);
    params.append("redirect_uri", redirectUri);
    params.append("code", code);
    const metadata = params.toString();

    const headers = { "Content-Type": "application/x-www-form-urlencoded" };

    const response = await fetch(delegatedAuthConfig.tokenEndpoint, {
        method: Method.Post,
        headers,
        body: metadata,
    });

    if (response.status >= 400) {
        throw new Error(OidcError.CodeExchangeFailed);
    }

    const token = await response.json();

    if (isValidBearerToken(token)) {
        return token;
    }

    throw new Error(OidcError.InvalidBearerToken);
};
