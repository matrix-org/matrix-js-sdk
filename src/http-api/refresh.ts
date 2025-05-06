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

import { MatrixError, TokenRefreshLogoutError } from "./errors.ts";
import { type IHttpOpts } from "./interface.ts";
import { sleep } from "../utils.ts";

/**
 * This is an internal module. See {@link MatrixHttpApi} for the public class.
 */

export const enum TokenRefreshOutcome {
    Success = "success",
    Failure = "failure",
    Logout = "logout",
}

interface Snapshot {
    accessToken: string;
    refreshToken?: string;
    expiry?: Date;
}

// If the token expires in less than this time amount of time, we will eagerly refresh it before making the intended request.
const REFRESH_IF_TOKEN_EXPIRES_WITHIN_MS = 500;
// If we get an unknown token error and the token expires in less than this time amount of time, we will refresh it before making the intended request.
// Otherwise, we will error as the token should not have expired yet and we need to avoid retrying indefinitely.
const REFRESH_ON_ERROR_IF_TOKEN_EXPIRES_WITHIN_MS = 60 * 1000;

type Opts = Pick<IHttpOpts, "tokenRefreshFunction" | "logger" | "refreshToken" | "accessToken">;

/**
 * This class is responsible for managing the access token and refresh token for authenticated requests.
 * It will automatically refresh the access token when it is about to expire, and will handle unknown token errors.
 */
export class TokenRefresher {
    public constructor(private readonly opts: Opts) {}

    /**
     * Promise used to block authenticated requests during a token refresh to avoid repeated expected errors.
     * @private
     */
    private tokenRefreshPromise?: Promise<TokenRefreshOutcome>;

    private latestTokenRefreshExpiry?: Date;

    /**
     * This function is called before every request to ensure that the access token is valid.
     * @returns a snapshot containing the access token and other properties which must be passed to the handleUnknownToken
     *     handler if an M_UNKNOWN_TOKEN error is encountered.
     */
    public async prepareForRequest(): Promise<Snapshot> {
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
    public async handleUnknownToken(snapshot: Snapshot, attempt: number): Promise<TokenRefreshOutcome> {
        return this._handleUnknownToken(snapshot, attempt);
    }

    /* eslint-disable @typescript-eslint/naming-convention */
    private async _handleUnknownToken(): Promise<TokenRefreshOutcome>;
    private async _handleUnknownToken(snapshot: Snapshot, attempt: number): Promise<TokenRefreshOutcome>;
    private async _handleUnknownToken(snapshot?: Snapshot, attempt?: number): Promise<TokenRefreshOutcome> {
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
        if (!this.opts.refreshToken || !this.opts.tokenRefreshFunction) {
            this.opts.logger?.error("Unable to refresh token - no refresh token or refresh function");
            return TokenRefreshOutcome.Logout;
        }

        if (attempt && attempt > 1) {
            // Exponential backoff to ensure we don't trash the server, up to 2^5 seconds
            await sleep(1000 * Math.min(32, 2 ** attempt));
        }

        try {
            this.opts.logger?.debug("Attempting to refresh token");
            const { accessToken, refreshToken, expiry } = await this.opts.tokenRefreshFunction(this.opts.refreshToken);
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
}
