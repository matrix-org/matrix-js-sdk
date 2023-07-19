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

import { OidcClient, SigninResponse, UseRefreshTokenArgs, WebStorageStateStore } from "oidc-client-ts";
import { IDelegatedAuthConfig } from "../client";
import { MatrixClient } from "../client";

import { generateScope } from "./authorize";
import { discoverAndValidateAuthenticationConfig } from "./discovery";

export class OidcTokenRefresher {
    private oidcClient!: OidcClient;

    constructor(
        private refreshToken: string,
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

    public async doRefreshAccessToken (): Promise<string> {
        // @TODO something here with only one inflight refresh attempt
        return this.getNewToken();
    }

    private async getNewToken(): Promise<string> {
        if (!this.oidcClient) {
            throw new Error("No client TODO")
        }

        const refreshTokenState = {
            refresh_token: this.refreshToken,
            session_state: 'test',
            data: undefined,
        }
        const response = await this.oidcClient.useRefreshToken({
            state: refreshTokenState, timeoutInSeconds: 300 });

        this.refreshToken = response.refresh_token;
        this.expiresAt = response.expires_at;

        // TODO persist tokens in storage
        console.log('hhhh doRefreshAccessToken', response);

        return response.access_token;
    }
}