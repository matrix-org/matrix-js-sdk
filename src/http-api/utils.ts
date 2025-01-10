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

import { parse as parseContentType, type ParsedMediaType } from "content-type";

import { logger } from "../logger.ts";
import { sleep } from "../utils.ts";
import { ConnectionError, HTTPError, MatrixError, safeGetRetryAfterMs } from "./errors.ts";

// Ponyfill for https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout
export function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => {
        controller.abort();
    }, ms);

    return controller.signal;
}

export function anySignal(signals: AbortSignal[]): {
    signal: AbortSignal;
    cleanup(): void;
} {
    const controller = new AbortController();

    function cleanup(): void {
        for (const signal of signals) {
            signal.removeEventListener("abort", onAbort);
        }
    }

    function onAbort(): void {
        controller.abort();
        cleanup();
    }

    for (const signal of signals) {
        if (signal.aborted) {
            onAbort();
            break;
        }
        signal.addEventListener("abort", onAbort);
    }

    return {
        signal: controller.signal,
        cleanup,
    };
}

/**
 * Attempt to turn an HTTP error response into a Javascript Error.
 *
 * If it is a JSON response, we will parse it into a MatrixError. Otherwise
 * we return a generic Error.
 *
 * @param response - response object
 * @param body - raw body of the response
 * @returns
 */
export function parseErrorResponse(response: XMLHttpRequest | Response, body?: string): Error {
    const httpHeaders = isXhr(response)
        ? new Headers(
              response
                  .getAllResponseHeaders()
                  .trim()
                  .split(/[\r\n]+/)
                  .map((header): [string, string] => {
                      const colonIdx = header.indexOf(":");
                      return [header.substring(0, colonIdx), header.substring(colonIdx + 1)];
                  }),
          )
        : response.headers;

    let contentType: ParsedMediaType | null;
    try {
        contentType = getResponseContentType(httpHeaders);
    } catch (e) {
        return <Error>e;
    }
    if (contentType?.type === "application/json" && body) {
        return new MatrixError(
            JSON.parse(body),
            response.status,
            isXhr(response) ? response.responseURL : response.url,
            undefined,
            httpHeaders,
        );
    }
    if (contentType?.type === "text/plain") {
        return new HTTPError(`Server returned ${response.status} error: ${body}`, response.status, httpHeaders);
    }
    return new HTTPError(`Server returned ${response.status} error`, response.status, httpHeaders);
}

function isXhr(response: XMLHttpRequest | Response): response is XMLHttpRequest {
    return "getResponseHeader" in response;
}

/**
 * extract the Content-Type header from response headers, and
 * parse it to a `{type, parameters}` object.
 *
 * returns null if no content-type header could be found.
 *
 * @param response - response object
 * @returns parsed content-type header, or null if not found
 */
function getResponseContentType(headers: Headers): ParsedMediaType | null {
    const contentType = headers.get("Content-Type");
    if (contentType === null) return null;

    try {
        return parseContentType(contentType);
    } catch (e) {
        throw new Error(`Error parsing Content-Type '${contentType}': ${e}`);
    }
}

/**
 * Retries a network operation run in a callback.
 * @param maxAttempts - maximum attempts to try
 * @param callback - callback that returns a promise of the network operation. If rejected with ConnectionError, it will be retried by calling the callback again.
 * @returns the result of the network operation
 * @throws {@link ConnectionError} If after maxAttempts the callback still throws ConnectionError
 */
export async function retryNetworkOperation<T>(maxAttempts: number, callback: () => Promise<T>): Promise<T> {
    let attempts = 0;
    let lastConnectionError: ConnectionError | null = null;
    while (attempts < maxAttempts) {
        try {
            if (attempts > 0) {
                const timeout = 1000 * Math.pow(2, attempts);
                logger.log(`network operation failed ${attempts} times, retrying in ${timeout}ms...`);
                await sleep(timeout);
            }
            return await callback();
        } catch (err) {
            if (err instanceof ConnectionError) {
                attempts += 1;
                lastConnectionError = err;
            } else {
                throw err;
            }
        }
    }
    throw lastConnectionError;
}

/**
 * Calculate the backoff time for a request retry attempt.
 * This produces wait times of 2, 4, 8, and 16 seconds (30s total) after which we give up. If the
 * failure was due to a rate limited request, the time specified in the error is returned.
 *
 * Returns -1 if the error is not retryable, or if we reach the maximum number of attempts.
 *
 * @param err - The error thrown by the http call
 * @param attempts - The number of attempts made so far, including the one that just failed.
 * @param retryConnectionError - Whether to retry on {@link ConnectionError} (CORS, connection is down, etc.)
 */
export function calculateRetryBackoff(err: any, attempts: number, retryConnectionError: boolean): number {
    if (attempts > 4) {
        return -1; // give up
    }

    if (err instanceof ConnectionError && !retryConnectionError) {
        return -1;
    }

    if (err.httpStatus && Math.floor(err.httpStatus / 100) === 4 && err.httpStatus !== 429) {
        // client error; no amount of retrying will save you now (except for rate limiting which is handled below)
        return -1;
    }

    if (err.name === "AbortError") {
        // this is a client timeout, that is already very high 60s/80s
        // we don't want to retry, as it could do it for very long
        return -1;
    }

    // If we are trying to send an event (or similar) that is too large in any way, then retrying won't help
    if (err.name === "M_TOO_LARGE") {
        return -1;
    }

    return safeGetRetryAfterMs(err, 1000 * Math.pow(2, attempts));
}
