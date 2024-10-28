/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { IUsageLimit } from "../@types/partials.ts";
import { MatrixEvent } from "../models/event.ts";
import { parseRetryAfterMs } from "./utils.ts";

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

    /**
     * @returns whether this error is due to rate-limiting.
     */
    public isRateLimitError(): boolean {
        return this.errcode === "M_LIMIT_EXCEEDED" || (this.errcode === "M_UNKNOWN" && this.httpStatus === 429);
    }

    /**
     * @returns the recommended delay in milliseconds to wait before retrying
     * the request that triggered this error, or null if no delay is recommended.
     */
    public getRetryAfterMs(): number | null {
        if (this.httpStatus === 429) {
            const retryAfter = this.httpHeaders?.get("Retry-After");
            if (retryAfter != null) {
                return parseRetryAfterMs(retryAfter);
            }
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
