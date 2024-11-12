/*
Copyright 2015 - 2024 The Matrix.org Foundation C.I.C.

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

// Validation based on https://spec.matrix.org/v1.12/appendices/#server-name
// We do not use the validation described in https://spec.matrix.org/v1.12/client-server-api/#security-considerations-5
// as it'd wrongly make all MXCs invalid due to not allowing `[].:` in server names.
const serverNameRegex =
    /^(?:(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:\[[\dA-Fa-f:.]{2,45}])|(?:[A-Za-z\d\-.]{1,255}))(?::\d{1,5})?$/;
function validateServerName(serverName: string): boolean {
    const matches = serverNameRegex.exec(serverName);
    return matches?.[0] === serverName;
}

// Validation based on https://spec.matrix.org/v1.12/client-server-api/#security-considerations-5
const mediaIdRegex = /^[\w-]+$/;
function validateMediaId(mediaId: string): boolean {
    const matches = mediaIdRegex.exec(mediaId);
    return matches?.[0] === mediaId;
}

/**
 * Get the HTTP URL for an MXC URI.
 * @param baseUrl - The base homeserver url which has a content repo.
 * @param mxc - The mxc:// URI.
 * @param width - The desired width of the thumbnail.
 * @param height - The desired height of the thumbnail.
 * @param resizeMethod - The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param allowDirectLinks - If true, return any non-mxc URLs
 * directly. Fetching such URLs will leak information about the user to
 * anyone they share a room with. If false, will return the emptry string
 * for such URLs.
 * @param allowRedirects - If true, the caller supports the URL being 307 or
 * 308 redirected to another resource upon request. If false, redirects
 * are not expected. Implied `true` when `useAuthentication` is `true`.
 * @param useAuthentication - If true, the caller supports authenticated
 * media and wants an authentication-required URL. Note that server support
 * for authenticated media will *not* be checked - it is the caller's responsibility
 * to do so before calling this function. Note also that `useAuthentication`
 * implies `allowRedirects`. Defaults to false (unauthenticated endpoints).
 * @returns The complete URL to the content, may be an empty string if the provided mxc is not valid.
 */
export function getHttpUriForMxc(
    baseUrl: string,
    mxc?: string,
    width?: number,
    height?: number,
    resizeMethod?: string,
    allowDirectLinks = false,
    allowRedirects?: boolean,
    useAuthentication?: boolean,
): string {
    if (typeof mxc !== "string" || !mxc) {
        return "";
    }
    if (!mxc.startsWith("mxc://")) {
        if (allowDirectLinks) {
            return mxc;
        } else {
            return "";
        }
    }

    const [serverName, mediaId, ...rest] = mxc.slice(6).split("/");
    if (rest.length > 0 || !validateServerName(serverName) || !validateMediaId(mediaId)) {
        return "";
    }

    if (useAuthentication) {
        allowRedirects = true; // per docs (MSC3916 always expects redirects)

        // Dev note: MSC3916 removes `allow_redirect` entirely, but
        // for explicitness we set it here. This makes it slightly more obvious to
        // callers, hopefully.
    }

    let prefix: string;
    const isThumbnailRequest = !!width || !!height || !!resizeMethod;
    const verb = isThumbnailRequest ? "thumbnail" : "download";
    if (useAuthentication) {
        prefix = `/_matrix/client/v1/media/${verb}`;
    } else {
        prefix = `/_matrix/media/v3/${verb}`;
    }

    const url = new URL(`${prefix}/${serverName}/${mediaId}`, baseUrl);

    if (width) {
        url.searchParams.set("width", Math.round(width).toString());
    }
    if (height) {
        url.searchParams.set("height", Math.round(height).toString());
    }
    if (resizeMethod) {
        url.searchParams.set("method", resizeMethod);
    }

    if (typeof allowRedirects === "boolean") {
        // We add this after, so we don't convert everything to a thumbnail request.
        url.searchParams.set("allow_redirect", JSON.stringify(allowRedirects));
    }

    return url.href;
}
