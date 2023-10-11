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

import { Mocked } from "jest-mock";

import { FetchHttpApi } from "../../../src/http-api/fetch";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";
import {
    ClientPrefix,
    HttpApiEvent,
    HttpApiEventHandlerMap,
    IdentityPrefix,
    IHttpOpts,
    MatrixError,
    Method,
} from "../../../src";
import { emitPromise } from "../../test-utils/test-utils";
import { defer, QueryDict } from "../../../src/utils";
import { Logger } from "../../../src/logger";

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
            expect(() => api.idServerRequest(Method.Get, "/test", {}, IdentityPrefix.V2)).toThrow(
                "No identity server base URL set",
            );
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

    it("should return text if json=false", async () => {
        const text = "418 I'm a teapot";
        const fetchFn = jest.fn().mockResolvedValue({ ok: true, text: jest.fn().mockResolvedValue(text) });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        await expect(
            api.requestOtherUrl(Method.Get, "http://url", undefined, {
                json: false,
            }),
        ).resolves.toBe(text);
    });

    it("should send token via query params if useAuthorizationHeader=false", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: false,
        });
        api.authedRequest(Method.Get, "/path");
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBe("token");
    });

    it("should send token via headers by default", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
        });
        api.authedRequest(Method.Get, "/path");
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer token");
    });

    it("should not send a token if not calling `authedRequest`", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
        });
        api.request(Method.Get, "/path");
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBeFalsy();
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBeFalsy();
    });

    it("should ensure no token is leaked out via query params if sending via headers", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: true,
        });
        api.authedRequest(Method.Get, "/path", { access_token: "123" });
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBeFalsy();
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer token");
    });

    it("should not override manually specified access token via query params", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: false,
        });
        api.authedRequest(Method.Get, "/path", { access_token: "RealToken" });
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBe("RealToken");
    });

    it("should not override manually specified access token via header", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: true,
        });
        api.authedRequest(Method.Get, "/path", undefined, undefined, {
            headers: { Authorization: "Bearer RealToken" },
        });
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer RealToken");
    });

    it("should not override Accept header", () => {
        const fetchFn = jest.fn().mockResolvedValue({ ok: true });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn });
        api.authedRequest(Method.Get, "/path", undefined, undefined, {
            headers: { Accept: "text/html" },
        });
        expect(fetchFn.mock.calls[0][1].headers["Accept"]).toBe("text/html");
    });

    it("should emit NoConsent when given errcode=M_CONTENT_NOT_GIVEN", async () => {
        const fetchFn = jest.fn().mockResolvedValue({
            ok: false,
            headers: {
                get(name: string): string | null {
                    return name === "Content-Type" ? "application/json" : null;
                },
            },
            text: jest.fn().mockResolvedValue(
                JSON.stringify({
                    errcode: "M_CONSENT_NOT_GIVEN",
                    error: "Ye shall ask for consent",
                }),
            ),
        });
        const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
        const api = new FetchHttpApi(emitter, { baseUrl, prefix, fetchFn });

        await Promise.all([
            emitPromise(emitter, HttpApiEvent.NoConsent),
            expect(api.authedRequest(Method.Get, "/path")).rejects.toThrow("Ye shall ask for consent"),
        ]);
    });

    describe("authedRequest", () => {
        it("should not include token if unset", async () => {
            const fetchFn = jest.fn().mockResolvedValue({ ok: true });
            const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
            const api = new FetchHttpApi(emitter, { baseUrl, prefix, fetchFn });
            await api.authedRequest(Method.Post, "/account/password");
            expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
        });

        describe("with refresh token", () => {
            const accessToken = "test-access-token";
            const refreshToken = "test-refresh-token";

            describe("when an unknown token error is encountered", () => {
                const unknownTokenErrBody = {
                    errcode: "M_UNKNOWN_TOKEN",
                    error: "Token is not active",
                    soft_logout: false,
                };
                const unknownTokenErr = new MatrixError(unknownTokenErrBody, 401);
                const unknownTokenResponse = {
                    ok: false,
                    status: 401,
                    headers: {
                        get(name: string): string | null {
                            return name === "Content-Type" ? "application/json" : null;
                        },
                    },
                    text: jest.fn().mockResolvedValue(JSON.stringify(unknownTokenErrBody)),
                };
                const okayResponse = {
                    ok: true,
                    status: 200,
                };

                describe("without a tokenRefreshFunction", () => {
                    it("should emit logout and throw", async () => {
                        const fetchFn = jest.fn().mockResolvedValue(unknownTokenResponse);
                        const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                        jest.spyOn(emitter, "emit");
                        const api = new FetchHttpApi(emitter, { baseUrl, prefix, fetchFn, accessToken, refreshToken });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );
                        expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });
                });

                describe("with a tokenRefreshFunction", () => {
                    it("should emit logout and throw when token refresh fails", async () => {
                        const error = new Error("uh oh");
                        const tokenRefreshFunction = jest.fn().mockRejectedValue(error);
                        const fetchFn = jest.fn().mockResolvedValue(unknownTokenResponse);
                        const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                        jest.spyOn(emitter, "emit");
                        const api = new FetchHttpApi(emitter, {
                            baseUrl,
                            prefix,
                            fetchFn,
                            tokenRefreshFunction,
                            accessToken,
                            refreshToken,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);
                        expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });

                    it("should refresh token and retry request", async () => {
                        const newAccessToken = "new-access-token";
                        const newRefreshToken = "new-refresh-token";
                        const tokenRefreshFunction = jest.fn().mockResolvedValue({
                            accessToken: newAccessToken,
                            refreshToken: newRefreshToken,
                        });
                        const fetchFn = jest
                            .fn()
                            .mockResolvedValueOnce(unknownTokenResponse)
                            .mockResolvedValueOnce(okayResponse);
                        const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                        jest.spyOn(emitter, "emit");
                        const api = new FetchHttpApi(emitter, {
                            baseUrl,
                            prefix,
                            fetchFn,
                            tokenRefreshFunction,
                            accessToken,
                            refreshToken,
                        });
                        const result = await api.authedRequest(Method.Post, "/account/password");
                        expect(result).toEqual(okayResponse);
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);

                        expect(fetchFn).toHaveBeenCalledTimes(2);
                        // uses new access token
                        expect(fetchFn.mock.calls[1][1].headers.Authorization).toEqual("Bearer new-access-token");
                        expect(emitter.emit).not.toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });

                    it("should only try to refresh the token once", async () => {
                        const newAccessToken = "new-access-token";
                        const newRefreshToken = "new-refresh-token";
                        const tokenRefreshFunction = jest.fn().mockResolvedValue({
                            accessToken: newAccessToken,
                            refreshToken: newRefreshToken,
                        });

                        // fetch doesn't like our new or old tokens
                        const fetchFn = jest.fn().mockResolvedValue(unknownTokenResponse);

                        const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                        jest.spyOn(emitter, "emit");
                        const api = new FetchHttpApi(emitter, {
                            baseUrl,
                            prefix,
                            fetchFn,
                            tokenRefreshFunction,
                            accessToken,
                            refreshToken,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );

                        // tried to refresh the token once
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);
                        expect(tokenRefreshFunction).toHaveBeenCalledTimes(1);

                        expect(fetchFn).toHaveBeenCalledTimes(2);
                        // uses new access token on retry
                        expect(fetchFn.mock.calls[1][1].headers.Authorization).toEqual("Bearer new-access-token");

                        // logged out after refreshed access token is rejected
                        expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });
                });
            });
        });
    });

    describe("getUrl()", () => {
        const localBaseUrl = "http://baseurl";
        const baseUrlWithTrailingSlash = "http://baseurl/";
        const makeApi = (thisBaseUrl = baseUrl): FetchHttpApi<any> => {
            const fetchFn = jest.fn();
            const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
            return new FetchHttpApi(emitter, { baseUrl: thisBaseUrl, prefix, fetchFn });
        };

        type TestParams = {
            path: string;
            queryParams?: QueryDict;
            prefix?: string;
            baseUrl?: string;
        };
        type TestCase = [TestParams, string];
        const queryParams: QueryDict = {
            test1: 99,
            test2: ["a", "b"],
        };
        const testPrefix = "/just/testing";
        const testUrl = "http://justtesting.com";
        const testUrlWithTrailingSlash = "http://justtesting.com/";

        const testCases: TestCase[] = [
            [{ path: "/terms" }, `${localBaseUrl}${prefix}/terms`],
            [{ path: "/terms", queryParams }, `${localBaseUrl}${prefix}/terms?test1=99&test2=a&test2=b`],
            [{ path: "/terms", prefix: testPrefix }, `${localBaseUrl}${testPrefix}/terms`],
            [{ path: "/terms", baseUrl: testUrl }, `${testUrl}${prefix}/terms`],
            [{ path: "/terms", baseUrl: testUrlWithTrailingSlash }, `${testUrl}${prefix}/terms`],
            [
                { path: "/terms", queryParams, prefix: testPrefix, baseUrl: testUrl },
                `${testUrl}${testPrefix}/terms?test1=99&test2=a&test2=b`,
            ],
        ];
        const runTests = (fetchBaseUrl: string) => {
            it.each<TestCase>(testCases)(
                "creates url with params %s => %s",
                ({ path, queryParams, prefix, baseUrl }, expected) => {
                    const api = makeApi(fetchBaseUrl);

                    const result = api.getUrl(path, queryParams, prefix, baseUrl);
                    // we only check the stringified URL, to avoid having the test depend on the internals of URL.
                    expect(result.toString()).toEqual(expected);
                },
            );
        };

        describe("when fetch.opts.baseUrl does not have a trailing slash", () => {
            runTests(localBaseUrl);
        });
        describe("when fetch.opts.baseUrl does have a trailing slash", () => {
            runTests(baseUrlWithTrailingSlash);
        });
    });

    it("should not log query parameters", async () => {
        jest.useFakeTimers();
        const deferred = defer<Response>();
        const fetchFn = jest.fn().mockReturnValue(deferred.promise);
        const mockLogger = {
            debug: jest.fn(),
        } as unknown as Mocked<Logger>;
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            logger: mockLogger,
        });
        const prom = api.requestOtherUrl(Method.Get, "https://server:8448/some/path?query=param#fragment");
        jest.advanceTimersByTime(1234);
        deferred.resolve({ ok: true, status: 200, text: () => Promise.resolve("RESPONSE") } as Response);
        await prom;
        expect(mockLogger.debug).not.toHaveBeenCalledWith("fragment");
        expect(mockLogger.debug).not.toHaveBeenCalledWith("query");
        expect(mockLogger.debug).not.toHaveBeenCalledWith("param");
        expect(mockLogger.debug).toHaveBeenCalledTimes(2);
        expect(mockLogger.debug.mock.calls[0]).toMatchInlineSnapshot(`
            [
              "FetchHttpApi: --> GET https://server:8448/some/path?query=xxx",
            ]
        `);
        expect(mockLogger.debug.mock.calls[1]).toMatchInlineSnapshot(`
            [
              "FetchHttpApi: <-- GET https://server:8448/some/path?query=xxx [1234ms 200]",
            ]
        `);
    });
});
