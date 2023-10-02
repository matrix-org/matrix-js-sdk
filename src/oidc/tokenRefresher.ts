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

import { OidcClient, WebStorageStateStore } from "oidc-client-ts";
import { TokenRefreshFunction } from "..";
import { IDelegatedAuthConfig } from "../client";

import { generateScope } from "./authorize";
import { discoverAndValidateAuthenticationConfig } from "./discovery";

export abstract class OidcTokenRefresher {
    private oidcClient!: OidcClient;

    constructor(
        authConfig: IDelegatedAuthConfig,
        clientId: string,
        redirectUri: string,
        deviceId: string,
    ) {
        this.initialiseOidcClient(authConfig, clientId, deviceId, redirectUri);
    }

    private async initialiseOidcClient(authConfig: IDelegatedAuthConfig, clientId: string, deviceId: string, redirectUri: string): Promise<void> {
        const config = await discoverAndValidateAuthenticationConfig(authConfig);

        const scope = await generateScope(deviceId);

        this.oidcClient = new OidcClient({
            ...config.metadata,
            client_id: clientId,
            scope,
            redirect_uri: redirectUri,
            authority: config.metadata.issuer,
            // @TODO(kerrya) need this?
            stateStore: new WebStorageStateStore({ prefix: "mx_oidc_", store: window.sessionStorage }),
        });
    }

    public async doRefreshAccessToken (refreshToken: string): ReturnType<TokenRefreshFunction> {
        // @TODO something here with only one inflight refresh attempt
        const tokens = await this.getNewToken(refreshToken);

        // await this.persistTokens(tokens);

        return tokens;
    }

    /**
     * Persist the new tokens after successfully refreshing
     * @param accessToken new access token
     * @param refreshToken OPTIONAL new refresh token 
     */
    public abstract persistTokens({ accessToken, refreshToken }: {
        accessToken: string, refreshToken?: string
    }): Promise<void>;

    private async getNewToken(refreshToken: string): ReturnType<TokenRefreshFunction> {
        if (!this.oidcClient) {
            throw new Error("No client TODO")
        }

        const refreshTokenState = {
            refresh_token: refreshToken,
            session_state: 'test',
            data: undefined,
        }
        const response = await this.oidcClient.useRefreshToken({
            state: refreshTokenState, timeoutInSeconds: 300 });

        // TODO persist tokens in storage
        console.log('hhhh doRefreshAccessToken', response);

        return {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
        }
    }
}