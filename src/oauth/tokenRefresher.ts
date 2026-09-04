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

import { HTTPError, TokenRefreshLogoutError } from "../http-api/errors.ts";
import { type AccessTokens } from "../http-api/interface.ts";
import { OAuth2HTTPError } from "./error.ts";
import { type OAuth2 } from "./index.ts";

/**
 * Class responsible for refreshing OAuth2 access tokens
 */
export class TokenRefresher {
    private inflightRefreshRequest?: Promise<AccessTokens>;

    public constructor(
        private readonly auth: OAuth2,
        private readonly onRefresh: (tokens: AccessTokens) => void | Promise<void>,
    ) {}

    /**
     * Attempt token refresh using given refresh token
     * @param refreshToken - refresh token to use in request with token issuer
     * @throws when token refresh fails
     */
    public async refreshTokens(refreshToken: string): Promise<AccessTokens> {
        if (!this.inflightRefreshRequest) {
            this.inflightRefreshRequest = this.getNewTokens(refreshToken);
        }

        try {
            const tokens = await this.inflightRefreshRequest;
            return tokens;
        } catch (e) {
            // If we encounter a 40x error then signal that it should cause a logout by upgrading it to a TokenRefreshLogoutError
            if (e instanceof HTTPError && this.shouldLogoutOnError(e)) {
                throw new TokenRefreshLogoutError(e);
            }
            throw e;
        } finally {
            this.inflightRefreshRequest = undefined;
        }
    }

    /**
     * Revoke a token with the OP, e.g. as part of logging out.
     * @param token - the token to revoke
     * @param type - the type of token, acts as a hint to the OP
     * @throws when revocation fails
     */
    public async revokeToken(token: string, type?: "access_token" | "refresh_token"): Promise<void> {
        await this.auth.revokeToken(token, type);
    }

    private shouldLogoutOnError(error: HTTPError): boolean {
        // Treat as logout as per https://spec.matrix.org/v1.18/client-server-api/#refresh-token-grant
        // after making sure it is an RFC 6749 section 5.2 error response
        return (
            error instanceof OAuth2HTTPError &&
            typeof error.httpStatus === "number" &&
            error.httpStatus < 500 &&
            error.httpStatus >= 400
        );
    }

    private async getNewTokens(refreshToken: string): Promise<AccessTokens> {
        const requestStart = Date.now();

        const response = await this.auth.performRefreshTokenGrant(refreshToken);

        const tokens = {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            // We use the request start time to calculate the expiry time as we don't know when the server received our request
            expiry: response.expires_in ? new Date(requestStart + response.expires_in * 1000) : undefined,
        } satisfies AccessTokens;

        await this.onRefresh(tokens);

        return tokens;
    }
}
