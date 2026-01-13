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

import { ClientPrefix, MatrixHttpApi, Method, type UploadResponse } from "../../../src";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

vi.useFakeTimers();

describe("MatrixHttpApi", () => {
    const baseUrl = "http://baseUrl";
    const prefix = ClientPrefix.V3;

    let upload: Promise<UploadResponse>;

    const DONE = 0;

    function getRequest(): Writeable<XMLHttpRequest> | undefined {
        return vi.mocked(globalThis.XMLHttpRequest)?.mock.instances.at(-1);
    }

    beforeEach(() => {
        // We stub out XHR here as it is not available in the test environment
        // @ts-ignore
        globalThis.XMLHttpRequest = vi.fn().mockImplementation(function (this: XMLHttpRequest) {
            // @ts-ignore
            this.upload = {} as XMLHttpRequestUpload;
            this.open = vi.fn();
            this.send = vi.fn();
            this.abort = vi.fn();
            this.setRequestHeader = vi.fn();
            // @ts-ignore
            this.onreadystatechange = undefined;
            this.getResponseHeader = vi.fn();
            this.getAllResponseHeaders = vi.fn();
        });
        // @ts-ignore
        globalThis.XMLHttpRequest.DONE = DONE;
    });

    afterEach(() => {
        upload?.catch(() => {});
        const xhr = getRequest();
        if (xhr) {
            // Abort any remaining requests
            xhr.readyState = DONE;
            xhr.status = 0;
            // @ts-ignore
            xhr.onreadystatechange?.(new Event("test"));
        }
    });

    it("should fall back to `fetch` where xhr is unavailable", async () => {
        globalThis.XMLHttpRequest = undefined!;
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        upload = api.uploadContent({} as File);
        await upload;
        expect(fetchFn).toHaveBeenCalled();
    });

    it("should prefer xhr where available", () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        upload = api.uploadContent({} as File);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(getRequest()!.open).toHaveBeenCalled();
    });

    it("should send access token in query params if header disabled", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
            useAuthorizationHeader: false,
            onlyData: true,
        });
        upload = api.uploadContent({} as File);
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload?access_token=token",
        );
        expect(getRequest()!.setRequestHeader).not.toHaveBeenCalledWith("Authorization");
    });

    it("should send access token in header by default", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
            onlyData: true,
        });
        upload = api.uploadContent({} as File);
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload",
        );
        expect(getRequest()!.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer token");
    });

    it("should include filename by default", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File, { name: "name" });
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload?filename=name",
        );
    });

    it("should allow not sending the filename", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File, { name: "name", includeFilename: false });
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload",
        );
    });

    it("should abort xhr when the upload is aborted", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        api.cancelUpload(upload);
        expect(getRequest()!.abort).toHaveBeenCalled();
        return expect(upload).rejects.toThrow("Aborted");
    });

    it("should timeout if no progress in 30s", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        vi.advanceTimersByTime(25000);
        // @ts-ignore
        getRequest()!.upload.onprogress(new Event("progress", { loaded: 1, total: 100 }));
        vi.advanceTimersByTime(25000);
        expect(getRequest()!.abort).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5000);
        expect(getRequest()!.abort).toHaveBeenCalled();
    });

    it("should call progressHandler", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        const progressHandler = vi.fn();
        upload = api.uploadContent({} as File, { progressHandler });
        const progressEvent = new Event("progress") as ProgressEvent;
        Object.assign(progressEvent, { loaded: 1, total: 100 });
        // @ts-ignore
        getRequest()!.upload.onprogress(progressEvent);
        expect(progressHandler).toHaveBeenCalledWith({ loaded: 1, total: 100 });

        Object.assign(progressEvent, { loaded: 95, total: 100 });
        // @ts-ignore
        getRequest()!.upload.onprogress(progressEvent);
        expect(progressHandler).toHaveBeenCalledWith({ loaded: 95, total: 100 });
    });

    it("should error when no response body", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);

        getRequest()!.readyState = DONE;
        getRequest()!.responseText = "";
        getRequest()!.status = 200;
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));

        return expect(upload).rejects.toThrow("No response body.");
    });

    it("should error on a 400-code", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);

        getRequest()!.readyState = DONE;
        getRequest()!.responseText = '{"errcode": "M_NOT_FOUND", "error": "Not found"}';
        getRequest()!.status = 404;
        vi.mocked(getRequest()!.getResponseHeader).mockImplementation((name) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        );
        vi.mocked(getRequest()!.getAllResponseHeaders).mockReturnValue("content-type: application/json\r\n");
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));

        return expect(upload).rejects.toThrow("Not found");
    });

    it("should return response on successful upload", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);

        getRequest()!.readyState = DONE;
        getRequest()!.responseText = '{"content_uri": "mxc://server/foobar"}';
        getRequest()!.status = 200;
        vi.mocked(getRequest()!.getResponseHeader).mockReturnValue("application/json");
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));

        return expect(upload).resolves.toStrictEqual({ content_uri: "mxc://server/foobar" });
    });

    it("should abort xhr when calling `cancelUpload`", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        expect(api.cancelUpload(upload)).toBeTruthy();
        expect(getRequest()!.abort).toHaveBeenCalled();
    });

    it("should return false when `cancelUpload` is called but unsuccessful", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);

        getRequest()!.readyState = DONE;
        getRequest()!.status = 500;
        vi.mocked(getRequest()!.getResponseHeader).mockReturnValue("application/json");
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));
        await upload.catch(() => {});

        expect(api.cancelUpload(upload)).toBeFalsy();
        expect(getRequest()!.abort).not.toHaveBeenCalled();
    });

    it("should return active uploads in `getCurrentUploads`", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        expect(api.getCurrentUploads().find((u) => u.promise === upload)).toBeTruthy();
        api.cancelUpload(upload);
        expect(api.getCurrentUploads().find((u) => u.promise === upload)).toBeFalsy();
    });

    it("should return expected object from `getContentUri`", () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
            onlyData: true,
        });
        expect(api.getContentUri()).toMatchSnapshot();
    });
});
