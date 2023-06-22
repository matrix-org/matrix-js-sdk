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

import { subtleCrypto } from "../crypto/crypto";
import { logger } from "../logger";
import { randomString } from "../randomstring";

type AuthorizationParams = {
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
 * Generate authorization params to pass to authorizationEndpoint
 * As part of an authorization code OIDC flow
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
 * Generates a URL to attempt authorization with the OP
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
    url.searchParams.append("response_mode", "fragment");
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
