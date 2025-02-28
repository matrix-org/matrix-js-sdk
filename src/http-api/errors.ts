/*
Copyright 2022 - 2024 The Matrix.org Foundation C.I.C.

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

import { type IMatrixApiError as IWidgetMatrixError } from "matrix-widget-api";

import { type IUsageLimit } from "../@types/partials.ts";
import { type MatrixEvent } from "../models/event.ts";

interface IErrorJson extends Partial<IUsageLimit> {
    [key: string]: any; // extensible
    errcode?: string;
    error?: string;
}

/**
 * Construct a generic HTTP error. This is a JavaScript Error with additional information
 * specific to HTTP responses.
 * @param msg - The error message to include.
 * @param httpStatus - The HTTP response status code.
 * @param httpHeaders - The HTTP response headers.
 */
export class HTTPError extends Error {
    public constructor(
        msg: string,
        public readonly httpStatus?: number,
        public readonly httpHeaders?: Headers,
    ) {
        super(msg);
    }

    /**
     * Check if this error was due to rate-limiting on the server side (and should therefore be retried after a delay).
     *
     * If this returns `true`, {@link getRetryAfterMs} can be called to retrieve the server-side
     * recommendation for the retry period.
     *
     * @returns Whether this error is due to rate-limiting.
     */
    public isRateLimitError(): boolean {
        return this.httpStatus === 429;
    }

    /**
     * @returns The recommended delay in milliseconds to wait before retrying
     * the request that triggered this error, or null if no delay is recommended.
     * @throws Error if the recommended delay is an invalid value.
     * @see {@link safeGetRetryAfterMs} for a version of this check that doesn't throw.
     */
    public getRetryAfterMs(): number | null {
        const retryAfter = this.httpHeaders?.get("Retry-After");
        if (retryAfter != null) {
            if (/^\d+$/.test(retryAfter)) {
                const ms = Number.parseInt(retryAfter) * 1000;
                if (!Number.isFinite(ms)) {
                    throw new Error("Retry-After header integer value is too large");
                }
                return ms;
            }
            const date = new Date(retryAfter);
            if (date.toUTCString() !== retryAfter) {
                throw new Error("Retry-After header value is not a valid HTTP-date or non-negative decimal integer");
            }
            return date.getTime() - Date.now();
        }
        return null;
    }
}

export class MatrixError extends HTTPError {
    // The Matrix 'errcode' value, e.g. "M_FORBIDDEN".
    public readonly errcode?: string;
    // The raw Matrix error JSON used to construct this object.
    public data: IErrorJson;

    /**
     * Construct a Matrix error. This is a JavaScript Error with additional
     * information specific to the standard Matrix error response.
     * @param errorJson - The Matrix error JSON returned from the homeserver.
     * @param httpStatus - The numeric HTTP status code given
     * @param httpHeaders - The HTTP response headers given
     */
    public constructor(
        errorJson: IErrorJson = {},
        httpStatus?: number,
        public url?: string,
        public event?: MatrixEvent,
        httpHeaders?: Headers,
    ) {
        let message = errorJson.error || "Unknown message";
        if (httpStatus) {
            message = `[${httpStatus}] ${message}`;
        }
        if (url) {
            message = `${message} (${url})`;
        }
        super(`MatrixError: ${message}`, httpStatus, httpHeaders);
        this.errcode = errorJson.errcode;
        this.name = errorJson.errcode || "Unknown error code";
        this.data = errorJson;
    }

    public isRateLimitError(): boolean {
        return (
            this.errcode === "M_LIMIT_EXCEEDED" ||
            ((this.errcode === "M_UNKNOWN" || this.errcode === undefined) && super.isRateLimitError())
        );
    }

    public getRetryAfterMs(): number | null {
        const headerValue = super.getRetryAfterMs();
        if (headerValue !== null) {
            return headerValue;
        }
        // Note: retry_after_ms is deprecated as of spec version v1.10
        if (this.errcode === "M_LIMIT_EXCEEDED" && "retry_after_ms" in this.data) {
            if (!Number.isInteger(this.data.retry_after_ms)) {
                throw new Error("retry_after_ms is not an integer");
            }
            return this.data.retry_after_ms;
        }
        return null;
    }

    /**
     * @returns this error expressed as a JSON payload
     * for use by Widget API error responses.
     */
    public asWidgetApiErrorData(): IWidgetMatrixError {
        const headers: Record<string, string> = {};
        if (this.httpHeaders) {
            for (const [name, value] of this.httpHeaders) {
                headers[name] = value;
            }
        }
        return {
            http_status: this.httpStatus ?? 400,
            http_headers: headers,
            url: this.url ?? "",
            response: {
                errcode: this.errcode ?? "M_UNKNOWN",
                error: this.data.error ?? "Unknown message",
                ...this.data,
            },
        };
    }

    /**
     * @returns a new {@link MatrixError} from a JSON payload
     * received from Widget API error responses.
     */
    public static fromWidgetApiErrorData(data: IWidgetMatrixError): MatrixError {
        return new MatrixError(data.response, data.http_status, data.url, undefined, new Headers(data.http_headers));
    }
}

/**
 * @returns The recommended delay in milliseconds to wait before retrying the request.
 * @param error - The error to check for a retry delay.
 * @param defaultMs - The delay to use if the error was not due to rate-limiting or if no valid delay is recommended.
 */
export function safeGetRetryAfterMs(error: unknown, defaultMs: number): number {
    if (!(error instanceof HTTPError) || !error.isRateLimitError()) {
        return defaultMs;
    }
    try {
        return error.getRetryAfterMs() ?? defaultMs;
    } catch {
        return defaultMs;
    }
}

/**
 * Construct a ConnectionError. This is a JavaScript Error indicating
 * that a request failed because of some error with the connection, either
 * CORS was not correctly configured on the server, the server didn't response,
 * the request timed out, or the internet connection on the client side went down.
 */
export class ConnectionError extends Error {
    public constructor(message: string, cause?: Error) {
        super(message + (cause ? `: ${cause.message}` : ""));
    }

    public get name(): string {
        return "ConnectionError";
    }
}

/**
 * Construct a TokenRefreshError. This indicates that a request failed due to the token being expired,
 * and attempting to refresh said token also failed but in a way which was not indicative of token invalidation.
 * Assumed to be a temporary failure.
 */
export class TokenRefreshError extends Error {
    public constructor(cause?: Error) {
        super(cause?.message ?? "");
    }

    public get name(): string {
        return "TokenRefreshError";
    }
}
