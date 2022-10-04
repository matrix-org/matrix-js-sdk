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

import { FetchHttpApi } from "../../../src/http-api/fetch";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";
import { ClientPrefix, IdentityPrefix, IHttpOpts, Method } from "../../../src";

describe("FetchHttpApi", () => {
    const baseUrl = "http://baseUrl";
    const idBaseUrl = "http://idBaseUrl";
    const prefix = ClientPrefix.V3;

    it("should support aborting multiple times", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn });

        api.request(Method.Get, "/foo");
        api.request(Method.Get, "/baz");
        expect(fetchFn.mock.calls[0][0].href.endsWith("/foo")).toBeTruthy();
        expect(fetchFn.mock.calls[0][1].signal.aborted).toBeFalsy();
        expect(fetchFn.mock.calls[1][0].href.endsWith("/baz")).toBeTruthy();
        expect(fetchFn.mock.calls[1][1].signal.aborted).toBeFalsy();

        api.abort();
        expect(fetchFn.mock.calls[0][1].signal.aborted).toBeTruthy();
        expect(fetchFn.mock.calls[1][1].signal.aborted).toBeTruthy();

        api.request(Method.Get, "/bar");
        expect(fetchFn.mock.calls[2][0].href.endsWith("/bar")).toBeTruthy();
        expect(fetchFn.mock.calls[2][1].signal.aborted).toBeFalsy();

        api.abort();
        expect(fetchFn.mock.calls[2][1].signal.aborted).toBeTruthy();
    });

    it("should fall back to global fetch if fetchFn not provided", () => {
        global.fetch = jest.fn();
        expect(global.fetch).not.toHaveBeenCalled();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        api.fetch("test");
        expect(global.fetch).toHaveBeenCalled();
    });

    it("should update identity server base url", () => {
        const api = new FetchHttpApi<IHttpOpts>(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
        expect(api.opts.idBaseUrl).toBeUndefined();
        api.setIdBaseUrl("https://id.foo.bar");
        expect(api.opts.idBaseUrl).toBe("https://id.foo.bar");
    });

    describe("idServerRequest", () => {
        it("should throw if no idBaseUrl", () => {
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix });
            expect(() => api.idServerRequest(Method.Get, "/test", {}, IdentityPrefix.V2))
                .toThrow("No identity server base URL set");
        });

        it("should send params as query string for GET requests", () => {
            const fetchFn = jest.fn().mockResolvedValue({ ok: true });
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, idBaseUrl, prefix, fetchFn });
            api.idServerRequest(Method.Get, "/test", { foo: "bar", via: ["a", "b"] }, IdentityPrefix.V2);
            expect(fetchFn.mock.calls[0][0].searchParams.get("foo")).toBe("bar");
            expect(fetchFn.mock.calls[0][0].searchParams.getAll("via")).toEqual(["a", "b"]);
        });

        it("should send params as body for non-GET requests", () => {
            const fetchFn = jest.fn().mockResolvedValue({ ok: true });
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, idBaseUrl, prefix, fetchFn });
            const params = { foo: "bar", via: ["a", "b"] };
            api.idServerRequest(Method.Post, "/test", params, IdentityPrefix.V2);
            expect(fetchFn.mock.calls[0][0].searchParams.get("foo")).not.toBe("bar");
            expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toStrictEqual(params);
        });

        it("should add Authorization header if token provided", () => {
            const fetchFn = jest.fn().mockResolvedValue({ ok: true });
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, idBaseUrl, prefix, fetchFn });
            api.idServerRequest(Method.Post, "/test", {}, IdentityPrefix.V2, "token");
            expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer token");
        });
    });

    it("should return the Response object if onlyData=false", async () => {
        const res = { ok: true };
        const fetchFn = jest.fn().mockResolvedValue(res);
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: false });
        await expect(api.requestOtherUrl(Method.Get, "http://url")).resolves.toBe(res);
    });
});
