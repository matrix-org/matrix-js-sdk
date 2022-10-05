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

import DOMException from "domexception";

import { ClientPrefix, MatrixHttpApi, Method, Upload } from "../../../src";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

describe("MatrixHttpApi", () => {
    const baseUrl = "http://baseUrl";
    const prefix = ClientPrefix.V3;

    let xhr: Partial<Writeable<XMLHttpRequest>>;
    let upload: Upload;
    const open = jest.fn();
    const send = jest.fn();
    const abort = jest.fn();
    const setRequestHeader = jest.fn();

    const DONE = 0;

    global.DOMException = DOMException;

    beforeEach(() => {
        jest.clearAllMocks();
        xhr = {
            upload: {} as XMLHttpRequestUpload,
            open,
            send,
            abort,
            setRequestHeader,
            onreadystatechange: undefined,
        };
        // We stub out XHR here as it is not available in JSDOM
        // @ts-ignore
        global.XMLHttpRequest = jest.fn().mockReturnValue(xhr);
        // @ts-ignore
        global.XMLHttpRequest.DONE = DONE;
    });

    afterEach(() => {
        upload?.promise.catch(() => {});
        // Abort any remaining requests
        xhr.readyState = DONE;
        xhr.status = 0;
        // @ts-ignore
        xhr.onreadystatechange?.(new Event("test"));
    });

    it("should fall back to `fetch` where xhr is unavailable", () => {
        global.XMLHttpRequest = undefined;
        const fetchFn = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn });
        upload = api.uploadContent({} as File);
        expect(fetchFn).toHaveBeenCalled();
    });

    it("should prefer xhr where available", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn });
        upload = api.uploadContent({} as File);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalled();
    });

    it("should send access token in query params if header disabled", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
            useAuthorizationHeader: false,
        });
        upload = api.uploadContent({} as File);
        expect(open)
            .toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload?access_token=token");
        expect(setRequestHeader).not.toHaveBeenCalledWith("Authorization");
    });

    it("should send access token in header by default", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
        });
        upload = api.uploadContent({} as File);
        expect(open).toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload");
        expect(setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer token");
    });

    it("should include filename by default", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        upload = api.uploadContent({} as File, { name: "name" });
        expect(open)
            .toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload?filename=name");
    });

    it("should allow not sending the filename", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        upload = api.uploadContent({} as File, { name: "name", includeFilename: false });
        expect(open).toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload");
    });

    it("should abort xhr when the upload is aborted", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        upload = api.uploadContent({} as File);
        upload.abortController.abort();
        expect(abort).toHaveBeenCalled();
        return expect(upload.promise).rejects.toThrow("Aborted");
    });
});
