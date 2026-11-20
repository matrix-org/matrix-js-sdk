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

import {
    ClientPrefix,
    HttpApiEvent,
    type HttpApiEventHandlerMap,
    type IHttpOpts,
    MatrixError,
    MatrixHttpApi,
    Method,
    TokenRefreshError,
    type UploadResponse,
} from "../../../src";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";
import { flushPromises } from "../../test-utils/flushPromises";
import { makeDelegatedAuthMetadata } from "../../test-utils/auth";

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

    it("should prefer xhr where available", async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true });
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();
        expect(fetchFn).not.toHaveBeenCalled();
        expect(getRequest()!.open).toHaveBeenCalled();
    });

    it("should send access token in query params if header disabled", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
            useAuthorizationHeader: false,
            onlyData: true,
        });
        upload = api.uploadContent({} as File);
        await flushPromises();
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload?access_token=token",
        );
        expect(getRequest()!.setRequestHeader).not.toHaveBeenCalledWith("Authorization");
    });

    it("should send access token in header by default", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            accessToken: "token",
            onlyData: true,
        });
        upload = api.uploadContent({} as File);
        await flushPromises();
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload",
        );
        expect(getRequest()!.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer token");
    });

    it("should include filename by default", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File, { name: "name" });
        await flushPromises();
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload?filename=name",
        );
    });

    it("should allow not sending the filename", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File, { name: "name", includeFilename: false });
        await flushPromises();
        expect(getRequest()!.open).toHaveBeenCalledWith(
            Method.Post,
            baseUrl.toLowerCase() + "/_matrix/media/v3/upload",
        );
    });

    it("should abort xhr when the upload is aborted", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();
        api.cancelUpload(upload);
        expect(getRequest()!.abort).toHaveBeenCalled();
        return expect(upload).rejects.toThrow("Aborted");
    });

    it("should timeout if no progress in 30s", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();
        vi.advanceTimersByTime(25000);
        // @ts-ignore
        getRequest()!.upload.onprogress(new Event("progress", { loaded: 1, total: 100 }));
        vi.advanceTimersByTime(25000);
        expect(getRequest()!.abort).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5000);
        expect(getRequest()!.abort).toHaveBeenCalled();
    });

    it("should call progressHandler", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        const progressHandler = vi.fn();
        upload = api.uploadContent({} as File, { progressHandler });
        await flushPromises();
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

    it("should error when no response body", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();

        getRequest()!.readyState = DONE;
        getRequest()!.responseText = "";
        getRequest()!.status = 200;
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));

        return expect(upload).rejects.toThrow("No response body.");
    });

    it("should error on a 400-code", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();

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

    it("should return response on successful upload", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();

        getRequest()!.readyState = DONE;
        getRequest()!.responseText = '{"content_uri": "mxc://server/foobar"}';
        getRequest()!.status = 200;
        vi.mocked(getRequest()!.getResponseHeader).mockReturnValue("application/json");
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));

        return expect(upload).resolves.toStrictEqual({ content_uri: "mxc://server/foobar" });
    });

    it("should abort xhr when calling `cancelUpload`", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();
        expect(api.cancelUpload(upload)).toBeTruthy();
        expect(getRequest()!.abort).toHaveBeenCalled();
    });

    it("should return false when `cancelUpload` is called but unsuccessful", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();

        getRequest()!.readyState = DONE;
        getRequest()!.status = 500;
        vi.mocked(getRequest()!.getResponseHeader).mockReturnValue("application/json");
        // @ts-ignore
        getRequest()!.onreadystatechange?.(new Event("test"));
        await upload.catch(() => {});

        expect(api.cancelUpload(upload)).toBeFalsy();
        expect(getRequest()!.abort).not.toHaveBeenCalled();
    });

    it("should return active uploads in `getCurrentUploads`", async () => {
        const api = new MatrixHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        upload = api.uploadContent({} as File);
        await flushPromises();
        expect(api.getCurrentUploads().find((u) => u.promise === upload)).toBeTruthy();
        api.cancelUpload(upload);
        expect(api.getCurrentUploads().find((u) => u.promise === upload)).toBeFalsy();
    });

    describe("token refresh", () => {
        const authMetadata = makeDelegatedAuthMetadata("https://issuer.org/");
        const unknownTokenErrBody = { errcode: "M_UNKNOWN_TOKEN", error: "Token is not active" };

        /** Completes the given XHR with a JSON response. */
        function respond(xhr: Writeable<XMLHttpRequest>, status: number, body: object): void {
            xhr.readyState = DONE;
            xhr.status = status;
            xhr.responseText = JSON.stringify(body);
            vi.mocked(xhr.getResponseHeader).mockImplementation((name) =>
                name.toLowerCase() === "content-type" ? "application/json" : null,
            );
            vi.mocked(xhr.getAllResponseHeaders).mockReturnValue("content-type: application/json\r\n");
            // @ts-ignore
            xhr.onreadystatechange?.(new Event("test"));
        }

        function xhrCount(): number {
            return vi.mocked(globalThis.XMLHttpRequest).mock.instances.length;
        }

        /** Waits until `count` XHRs have been made. */
        async function waitForXhrs(count: number): Promise<void> {
            for (let i = 0; i < 20 && xhrCount() < count; i++) {
                await flushPromises();
            }
            expect(xhrCount()).toBe(count);
        }

        function tokenResponse(accessToken: string, expiresIn?: number): Response {
            return new Response(
                JSON.stringify({
                    access_token: accessToken,
                    refresh_token: `${accessToken}-refresh`,
                    token_type: "Bearer",
                    expires_in: expiresIn,
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }

        function makeApi(
            fetchFn: IHttpOpts["fetchFn"],
            extraOpts: Partial<IHttpOpts> = {},
        ): { api: MatrixHttpApi<IHttpOpts>; emitter: TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap> } {
            const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
            vi.spyOn(emitter, "emit");
            const api = new MatrixHttpApi(emitter, {
                baseUrl,
                prefix,
                fetchFn,
                accessToken: "access-token",
                refreshToken: "refresh-token",
                oauth2ClientConfig: { clientId: "client-id" },
                authMetadataCallback: () => Promise.resolve(authMetadata),
                onlyData: true,
                ...extraOpts,
            });
            return { api, emitter };
        }

        it("should refresh the token and retry the upload on M_UNKNOWN_TOKEN", async () => {
            const fetchFn = vi.fn().mockResolvedValue(tokenResponse("new-access-token"));
            const { api, emitter } = makeApi(fetchFn);
            const file = {} as File;
            upload = api.uploadContent(file);
            await waitForXhrs(1);
            expect(getRequest()!.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer access-token");

            respond(getRequest()!, 401, unknownTokenErrBody);
            await waitForXhrs(2);

            expect(fetchFn).toHaveBeenCalledTimes(1);
            expect(fetchFn).toHaveBeenCalledWith(authMetadata.token_endpoint, expect.anything());
            expect(getRequest()!.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer new-access-token");
            expect(getRequest()!.send).toHaveBeenCalledWith(file);

            respond(getRequest()!, 200, { content_uri: "mxc://server/foobar" });
            await expect(upload).resolves.toStrictEqual({ content_uri: "mxc://server/foobar" });
            expect(emitter.emit).not.toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, expect.anything());
        });

        it("should refresh an expired token before starting the upload", async () => {
            const fetchFn = vi
                .fn()
                .mockResolvedValueOnce(tokenResponse("new-access-token", 60))
                .mockResolvedValueOnce(tokenResponse("newer-access-token", 60));
            const { api } = makeApi(fetchFn);

            // The first upload gets us a token with a known expiry
            upload = api.uploadContent({} as File);
            await waitForXhrs(1);
            respond(getRequest()!, 401, unknownTokenErrBody);
            await waitForXhrs(2);
            respond(getRequest()!, 200, { content_uri: "mxc://server/first" });
            await upload;
            expect(fetchFn).toHaveBeenCalledTimes(1);

            // Let that token expire, then upload again
            vi.advanceTimersByTime(61_000);
            upload = api.uploadContent({} as File);
            await waitForXhrs(3);

            expect(fetchFn).toHaveBeenCalledTimes(2);
            expect(getRequest()!.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer newer-access-token");
        });

        it("should send the refreshed token in query params if header disabled", async () => {
            const fetchFn = vi.fn().mockResolvedValue(tokenResponse("new-access-token"));
            const { api } = makeApi(fetchFn, { useAuthorizationHeader: false });
            upload = api.uploadContent({} as File);
            await waitForXhrs(1);
            respond(getRequest()!, 401, unknownTokenErrBody);
            await waitForXhrs(2);

            expect(getRequest()!.open).toHaveBeenCalledWith(
                Method.Post,
                baseUrl.toLowerCase() + "/_matrix/media/v3/upload?access_token=new-access-token",
            );
        });

        it("should emit SessionLoggedOut and reject if the token cannot be refreshed", async () => {
            const fetchFn = vi.fn();
            const { api, emitter } = makeApi(fetchFn, { oauth2ClientConfig: undefined });
            upload = api.uploadContent({} as File);
            await waitForXhrs(1);
            respond(getRequest()!, 401, unknownTokenErrBody);

            await expect(upload).rejects.toThrow(MatrixError);
            expect(fetchFn).not.toHaveBeenCalled();
            expect(xhrCount()).toBe(1);
            expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, expect.any(MatrixError));
        });

        it("should reject with TokenRefreshError if the refresh fails transiently", async () => {
            const fetchFn = vi.fn().mockRejectedValue(new Error("transient fault"));
            const { api, emitter } = makeApi(fetchFn);
            upload = api.uploadContent({} as File);
            await waitForXhrs(1);
            respond(getRequest()!, 401, unknownTokenErrBody);

            await expect(upload).rejects.toThrow(TokenRefreshError);
            expect(xhrCount()).toBe(1);
            expect(emitter.emit).not.toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, expect.anything());
        });

        it("should not retry the upload if it is cancelled during the token refresh", async () => {
            const tokenResolvers = Promise.withResolvers<Response>();
            const fetchFn = vi.fn().mockReturnValue(tokenResolvers.promise);
            const { api } = makeApi(fetchFn);
            upload = api.uploadContent({} as File);
            await waitForXhrs(1);
            respond(getRequest()!, 401, unknownTokenErrBody);
            await flushPromises();
            expect(fetchFn).toHaveBeenCalled();

            api.cancelUpload(upload);
            await expect(upload).rejects.toThrow("Aborted");

            tokenResolvers.resolve(tokenResponse("new-access-token"));
            for (let i = 0; i < 5; i++) await flushPromises();
            expect(xhrCount()).toBe(1);
        });
    });
});
