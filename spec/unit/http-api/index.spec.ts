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

import { ClientPrefix, MatrixHttpApi, Method } from "../../../src";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";

describe("MatrixHttpApi", () => {
    const baseUrl = "http://baseUrl";
    const prefix = ClientPrefix.V3;

    const open = jest.fn();
    const send = jest.fn();
    const abort = jest.fn();
    const setRequestHeader = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        // @ts-ignore
        global.XMLHttpRequest = jest.fn().mockReturnValue({
            upload: {},
            open,
            send,
            abort,
            setRequestHeader,
        });
    });

    it("should fall back to `fetch` where xhr is unavailable", () => {
        global.XMLHttpRequest = undefined;
        const fetchFn = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn });
        api.uploadContent({} as File);
        expect(fetchFn).toHaveBeenCalled();
    });

    it("should prefer xhr where available", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn });
        api.uploadContent({} as File);
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
        api.uploadContent({} as File);
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
        api.uploadContent({} as File);
        expect(open).toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload");
        expect(setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer token");
    });

    it("should include filename by default", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        api.uploadContent({} as File, { name: "name" });
        expect(open)
            .toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload?filename=name");
    });

    it("should allow not sending the filename", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        api.uploadContent({} as File, { name: "name", includeFilename: false });
        expect(open).toHaveBeenCalledWith(Method.Post, baseUrl.toLowerCase() + "/_matrix/media/r0/upload");
    });

    it("should abort xhr when the upload is aborted", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        const upload = api.uploadContent({} as File);
        upload.abortController.abort();
        expect(abort).toHaveBeenCalled();
        return expect(upload.promise).rejects.toThrow("Aborted");
    });
});
