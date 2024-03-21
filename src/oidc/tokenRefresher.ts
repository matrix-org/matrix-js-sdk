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

import { IdTokenClaims, OidcClient, WebStorageStateStore } from "oidc-client-ts";

import { AccessTokens } from "../http-api";
import { generateScope } from "./authorize";
import { discoverAndValidateOIDCIssuerWellKnown } from "./discovery";
import { logger } from "../logger";

/**
 * @experimental
 * Class responsible for refreshing OIDC access tokens
 *
 * Client implementations will likely want to override {@link persistTokens} to persist tokens after successful refresh
 *
 */
export class OidcTokenRefresher {
    /**
     * Promise which will complete once the OidcClient has been initialised
     * and is ready to start refreshing tokens.
     *
     * Will reject if the client initialisation fails.
     */
    public readonly oidcClientReady!: Promise<void>;
    private oidcClient!: OidcClient;
    private inflightRefreshRequest?: Promise<AccessTokens>;

    public constructor(
        /**
         * The OIDC issuer as returned by the /auth_issuer API
         */
        issuer: string,
        /**
         * id of this client as registered with the OP
         */
        clientId: string,
        /**
         * redirectUri as registered with OP
         */
        redirectUri: string,
        /**
         * Device ID of current session
         */
        deviceId: string,
        /**
         * idTokenClaims as returned from authorization grant
         * used to validate tokens
         */
        private readonly idTokenClaims: IdTokenClaims,
    ) {
        this.oidcClientReady = this.initialiseOidcClient(issuer, clientId, deviceId, redirectUri);
    }

    private async initialiseOidcClient(
        issuer: string,
        clientId: string,
        deviceId: string,
        redirectUri: string,
    ): Promise<void> {
        try {
            const config = await discoverAndValidateOIDCIssuerWellKnown(issuer);

            const scope = generateScope(deviceId);

            this.oidcClient = new OidcClient({
                ...config.metadata,
                client_id: clientId,
                scope,
                redirect_uri: redirectUri,
                authority: config.metadata.issuer,
                stateStore: new WebStorageStateStore({ prefix: "mx_oidc_", store: window.sessionStorage }),
            });
        } catch (error) {
            logger.error("Failed to initialise OIDC client.", error);
            throw new Error("Failed to initialise OIDC client.");
        }
    }

    /**
     * Attempt token refresh using given refresh token
     * @param refreshToken - refresh token to use in request with token issuer
     * @returns tokens - Promise that resolves with new access and refresh tokens
     * @throws when token refresh fails
     */
    public async doRefreshAccessToken(refreshToken: string): Promise<AccessTokens> {
        if (!this.inflightRefreshRequest) {
            this.inflightRefreshRequest = this.getNewTokens(refreshToken);
        }
        try {
            const tokens = await this.inflightRefreshRequest;
            return tokens;
        } finally {
            this.inflightRefreshRequest = undefined;
        }
    }

    /**
     * Persist the new tokens, called after tokens are successfully refreshed.
     *
     * This function is intended to be overriden by the consumer when persistence is necessary.
     *
     * @param tokens.accessToken - new access token
     * @param tokens.refreshToken - OPTIONAL new refresh token
     */
    public async persistTokens(tokens: { accessToken: string; refreshToken?: string }): Promise<void> {
        // NOOP
    }

    private async getNewTokens(refreshToken: string): Promise<AccessTokens> {
        if (!this.oidcClient) {
            throw new Error("Cannot get new token before OIDC client is initialised.");
        }

        const refreshTokenState = {
            refresh_token: refreshToken,
            session_state: "test",
            data: undefined,
            profile: this.idTokenClaims,
        };

        const response = await this.oidcClient.useRefreshToken({
            state: refreshTokenState,
            timeoutInSeconds: 300,
        });

        const tokens = {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
        };

        await this.persistTokens(tokens);

        return tokens;
    }
}
