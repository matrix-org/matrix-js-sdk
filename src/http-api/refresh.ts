/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import { ConnectionError, MatrixError, TokenRefreshLogoutError } from "./errors.ts";
import { type AccessTokens, type IHttpOpts, type OAuth2ClientConfig } from "./interface.ts";
import { sleep } from "../utils.ts";
import { TokenRefresher } from "../oauth/tokenRefresher.ts";
import { OAuth2 } from "../oauth/index.ts";

/**
 * This is an internal module. See {@link MatrixHttpApi} for the public class.
 */

export const enum TokenRefreshOutcome {
    Success = "success",
    Failure = "failure",
    Logout = "logout",
}

// If the token expires in less than this time amount of time, we will eagerly refresh it before making the intended request.
const REFRESH_IF_TOKEN_EXPIRES_WITHIN_MS = 500;
// If we get an unknown token error and the token expires in less than this time amount of time, we will refresh it before making the intended request.
// Otherwise, we will error as the token should not have expired yet and we need to avoid retrying indefinitely.
const REFRESH_ON_ERROR_IF_TOKEN_EXPIRES_WITHIN_MS = 60 * 1000;

// How many times to retry discovering the OAuth2 auth server metadata if it fails due to a connectivity
// problem, e.g. if the client starts up with no network connection at all.
const MAX_AUTH_METADATA_DISCOVERY_ATTEMPTS = 5;

type Opts = Pick<IHttpOpts, "onTokenRefresh" | "logger" | "refreshToken" | "accessToken" | "oauth2ClientConfig">;

/**
 * This class is responsible for managing the access token and refresh token for authenticated requests.
 * It will automatically refresh the tokens when the access token is about to expire and can handle
 * Unknown Token errors (via @{link handleUnknownToken})
 *
 * It will update the @{link opts} object with new tokens as they are refreshed, and also call the onTokenRefresh callback if provided.
 */
export class TokenManager {
    public constructor(private readonly opts: Opts) {}

    /**
     * Promise used to block authenticated requests during a token refresh to avoid repeated expected errors.
     * @private
     */
    private tokenRefreshPromise?: Promise<TokenRefreshOutcome>;

    private latestTokenRefreshExpiry?: Date;

    // The object at the OAuth API layer that actually does the refreshing
    // This needs OAuth params to be fetched before it can be constructed so it starts
    // off as undefined and is constructed once we are able to do so.
    private tokenRefresher?: TokenRefresher;

    // Tracks an in-progress attempt to discover the OAuth2 auth server metadata and construct
    // `tokenRefresher`, so that concurrent callers wait for (and share the result of) the same attempt
    // rather than racing to discover it independently.
    private tokenRefresherPromise?: Promise<TokenRefresher>;

    /**
     * This function is called before every request to ensure that the access token is valid.
     * @returns a snapshot containing the access token and other properties which must be passed to the handleUnknownToken
     *     handler if an M_UNKNOWN_TOKEN error is encountered.
     */
    public async prepareForRequest(): Promise<AccessTokens> {
        // Ensure our token is refreshed before we build the headers/params
        await this.refreshIfNeeded();

        return {
            accessToken: this.opts.accessToken!,
            refreshToken: this.opts.refreshToken,
            expiry: this.latestTokenRefreshExpiry,
        };
    }

    private async refreshIfNeeded(): Promise<unknown> {
        if (this.tokenRefreshPromise) {
            return this.tokenRefreshPromise;
        }
        // If we don't know the token expiry, we can't eagerly refresh
        if (!this.latestTokenRefreshExpiry) return;

        const expiresIn = this.latestTokenRefreshExpiry.getTime() - Date.now();
        if (expiresIn <= REFRESH_IF_TOKEN_EXPIRES_WITHIN_MS) {
            await this._handleUnknownToken();
        }
    }

    /**
     * This function is called when an M_UNKNOWN_TOKEN error is encountered.
     * It will attempt to refresh the access token if it is unknown, and will return a TokenRefreshOutcome.
     * @param snapshot - the snapshot returned by prepareForRequest
     * @param attempt - the number of attempts made for this request so far
     * @returns a TokenRefreshOutcome indicating the result of the refresh attempt
     */
    public async handleUnknownToken(snapshot: AccessTokens, attempt: number): Promise<TokenRefreshOutcome> {
        return this._handleUnknownToken(snapshot, attempt);
    }

    private async _handleUnknownToken(): Promise<TokenRefreshOutcome>;
    private async _handleUnknownToken(snapshot: AccessTokens, attempt: number): Promise<TokenRefreshOutcome>;
    private async _handleUnknownToken(snapshot?: AccessTokens, attempt?: number): Promise<TokenRefreshOutcome> {
        if (snapshot?.expiry) {
            // If our token is unknown, but it should not have expired yet, then we should not refresh
            const expiresIn = snapshot.expiry.getTime() - Date.now();
            // If it still has plenty of time left on the clock, we assume something else must be wrong and
            // do not refresh. Otherwise if it's expired, or will soon, we try refreshing.
            if (expiresIn >= REFRESH_ON_ERROR_IF_TOKEN_EXPIRES_WITHIN_MS) {
                return TokenRefreshOutcome.Logout;
            }
        }

        if (!snapshot || snapshot?.accessToken === this.opts.accessToken) {
            // If we have a snapshot, but the access token is the same as the current one then a refresh
            // did not happen behind us but one may be ongoing anyway
            this.tokenRefreshPromise ??= this.doTokenRefresh(attempt);

            try {
                return await this.tokenRefreshPromise;
            } finally {
                this.tokenRefreshPromise = undefined;
            }
        }

        // We may end up here if the token was refreshed in the background due to another request
        return TokenRefreshOutcome.Success;
    }

    /**
     * Attempt to refresh access tokens.
     * On success, sets new access and refresh tokens in opts.
     * @returns Promise that resolves to a boolean - true when token was refreshed successfully
     */
    private async doTokenRefresh(attempt?: number): Promise<TokenRefreshOutcome> {
        if (!this.opts.refreshToken || !this.opts.oauth2ClientConfig) {
            this.opts.logger?.error("Unable to refresh token - no refresh token or OAuth2 client config");
            return TokenRefreshOutcome.Logout;
        }

        if (attempt && attempt > 1) {
            // Exponential backoff to ensure we don't trash the server, up to 2^5 seconds
            await sleep(1000 * Math.min(32, 2 ** attempt));
        }

        try {
            this.opts.logger?.debug("Attempting to refresh token");
            const tokenRefresher = await this.ensureTokenRefresher();
            if (!tokenRefresher) {
                // We already checked `oauth2ClientConfig` is set above, so this should be unreachable.
                return TokenRefreshOutcome.Logout;
            }

            const { accessToken, refreshToken, expiry } = await tokenRefresher.doRefresh(this.opts.refreshToken);
            this.opts.accessToken = accessToken;
            this.opts.refreshToken = refreshToken;
            this.latestTokenRefreshExpiry = expiry;
            this.opts.logger?.debug("... token refresh complete, new token expiry:", expiry);

            // successfully got new tokens
            return TokenRefreshOutcome.Success;
        } catch (error) {
            // If we get a TokenError or MatrixError, we should log out, otherwise assume transient
            if (error instanceof TokenRefreshLogoutError || error instanceof MatrixError) {
                this.opts.logger?.error("Failed to refresh token", error);
                return TokenRefreshOutcome.Logout;
            }

            this.opts.logger?.warn("Failed to refresh token", error);
            return TokenRefreshOutcome.Failure;
        }
    }

    /**
     * Attempt to revoke the current access and refresh tokens with the OAuth2 authorization server, e.g. as
     * part of logging out. Does nothing if this is not an OAuth2-native session (ie. no `oauth2ClientConfig`
     * was supplied).
     * @throws when discovery of the auth server metadata, or revocation of either token, fails
     */
    public async revokeTokens(): Promise<void> {
        const tokenRefresher = await this.ensureTokenRefresher();
        if (!tokenRefresher) return;

        await Promise.all(
            [
                this.opts.accessToken ? tokenRefresher.revokeToken(this.opts.accessToken, "access_token") : undefined,
                this.opts.refreshToken
                    ? tokenRefresher.revokeToken(this.opts.refreshToken, "refresh_token")
                    : undefined,
            ].filter((p): p is Promise<void> => p !== undefined),
        );
    }

    /**
     * Lazily constructs (and caches) the {@link TokenRefresher} used to talk to the OAuth2 authorization
     * server, discovering its metadata first if this is the first time it's needed.
     * @returns the token refresher, or undefined if no `oauth2ClientConfig` was supplied
     * @throws when discovery of the auth server metadata fails in a way that isn't worth retrying
     */
    private async ensureTokenRefresher(): Promise<TokenRefresher | undefined> {
        if (this.tokenRefresher) return this.tokenRefresher;
        if (!this.opts.oauth2ClientConfig) return undefined;

        if (!this.tokenRefresherPromise) {
            this.tokenRefresherPromise = this.discoverTokenRefresher(this.opts.oauth2ClientConfig);
        }

        try {
            this.tokenRefresher = await this.tokenRefresherPromise;
            return this.tokenRefresher;
        } finally {
            // Either we now have `tokenRefresher` cached and won't need this again, or discovery
            // failed and a future call should be free to retry from scratch.
            this.tokenRefresherPromise = undefined;
        }
    }

    /**
     * Discovers the OAuth2 auth server metadata and constructs the OAuth2 client and token refresher from it.
     * Throws if the request fails.
     */
    private async discoverTokenRefresher(config: OAuth2ClientConfig, attempt: number = 1): Promise<TokenRefresher> {
        const metadata = await config.getAuthMetadata();

        const oauth2 = new OAuth2(metadata, {
            clientId: config.clientId,
            redirectUri: config.redirectUri,
            deviceId: config.deviceId,
        });

        return new TokenRefresher(oauth2, (tokens) => this.opts.onTokenRefresh?.(tokens));
    }
}
