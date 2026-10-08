/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { sanitizeUrlForLogs } from "../http-api/logging.ts";
import { Method } from "../http-api/method.ts";
import { type Logger } from "../logger.ts";

/**
 * Perform a `fetch` request, logging the request and response in the same manner as
 * `FetchHttpApi` does for Client-Server API requests.
 *
 * Neither the request nor the response body is logged, as they routinely contain credentials.
 * Query parameter values are redacted for the same reason.
 *
 * @internal
 * @param logger - the logger to write the request and response lines to.
 * @param resource - the URL to request.
 * @param options - the options to pass to `fetch`.
 * @returns the `Response`, whatever its status code.
 * @throws rethrows whatever `fetch` threw, having logged it.
 */
export async function fetchWithLogging(
    logger: Logger,
    resource: URL | string,
    options: RequestInit = {},
): Promise<Response> {
    const method = options.method ?? Method.Get;
    const urlForLogs = sanitizeUrlForLogs(resource);

    logger.debug(`OAuth2: --> ${method} ${urlForLogs}`);

    const start = Date.now();
    try {
        const res = await globalThis.fetch(resource, options);
        logger.debug(`OAuth2: <-- ${method} ${urlForLogs} [${Date.now() - start}ms ${res.status}]`);
        return res;
    } catch (e) {
        logger.debug(`OAuth2: <-- ${method} ${urlForLogs} [${Date.now() - start}ms ${e}]`);
        throw e;
    }
}
