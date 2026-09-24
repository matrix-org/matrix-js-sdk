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

/**
 * Produce a version of the given URL which is safe to write to logs, by redacting the values of any query parameters,
 * as they may contain secrets.
 *
 * @internal
 * @param url - the URL to sanitize.
 * @returns the sanitized URL, or `"??"` if the URL could not be parsed.
 */
export function sanitizeUrlForLogs(url: URL | string): string {
    try {
        let asUrl: URL;
        if (typeof url === "string") {
            asUrl = new URL(url);
        } else {
            asUrl = url;
        }
        // Remove the values of any URL params that could contain potential secrets
        const sanitizedQs = new URLSearchParams();
        for (const key of asUrl.searchParams.keys()) {
            sanitizedQs.append(key, "xxx");
        }
        const sanitizedQsString = sanitizedQs.toString();
        const sanitizedQsUrlPiece = sanitizedQsString ? `?${sanitizedQsString}` : "";

        return asUrl.origin + asUrl.pathname + sanitizedQsUrlPiece;
    } catch {
        // defensive coding for malformed url
        return "??";
    }
}
