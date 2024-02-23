/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { ConnectionError } from "./http-api";

/**
 * Retries events up to 4 times (so 5 including initial call) using exponential backoff.
 * This produces wait times of 2, 4, 8, and 16 seconds (30s total) after which we give up. If the
 * failure was due to a rate limited request, the time specified in the error is returned.
 *
 * Returns -1 if the error is not retryable, or if we reach the maximum number of attempts.
 *
 * @param err - The error thrown by the http call
 * @param attempts - The current number of attempts
 * @param retryConnectionError - Whether to retry on {@link ConnectionError} (CORS, connection is down, etc.)
 */
export function calculateRetryBackoff(err: any, attempts: number, retryConnectionError: boolean = false): number {
    if (attempts > 4) {
        return -1; // give up
    }

    if (err instanceof ConnectionError && !retryConnectionError) {
        return -1;
    }

    if (err.httpStatus && (err.httpStatus === 400 || err.httpStatus === 403 || err.httpStatus === 401)) {
        // client error; no amount of retrying with save you now.
        return -1;
    }

    if (err.name === "AbortError") {
        // this is a client timeout, that is already very high 60s/80s
        // we don't want to retry, as it could do it for very long
        return -1;
    }

    // if event that we are trying to send is too large in any way then retrying won't help
    if (err.name === "M_TOO_LARGE") {
        return -1;
    }

    if (err.name === "M_LIMIT_EXCEEDED") {
        const waitTime = err.data.retry_after_ms;
        if (waitTime > 0) {
            return waitTime;
        }
    }

    return 1000 * Math.pow(2, attempts);
}
