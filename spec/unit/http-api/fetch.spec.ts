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

import type { Mocked, MockedFunction } from "jest-mock";
import { FetchHttpApi } from "../../../src/http-api/fetch";
import { TypedEventEmitter } from "../../../src/models/typed-event-emitter";
import {
    ClientPrefix,
    ConnectionError,
    HttpApiEvent,
    type HttpApiEventHandlerMap,
    IdentityPrefix,
    type IHttpOpts,
    MatrixError,
    Method,
} from "../../../src";
import { emitPromise } from "../../test-utils/test-utils";
import { type QueryDict, sleep } from "../../../src/utils";
import { type Logger } from "../../../src/logger";

describe("FetchHttpApi", () => {
    const baseUrl = "http://baseUrl";
    const idBaseUrl = "http://idBaseUrl";
    const prefix = ClientPrefix.V3;
    const tokenInactiveError = new MatrixError({ errcode: "M_UNKNOWN_TOKEN", error: "Token is not active" }, 401);

    beforeEach(() => {
        jest.useRealTimers();
    });

    it("should support aborting multiple times", () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });

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
        globalThis.fetch = jest.fn();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        api.fetch("test");
        expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("should update identity server base url", () => {
        const api = new FetchHttpApi<IHttpOpts>(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
        expect(api.opts.idBaseUrl).toBeUndefined();
        api.setIdBaseUrl("https://id.foo.bar");
        expect(api.opts.idBaseUrl).toBe("https://id.foo.bar");
    });

    describe("idServerRequest", () => {
        it("should throw if no idBaseUrl", () => {
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, onlyData: true });
            expect(() => api.idServerRequest(Method.Get, "/test", {}, IdentityPrefix.V2)).toThrow(
                "No identity server base URL set",
            );
        });

        it("should send params as query string for GET requests", () => {
            const fetchFn = makeMockFetchFn();
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
                baseUrl,
                idBaseUrl,
                prefix,
                fetchFn,
                onlyData: true,
            });
            api.idServerRequest(Method.Get, "/test", { foo: "bar", via: ["a", "b"] }, IdentityPrefix.V2);
            expect(fetchFn.mock.calls[0][0].searchParams.get("foo")).toBe("bar");
            expect(fetchFn.mock.calls[0][0].searchParams.getAll("via")).toEqual(["a", "b"]);
        });

        it("should send params as body for non-GET requests", () => {
            const fetchFn = makeMockFetchFn();
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
                baseUrl,
                idBaseUrl,
                prefix,
                fetchFn,
                onlyData: true,
            });
            const params = { foo: "bar", via: ["a", "b"] };
            api.idServerRequest(Method.Post, "/test", params, IdentityPrefix.V2);
            expect(fetchFn.mock.calls[0][0].searchParams.get("foo")).not.toBe("bar");
            expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toStrictEqual(params);
        });

        it("should add Authorization header if token provided", () => {
            const fetchFn = makeMockFetchFn();
            const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
                baseUrl,
                idBaseUrl,
                prefix,
                fetchFn,
                onlyData: true,
            });
            api.idServerRequest(Method.Post, "/test", {}, IdentityPrefix.V2, "token");
            expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer token");
        });
    });

    it("should complain if constructed without `onlyData: true`", async () => {
        expect(
            () =>
                new FetchHttpApi(new TypedEventEmitter<any, any>(), {
                    baseUrl,
                    prefix,
                }),
        ).toThrow("Constructing FetchHttpApi without `onlyData=true` is no longer supported.");
    });

    it("should set an Accept header, and parse the response as JSON, by default", async () => {
        const result = { a: 1 };
        const fetchFn = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue(result) });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        await expect(api.requestOtherUrl(Method.Get, "http://url")).resolves.toBe(result);
        expect(fetchFn.mock.calls[0][1].headers.Accept).toBe("application/json");
    });

    it("should not set an Accept header, and should return text if json=false", async () => {
        const text = "418 I'm a teapot";
        const fetchFn = jest.fn().mockResolvedValue({ ok: true, text: jest.fn().mockResolvedValue(text) });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        await expect(
            api.requestOtherUrl(Method.Get, "http://url", undefined, {
                json: false,
            }),
        ).resolves.toBe(text);
        expect(fetchFn.mock.calls[0][1].headers.Accept).not.toBeDefined();
    });

    it("should not set an Accept header, and should return a blob, if rawResponseBody is true", async () => {
        const blob = new Blob(["blobby"]);
        const fetchFn = jest.fn().mockResolvedValue({ ok: true, blob: jest.fn().mockResolvedValue(blob) });
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        await expect(
            api.requestOtherUrl(Method.Get, "http://url", undefined, {
                rawResponseBody: true,
            }),
        ).resolves.toBe(blob);
        expect(fetchFn.mock.calls[0][1].headers.Accept).not.toBeDefined();
    });

    it("should throw an error if both `json` and `rawResponseBody` are defined", async () => {
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn: jest.fn(),
            onlyData: true,
        });
        await expect(
            api.requestOtherUrl(Method.Get, "http://url", undefined, { rawResponseBody: false, json: true }),
        ).rejects.toThrow("Invalid call to `FetchHttpApi`");
    });

    it("should send token via query params if useAuthorizationHeader=false", async () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: false,
            onlyData: true,
        });
        await api.authedRequest(Method.Get, "/path");
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBe("token");
    });

    it("should send token via headers by default", async () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            onlyData: true,
        });
        await api.authedRequest(Method.Get, "/path");
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer token");
    });

    it("should not send a token if not calling `authedRequest`", () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            onlyData: true,
        });
        api.request(Method.Get, "/path");
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBeFalsy();
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBeFalsy();
    });

    it("should ensure no token is leaked out via query params if sending via headers", async () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: true,
            onlyData: true,
        });
        await api.authedRequest(Method.Get, "/path", { access_token: "123" });
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBeFalsy();
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer token");
    });

    it("should not override manually specified access token via query params", async () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: false,
            onlyData: true,
        });
        await api.authedRequest(Method.Get, "/path", { access_token: "RealToken" });
        expect(fetchFn.mock.calls[0][0].searchParams.get("access_token")).toBe("RealToken");
    });

    it("should not override manually specified access token via header", async () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            accessToken: "token",
            useAuthorizationHeader: true,
            onlyData: true,
        });
        await api.authedRequest(Method.Get, "/path", undefined, undefined, {
            headers: { Authorization: "Bearer RealToken" },
        });
        expect(fetchFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer RealToken");
    });

    it("should not override Accept header", async () => {
        const fetchFn = makeMockFetchFn();
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), { baseUrl, prefix, fetchFn, onlyData: true });
        await api.authedRequest(Method.Get, "/path", undefined, undefined, {
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
        const api = new FetchHttpApi(emitter, { baseUrl, prefix, fetchFn, onlyData: true });

        await Promise.all([
            emitPromise(emitter, HttpApiEvent.NoConsent),
            expect(api.authedRequest(Method.Get, "/path")).rejects.toThrow("Ye shall ask for consent"),
        ]);
    });

    describe("authedRequest", () => {
        it("should not include token if unset", async () => {
            const fetchFn = makeMockFetchFn();
            const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
            const api = new FetchHttpApi(emitter, { baseUrl, prefix, fetchFn, onlyData: true });
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
                    json: jest.fn().mockResolvedValue({ x: 1 }),
                };

                describe("without a tokenRefreshFunction", () => {
                    it("should emit logout and throw", async () => {
                        const fetchFn = jest.fn().mockResolvedValue(unknownTokenResponse);
                        const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                        jest.spyOn(emitter, "emit");
                        const api = new FetchHttpApi(emitter, {
                            baseUrl,
                            prefix,
                            fetchFn,
                            accessToken,
                            refreshToken,
                            onlyData: true,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );
                        expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });
                });

                describe("with a tokenRefreshFunction", () => {
                    it("should emit logout and throw when token refresh fails", async () => {
                        const error = new MatrixError();
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
                            onlyData: true,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);
                        expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });

                    it("should not emit logout but still throw when token refresh fails due to transitive fault", async () => {
                        const error = new ConnectionError("transitive fault");
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
                            onlyData: true,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);
                        expect(emitter.emit).not.toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
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
                            onlyData: true,
                        });
                        const result = await api.authedRequest(Method.Post, "/account/password", undefined, undefined, {
                            headers: {},
                        });
                        expect(result).toEqual({ x: 1 });
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);

                        expect(fetchFn).toHaveBeenCalledTimes(2);
                        // uses new access token
                        expect(fetchFn.mock.calls[1][1].headers.Authorization).toEqual("Bearer new-access-token");
                        expect(emitter.emit).not.toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });

                    it("should not try to refresh the token if it has plenty of time left before expiry", async () => {
                        // We can't specify an expiry for the initial token, so this should:
                        // * Try once, fail
                        // * Attempt a refresh, get a token that's not expired
                        // * Try again, still fail
                        // * Not refresh the token because it's not expired
                        // ...which is TWO attempts and ONE refresh (which doesn't really
                        // count because it's only to get a token with an expiry)
                        const newAccessToken = "new-access-token";
                        const newRefreshToken = "new-refresh-token";
                        const tokenRefreshFunction = jest.fn().mockReturnValue({
                            accessToken: newAccessToken,
                            refreshToken: newRefreshToken,
                            // This needs to be sufficiently high that it's over the threshold for
                            // 'plenty of time' (which is a minute in practice).
                            expiry: new Date(Date.now() + 5 * 60 * 1000),
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
                            onlyData: true,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );

                        // tried to refresh the token once (to get the one with an expiry)
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);
                        expect(tokenRefreshFunction).toHaveBeenCalledTimes(1);

                        expect(fetchFn).toHaveBeenCalledTimes(2);
                        // uses new access token on retry
                        expect(fetchFn.mock.calls[1][1].headers.Authorization).toEqual("Bearer new-access-token");

                        // logged out after refreshed access token is rejected
                        expect(emitter.emit).toHaveBeenCalledWith(HttpApiEvent.SessionLoggedOut, unknownTokenErr);
                    });

                    it("should try to refresh the token if it will expire soon", async () => {
                        const newAccessToken = "new-access-token";
                        const newRefreshToken = "new-refresh-token";

                        // first refresh is to get a token with an expiry at all, because we
                        // can't specify an expiry on the token we inject
                        const tokenRefreshFunction = jest.fn().mockResolvedValueOnce({
                            accessToken: newAccessToken,
                            refreshToken: newRefreshToken,
                            expiry: new Date(Date.now() + 1000),
                        });

                        // next refresh is to return a token that will expire 'soon'
                        tokenRefreshFunction.mockResolvedValueOnce({
                            accessToken: newAccessToken,
                            refreshToken: newRefreshToken,
                            expiry: new Date(Date.now() + 1000),
                        });

                        // ...and finally we return a token that has adequate time left
                        // so that it will cease retrying and fail the request.
                        tokenRefreshFunction.mockResolvedValueOnce({
                            accessToken: newAccessToken,
                            refreshToken: newRefreshToken,
                            expiry: new Date(Date.now() + 5 * 60 * 1000),
                        });

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
                            onlyData: true,
                        });
                        await expect(api.authedRequest(Method.Post, "/account/password")).rejects.toThrow(
                            unknownTokenErr,
                        );

                        // We should have seen the 3 token refreshes, as above.
                        expect(tokenRefreshFunction).toHaveBeenCalledWith(refreshToken);
                        expect(tokenRefreshFunction).toHaveBeenCalledTimes(3);
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
            return new FetchHttpApi(emitter, { baseUrl: thisBaseUrl, prefix, fetchFn, onlyData: true });
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

        describe("extraParams handling", () => {
            const makeApiWithExtraParams = (extraParams: QueryDict): FetchHttpApi<any> => {
                const fetchFn = jest.fn();
                const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                return new FetchHttpApi(emitter, {
                    baseUrl: localBaseUrl,
                    prefix,
                    fetchFn,
                    onlyData: true,
                    extraParams,
                });
            };

            const userId = "@rsb-tbg:localhost";
            const encodedUserId = encodeURIComponent(userId);

            it("should include extraParams in URL when no queryParams provided", () => {
                const extraParams = { user_id: userId, version: "1.0" };
                const api = makeApiWithExtraParams(extraParams);

                const result = api.getUrl("/test");
                expect(result.toString()).toBe(`${localBaseUrl}${prefix}/test?user_id=${encodedUserId}&version=1.0`);
            });

            it("should merge extraParams with queryParams", () => {
                const extraParams = { user_id: userId, version: "1.0" };
                const api = makeApiWithExtraParams(extraParams);

                const queryParams = { userId: "123", filter: "active" };
                const result = api.getUrl("/test", queryParams);

                expect(result.searchParams.get("user_id")!).toBe(userId);
                expect(result.searchParams.get("version")!).toBe("1.0");
                expect(result.searchParams.get("userId")!).toBe("123");
                expect(result.searchParams.get("filter")!).toBe("active");
            });

            it("should allow queryParams to override extraParams", () => {
                const extraParams = { user_id: "@default:localhost", version: "1.0" };
                const api = makeApiWithExtraParams(extraParams);

                const queryParams = { user_id: "@override:localhost", userId: "123" };
                const result = api.getUrl("/test", queryParams);

                expect(result.searchParams.get("user_id")).toBe("@override:localhost");
                expect(result.searchParams.get("version")!).toBe("1.0");
                expect(result.searchParams.get("userId")!).toBe("123");
            });

            it("should handle empty extraParams", () => {
                const extraParams = {};
                const api = makeApiWithExtraParams(extraParams);

                const queryParams = { userId: "123" };
                const result = api.getUrl("/test", queryParams);

                expect(result.searchParams.get("userId")!).toBe("123");
                expect(result.searchParams.has("user_id")).toBe(false);
            });

            it("should work when extraParams is undefined", () => {
                const fetchFn = jest.fn();
                const emitter = new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>();
                const api = new FetchHttpApi(emitter, { baseUrl: localBaseUrl, prefix, fetchFn, onlyData: true });

                const queryParams = { userId: "123" };
                const result = api.getUrl("/test", queryParams);

                expect(result.searchParams.get("userId")!).toBe("123");
                expect(result.toString()).toBe(`${localBaseUrl}${prefix}/test?userId=123`);
            });

            it("should work when queryParams is undefined", () => {
                const extraParams = { user_id: userId, version: "1.0" };
                const api = makeApiWithExtraParams(extraParams);

                const result = api.getUrl("/test");

                expect(result.searchParams.get("user_id")!).toBe(userId);
                expect(result.toString()).toBe(`${localBaseUrl}${prefix}/test?user_id=${encodedUserId}&version=1.0`);
            });
        });
    });

    it("should not log query parameters", async () => {
        jest.useFakeTimers();
        const responseResolvers = Promise.withResolvers<Response>();
        const fetchFn = jest.fn().mockReturnValue(responseResolvers.promise);
        const mockLogger = {
            debug: jest.fn(),
        } as unknown as Mocked<Logger>;
        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            logger: mockLogger,
            onlyData: true,
        });
        const prom = api.requestOtherUrl(Method.Get, "https://server:8448/some/path?query=param#fragment");
        jest.advanceTimersByTime(1234);
        responseResolvers.resolve({ ok: true, status: 200, json: () => Promise.resolve("RESPONSE") } as Response);
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

    it("should not make multiple concurrent refresh token requests", async () => {
        const deferredTokenRefresh = Promise.withResolvers<{ accessToken: string; refreshToken: string }>();
        const fetchFn = jest.fn().mockResolvedValue({
            ok: false,
            status: tokenInactiveError.httpStatus,
            async text() {
                return JSON.stringify(tokenInactiveError.data);
            },
            async json() {
                return tokenInactiveError.data;
            },
            headers: {
                get: jest.fn().mockReturnValue("application/json"),
            },
        });
        const tokenRefreshFunction = jest.fn().mockReturnValue(deferredTokenRefresh.promise);

        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            doNotAttemptTokenRefresh: false,
            tokenRefreshFunction,
            accessToken: "ACCESS_TOKEN",
            refreshToken: "REFRESH_TOKEN",
            onlyData: true,
        });

        const prom1 = api.authedRequest(Method.Get, "/path1");
        const prom2 = api.authedRequest(Method.Get, "/path2");

        await sleep(0); // wait for requests to fire
        expect(fetchFn).toHaveBeenCalledTimes(2);
        fetchFn.mockResolvedValue({
            ok: true,
            status: 200,
            async text() {
                return "{}";
            },
            async json() {
                return {};
            },
            headers: {
                get: jest.fn().mockReturnValue("application/json"),
            },
        });
        deferredTokenRefresh.resolve({ accessToken: "NEW_ACCESS_TOKEN", refreshToken: "NEW_REFRESH_TOKEN" });

        await prom1;
        await prom2;
        expect(fetchFn).toHaveBeenCalledTimes(4); // 2 original calls + 2 retries
        expect(tokenRefreshFunction).toHaveBeenCalledTimes(1);
        expect(api.opts.accessToken).toBe("NEW_ACCESS_TOKEN");
        expect(api.opts.refreshToken).toBe("NEW_REFRESH_TOKEN");
    });

    it("should use newly refreshed token if request starts mid-refresh", async () => {
        const deferredTokenRefresh = Promise.withResolvers<{ accessToken: string; refreshToken: string }>();
        const fetchFn = jest.fn().mockResolvedValue({
            ok: false,
            status: tokenInactiveError.httpStatus,
            async text() {
                return JSON.stringify(tokenInactiveError.data);
            },
            async json() {
                return tokenInactiveError.data;
            },
            headers: {
                get: jest.fn().mockReturnValue("application/json"),
            },
        });
        const tokenRefreshFunction = jest.fn().mockReturnValue(deferredTokenRefresh.promise);

        const api = new FetchHttpApi(new TypedEventEmitter<any, any>(), {
            baseUrl,
            prefix,
            fetchFn,
            doNotAttemptTokenRefresh: false,
            tokenRefreshFunction,
            accessToken: "ACCESS_TOKEN",
            refreshToken: "REFRESH_TOKEN",
            onlyData: true,
        });

        const prom1 = api.authedRequest(Method.Get, "/path1");
        await sleep(0); // wait for request to fire

        const prom2 = api.authedRequest(Method.Get, "/path2");
        await sleep(0); // wait for request to fire

        deferredTokenRefresh.resolve({ accessToken: "NEW_ACCESS_TOKEN", refreshToken: "NEW_REFRESH_TOKEN" });
        fetchFn.mockResolvedValue({
            ok: true,
            status: 200,
            async text() {
                return "{}";
            },
            async json() {
                return {};
            },
            headers: {
                get: jest.fn().mockReturnValue("application/json"),
            },
        });

        await prom1;
        await prom2;
        expect(fetchFn).toHaveBeenCalledTimes(3); // 2 original calls + 1 retry
        expect(fetchFn.mock.calls[0][1]).toEqual(
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ACCESS_TOKEN" }) }),
        );
        expect(fetchFn.mock.calls[2][1]).toEqual(
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer NEW_ACCESS_TOKEN" }) }),
        );
        expect(tokenRefreshFunction).toHaveBeenCalledTimes(1);
        expect(api.opts.accessToken).toBe("NEW_ACCESS_TOKEN");
        expect(api.opts.refreshToken).toBe("NEW_REFRESH_TOKEN");
    });
});

function makeMockFetchFn(): MockedFunction<any> {
    return jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
}
