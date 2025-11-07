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

/**
 * This is an internal module. See {@link MatrixHttpApi} for the public class.
 */

import { checkObjectHasKeys, deepCopy, encodeParams } from "../utils.ts";
import { type TypedEventEmitter } from "../models/typed-event-emitter.ts";
import { Method } from "./method.ts";
import { ConnectionError, MatrixError, TokenRefreshError } from "./errors.ts";
import {
    type BaseRequestOpts,
    HttpApiEvent,
    type HttpApiEventHandlerMap,
    type IHttpOpts,
    type IRequestOpts,
    type Body,
} from "./interface.ts";
import { anySignal, parseErrorResponse, timeoutSignal } from "./utils.ts";
import { type QueryDict } from "../utils.ts";
import { TokenRefresher, TokenRefreshOutcome } from "./refresh.ts";

export class FetchHttpApi<O extends IHttpOpts> {
    private abortController = new AbortController();
    private readonly tokenRefresher: TokenRefresher;

    public constructor(
        private eventEmitter: TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>,
        public readonly opts: O,
    ) {
        checkObjectHasKeys(opts, ["baseUrl", "prefix"]);
        if (!opts.onlyData) {
            throw new Error("Constructing FetchHttpApi without `onlyData=true` is no longer supported.");
        }
        opts.useAuthorizationHeader = opts.useAuthorizationHeader ?? true;

        this.tokenRefresher = new TokenRefresher(opts);
    }

    public abort(): void {
        this.abortController.abort();
        this.abortController = new AbortController();
    }

    public fetch(resource: URL | string, options?: RequestInit): ReturnType<typeof globalThis.fetch> {
        if (this.opts.fetchFn) {
            return this.opts.fetchFn(resource, options);
        }
        return globalThis.fetch(resource, options);
    }

    /**
     * Sets the base URL for the identity server
     * @param url - The new base url
     */
    public setIdBaseUrl(url?: string): void {
        this.opts.idBaseUrl = url;
    }

    public idServerRequest<T extends object = Record<string, unknown>>(
        method: Method,
        path: string,
        params: Record<string, string | string[]> | undefined,
        prefix: string,
        accessToken?: string,
    ): Promise<T> {
        if (!this.opts.idBaseUrl) {
            throw new Error("No identity server base URL set");
        }

        let queryParams: QueryDict | undefined = undefined;
        let body: Record<string, string | string[]> | undefined = undefined;
        if (method === Method.Get) {
            queryParams = params;
        } else {
            body = params;
        }

        const fullUri = this.getUrl(path, queryParams, prefix, this.opts.idBaseUrl);

        const opts: IRequestOpts = {
            json: true,
            headers: {},
        };
        if (accessToken) {
            opts.headers!.Authorization = `Bearer ${accessToken}`;
        }

        return this.requestOtherUrl(method, fullUri, body, opts);
    }

    /**
     * Perform an authorised request to the homeserver.
     * @param method - The HTTP method e.g. "GET".
     * @param path - The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     *
     * @param queryParams - A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param body - The HTTP JSON body.
     *
     * @param paramOpts - additional options.
     * When `paramOpts.doNotAttemptTokenRefresh` is true, token refresh will not be attempted
     * when an expired token is encountered. Used to only attempt token refresh once.
     *
     * @returns The parsed response.
     * @throws Error if a problem occurred. This includes network problems and Matrix-specific error JSON.
     */
    public authedRequest<T>(
        method: Method,
        path: string,
        queryParams: QueryDict = {},
        body?: Body,
        paramOpts: IRequestOpts = {},
    ): Promise<T> {
        return this.doAuthedRequest<T>(1, method, path, queryParams, body, paramOpts);
    }

    // Wrapper around public method authedRequest to allow for tracking retry attempt counts
    private async doAuthedRequest<T>(
        attempt: number,
        method: Method,
        path: string,
        queryParams: QueryDict,
        body?: Body,
        paramOpts: IRequestOpts = {},
    ): Promise<T> {
        // avoid mutating paramOpts so they can be used on retry
        const opts = deepCopy(paramOpts);
        // we have to manually copy the abortSignal over as it is not a plain object
        opts.abortSignal = paramOpts.abortSignal;

        // Take a snapshot of the current token state before we start the request so we can reference it if we error
        const requestSnapshot = await this.tokenRefresher.prepareForRequest();
        if (requestSnapshot.accessToken) {
            if (this.opts.useAuthorizationHeader) {
                if (!opts.headers) {
                    opts.headers = {};
                }
                if (!opts.headers.Authorization) {
                    opts.headers.Authorization = `Bearer ${requestSnapshot.accessToken}`;
                }
                if (queryParams.access_token) {
                    delete queryParams.access_token;
                }
            } else if (!queryParams.access_token) {
                queryParams.access_token = requestSnapshot.accessToken;
            }
        }

        try {
            const response = await this.request<T>(method, path, queryParams, body, opts);
            return response;
        } catch (error) {
            if (!(error instanceof MatrixError)) {
                throw error;
            }

            if (error.errcode === "M_UNKNOWN_TOKEN") {
                const outcome = await this.tokenRefresher.handleUnknownToken(requestSnapshot, attempt);
                if (outcome === TokenRefreshOutcome.Success) {
                    // if we got a new token retry the request
                    return this.doAuthedRequest(attempt + 1, method, path, queryParams, body, paramOpts);
                }
                if (outcome === TokenRefreshOutcome.Failure) {
                    throw new TokenRefreshError(error);
                }

                if (!opts?.inhibitLogoutEmit) {
                    this.eventEmitter.emit(HttpApiEvent.SessionLoggedOut, error);
                }
            } else if (error.errcode == "M_CONSENT_NOT_GIVEN") {
                this.eventEmitter.emit(HttpApiEvent.NoConsent, error.message, error.data.consent_uri);
            }

            throw error;
        }
    }

    /**
     * Perform a request to the homeserver without any credentials.
     * @param method - The HTTP method e.g. "GET".
     * @param path - The HTTP path <b>after</b> the supplied prefix e.g.
     * "/createRoom".
     *
     * @param queryParams - A dict of query params (these will NOT be
     * urlencoded). If unspecified, there will be no query params.
     *
     * @param body - The HTTP JSON body.
     *
     * @param opts - additional options
     *
     * @returns The parsed response.
     * @throws Error if a problem occurred. This includes network problems and Matrix-specific error JSON.
     */
    public request<T>(
        method: Method,
        path: string,
        queryParams?: QueryDict,
        body?: Body,
        opts?: IRequestOpts,
    ): Promise<T> {
        const fullUri = this.getUrl(path, queryParams, opts?.prefix, opts?.baseUrl);
        return this.requestOtherUrl<T>(method, fullUri, body, opts);
    }

    /**
     * Perform a request to an arbitrary URL.
     * @param method - The HTTP method e.g. "GET".
     * @param url - The HTTP URL object.
     *
     * @param body - The HTTP JSON body.
     *
     * @param opts - additional options
     *
     * @returns The parsed response.
     * @throws Error if a problem occurred. This includes network problems and Matrix-specific error JSON.
     */
    public async requestOtherUrl<T>(
        method: Method,
        url: URL | string,
        body?: Body,
        opts: BaseRequestOpts = {},
    ): Promise<T> {
        if (opts.json !== undefined && opts.rawResponseBody !== undefined) {
            throw new Error("Invalid call to `FetchHttpApi` sets both `opts.json` and `opts.rawResponseBody`");
        }

        const urlForLogs = this.sanitizeUrlForLogs(url);

        this.opts.logger?.debug(`FetchHttpApi: --> ${method} ${urlForLogs}`);

        const headers = Object.assign({}, opts.headers || {});

        const jsonResponse = !opts.rawResponseBody && opts.json !== false;
        if (jsonResponse) {
            if (!headers["Accept"]) {
                headers["Accept"] = "application/json";
            }
        }

        const timeout = opts.localTimeoutMs ?? this.opts.localTimeoutMs;
        const keepAlive = opts.keepAlive ?? false;
        const signals = [this.abortController.signal];
        if (timeout !== undefined) {
            signals.push(timeoutSignal(timeout));
        }
        if (opts.abortSignal) {
            signals.push(opts.abortSignal);
        }

        // If the body is an object, encode it as JSON and set the `Content-Type` header,
        // unless that has been explicitly inhibited by setting `opts.json: false`.
        // We can't use getPrototypeOf here as objects made in other contexts e.g. over postMessage won't have same ref
        let data: BodyInit;
        if (opts.json !== false && body?.constructor?.name === Object.name) {
            data = JSON.stringify(body);
            if (!headers["Content-Type"]) {
                headers["Content-Type"] = "application/json";
            }
        } else {
            data = body as BodyInit;
        }

        const { signal, cleanup } = anySignal(signals);

        // Set cache mode based on presence of Authorization header.
        // Browsers/proxies do not cache responses to requests with Authorization headers.
        // So specifying "no-cache" is redundant, and actually prevents caching
        // of preflight requests in CORS scenarios. As such, we only set "no-cache"
        // when there is no Authorization header.
        const cacheMode = "Authorization" in headers ? undefined : "no-cache";

        let res: Response;
        const start = Date.now();
        try {
            res = await this.fetch(url, {
                signal,
                method,
                body: data,
                headers,
                mode: "cors",
                redirect: "follow",
                referrer: "",
                referrerPolicy: "no-referrer",
                cache: cacheMode,
                credentials: "omit", // we send credentials via headers
                keepalive: keepAlive,
                priority: opts.priority,
            });

            this.opts.logger?.debug(
                `FetchHttpApi: <-- ${method} ${urlForLogs} [${Date.now() - start}ms ${res.status}]`,
            );
        } catch (e) {
            this.opts.logger?.debug(`FetchHttpApi: <-- ${method} ${urlForLogs} [${Date.now() - start}ms ${e}]`);
            if ((<Error>e).name === "AbortError") {
                throw e;
            }
            throw new ConnectionError("fetch failed", <Error>e);
        } finally {
            cleanup();
        }

        if (!res.ok) {
            throw parseErrorResponse(res, await res.text());
        }

        if (opts.rawResponseBody) {
            return (await res.blob()) as T;
        } else if (jsonResponse) {
            return await res.json();
        } else {
            return (await res.text()) as T;
        }
    }

    private sanitizeUrlForLogs(url: URL | string): string {
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
    /**
     * Form and return a homeserver request URL based on the given path params and prefix.
     * @param path - The HTTP path <b>after</b> the supplied prefix e.g. "/createRoom".
     * @param queryParams - A dict of query params (these will NOT be urlencoded).
     * @param prefix - The full prefix to use e.g. "/_matrix/client/v2_alpha", defaulting to this.opts.prefix.
     * @param baseUrl - The baseUrl to use e.g. "https://matrix.org", defaulting to this.opts.baseUrl.
     * @returns URL
     */
    public getUrl(path: string, queryParams?: QueryDict, prefix?: string, baseUrl?: string): URL {
        const baseUrlWithFallback = baseUrl ?? this.opts.baseUrl;
        const baseUrlWithoutTrailingSlash = baseUrlWithFallback.endsWith("/")
            ? baseUrlWithFallback.slice(0, -1)
            : baseUrlWithFallback;
        const url = new URL(baseUrlWithoutTrailingSlash + (prefix ?? this.opts.prefix) + path);
        // If there are any params, encode and append them to the URL.
        if (this.opts.extraParams || queryParams) {
            const mergedParams = { ...this.opts.extraParams, ...queryParams };
            encodeParams(mergedParams, url.searchParams);
        }

        return url;
    }
}
