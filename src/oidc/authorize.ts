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

import { IdTokenClaims, Log, OidcClient, SigninResponse, SigninState, WebStorageStateStore } from "oidc-client-ts";

import { logger } from "../logger";
import { randomString } from "../randomstring";
import { OidcError } from "./error";
import {
    BearerTokenResponse,
    UserState,
    validateBearerTokenResponse,
    ValidatedIssuerMetadata,
    validateIdToken,
    validateStoredUserState,
} from "./validate";
import { sha256 } from "../digest";
import { encodeUnpaddedBase64Url } from "../base64";

// reexport for backwards compatibility
export type { BearerTokenResponse };

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

/**
 * @experimental
 * Generate the scope used in authorization request with OIDC OP
 * @returns scope
 */
export const generateScope = (deviceId?: string): string => {
    const safeDeviceId = deviceId ?? randomString(10);
    return `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${safeDeviceId}`;
};

// https://www.rfc-editor.org/rfc/rfc7636
const generateCodeChallenge = async (codeVerifier: string): Promise<string> => {
    if (!globalThis.crypto.subtle) {
        // @TODO(kerrya) should this be allowed? configurable?
        logger.warn("A secure context is required to generate code challenge. Using plain text code challenge");
        return codeVerifier;
    }

    const hashBuffer = await sha256(codeVerifier);
    return encodeUnpaddedBase64Url(hashBuffer);
};

/**
 * Generate authorization params to pass to {@link generateAuthorizationUrl}.
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
 * @deprecated use generateOidcAuthorizationUrl
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

/**
 * @experimental
 * Generate a URL to attempt authorization with the OP
 * See https://openid.net/specs/openid-connect-basic-1_0.html#CodeRequest
 * @param metadata - validated metadata from OP discovery
 * @param clientId - this client's id as registered with the OP
 * @param homeserverUrl - used to establish the session on return from the OP
 * @param identityServerUrl - used to establish the session on return from the OP
 * @param nonce - state
 * @param prompt - indicates to the OP which flow the user should see - eg login or registration
 *          See https://openid.net/specs/openid-connect-prompt-create-1_0.html#name-prompt-parameter
 * @param urlState - value to append to the opaque state identifier to uniquely identify the callback
 * @returns a Promise with the url as a string
 */
export const generateOidcAuthorizationUrl = async ({
    metadata,
    redirectUri,
    clientId,
    homeserverUrl,
    identityServerUrl,
    nonce,
    prompt,
    urlState,
}: {
    clientId: string;
    metadata: ValidatedIssuerMetadata;
    homeserverUrl: string;
    identityServerUrl?: string;
    redirectUri: string;
    nonce: string;
    prompt?: string;
    urlState?: string;
}): Promise<string> => {
    const scope = generateScope();
    const oidcClient = new OidcClient({
        ...metadata,
        client_id: clientId,
        redirect_uri: redirectUri,
        authority: metadata.issuer,
        response_mode: "query",
        response_type: "code",
        scope,
        stateStore: new WebStorageStateStore({ prefix: "mx_oidc_", store: window.sessionStorage }),
    });
    const userState: UserState = { homeserverUrl, nonce, identityServerUrl };
    const request = await oidcClient.createSigninRequest({
        state: userState,
        nonce,
        prompt,
        url_state: urlState,
    });

    return request.url;
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
const normalizeBearerTokenResponseTokenType = (response: SigninResponse): BearerTokenResponse =>
    ({
        id_token: response.id_token,
        scope: response.scope,
        expires_at: response.expires_at,
        refresh_token: response.refresh_token,
        access_token: response.access_token,
        token_type: "Bearer",
    }) as BearerTokenResponse;

/**
 * @experimental
 * Attempt to exchange authorization code for bearer token.
 *
 * Takes the authorization code returned by the OpenID Provider via the authorization URL, and makes a
 * request to the Token Endpoint, to obtain the access token, refresh token, etc.
 *
 * @param code - authorization code as returned by OP during authorization
 * @param storedAuthorizationParams - stored params from start of oidc login flow
 * @returns valid bearer token response
 * @throws An `Error` with `message` set to an entry in {@link OidcError},
 *      when the request fails, or the returned token response is invalid.
 */
export const completeAuthorizationCodeGrant = async (
    code: string,
    state: string,
): Promise<{
    oidcClientSettings: { clientId: string; issuer: string };
    tokenResponse: BearerTokenResponse;
    homeserverUrl: string;
    idTokenClaims: IdTokenClaims;
    identityServerUrl?: string;
}> => {
    /**
     * Element Web strips and changes the url on starting the app
     * Use the code and state from query params to rebuild a url
     * so that oidc-client can parse it
     */
    const reconstructedUrl = new URL(window.location.origin);
    reconstructedUrl.searchParams.append("code", code);
    reconstructedUrl.searchParams.append("state", state);

    // set oidc-client to use our logger
    Log.setLogger(logger);
    try {
        const response = new SigninResponse(reconstructedUrl.searchParams);

        const stateStore = new WebStorageStateStore({ prefix: "mx_oidc_", store: window.sessionStorage });

        // retrieve the state we put in storage at the start of oidc auth flow
        const stateString = await stateStore.get(response.state!);
        if (!stateString) {
            throw new Error(OidcError.MissingOrInvalidStoredState);
        }

        // hydrate the sign in state and create a client
        // the stored sign in state includes oidc configuration we set at the start of the oidc login flow
        const signInState = await SigninState.fromStorageString(stateString);
        const client = new OidcClient({ ...signInState, stateStore });

        // validate the code and state, and attempt to swap the code for tokens
        const signinResponse = await client.processSigninResponse(reconstructedUrl.href);

        // extra values we stored at the start of the login flow
        // used to complete login in the client
        const userState = signinResponse.userState;
        validateStoredUserState(userState);

        // throws when response is invalid
        validateBearerTokenResponse(signinResponse);
        // throws when token is invalid
        validateIdToken(signinResponse.id_token, client.settings.authority, client.settings.client_id, userState.nonce);
        const normalizedTokenResponse = normalizeBearerTokenResponseTokenType(signinResponse);

        return {
            oidcClientSettings: {
                clientId: client.settings.client_id,
                issuer: client.settings.authority,
            },
            tokenResponse: normalizedTokenResponse,
            homeserverUrl: userState.homeserverUrl,
            identityServerUrl: userState.identityServerUrl,
            idTokenClaims: signinResponse.profile,
        };
    } catch (error) {
        logger.error("Oidc login failed", error);
        const errorType = (error as Error).message;

        // rethrow errors that we recognise
        if (Object.values(OidcError).includes(errorType as any)) {
            throw error;
        }
        throw new Error(OidcError.CodeExchangeFailed);
    }
};
