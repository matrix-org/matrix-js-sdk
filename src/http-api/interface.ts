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

import { MatrixError } from "./errors";

export interface IHttpOpts {
    fetchFn?: typeof global.fetch;

    baseUrl: string;
    idBaseUrl?: string;
    prefix: string;
    extraParams?: Record<string, string>;

    accessToken?: string;
    useAuthorizationHeader?: boolean; // defaults to true

    onlyData?: boolean;
    localTimeoutMs?: number;
}

export interface IRequestOpts {
    baseUrl?: string;
    prefix?: string;

    headers?: Record<string, string>;
    abortSignal?: AbortSignal;
    localTimeoutMs?: number;
    keepAlive?: boolean; // defaults to false
    json?: boolean; // defaults to true

    // Set to true to prevent the request function from emitting a Session.logged_out event.
    // This is intended for use on endpoints where M_UNKNOWN_TOKEN is a valid/notable error response,
    // such as with token refreshes.
    inhibitLogoutEmit?: boolean;
}

export interface IContentUri {
    base: string;
    path: string;
    params: {
        // eslint-disable-next-line camelcase
        access_token: string;
    };
}

export enum HttpApiEvent {
    SessionLoggedOut = "Session.logged_out",
    NoConsent = "no_consent",
}

export type HttpApiEventHandlerMap = {
    [HttpApiEvent.SessionLoggedOut]: (err: MatrixError) => void;
    [HttpApiEvent.NoConsent]: (message: string, consentUri: string) => void;
};

export interface UploadProgress {
    loaded: number;
    total: number;
}

export interface UploadOpts {
    name?: string;
    type?: string;
    includeFilename?: boolean;
    progressHandler?(progress: UploadProgress): void;
    abortController?: AbortController;
}

export interface Upload {
    loaded: number;
    total: number;
    promise: Promise<UploadResponse>;
    abortController: AbortController;
}

export interface UploadResponse {
    // eslint-disable-next-line camelcase
    content_uri: string;
}

export type FileType = XMLHttpRequestBodyInit;
