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

import { mocked } from "jest-mock";

import {
    anySignal,
    ConnectionError,
    HTTPError,
    MatrixError,
    parseErrorResponse,
    retryNetworkOperation,
    timeoutSignal,
} from "../../../src";
import { sleep } from "../../../src/utils";

jest.mock("../../../src/utils");
// setupTests mocks `timeoutSignal` due to hanging timers
jest.unmock("../../../src/http-api/utils");

describe("timeoutSignal", () => {
    jest.useFakeTimers();

    it("should fire abort signal after specified timeout", () => {
        const signal = timeoutSignal(3000);
        const onabort = jest.fn();
        signal.onabort = onabort;
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();

        jest.advanceTimersByTime(3000);
        expect(signal.aborted).toBeTruthy();
        expect(onabort).toHaveBeenCalled();
    });
});

describe("anySignal", () => {
    jest.useFakeTimers();

    it("should fire when any signal fires", () => {
        const { signal } = anySignal([timeoutSignal(3000), timeoutSignal(2000)]);

        const onabort = jest.fn();
        signal.onabort = onabort;
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();

        jest.advanceTimersByTime(2000);
        expect(signal.aborted).toBeTruthy();
        expect(onabort).toHaveBeenCalled();
    });

    it("should cleanup when instructed", () => {
        const { signal, cleanup } = anySignal([timeoutSignal(3000), timeoutSignal(2000)]);

        const onabort = jest.fn();
        signal.onabort = onabort;
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();

        cleanup();
        jest.advanceTimersByTime(2000);
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();
    });

    it("should abort immediately if passed an aborted signal", () => {
        const controller = new AbortController();
        controller.abort();
        const { signal } = anySignal([controller.signal]);
        expect(signal.aborted).toBeTruthy();
    });
});

describe("parseErrorResponse", () => {
    let headers: Headers;
    const xhrHeaderMethods = {
        getResponseHeader: (name: string) => headers.get(name),
        getAllResponseHeaders: () => {
            let allHeaders = "";
            headers.forEach((value, key) => {
                allHeaders += `${key.toLowerCase()}: ${value}\r\n`;
            });
            return allHeaders;
        },
    };

    beforeEach(() => {
        headers = new Headers();
    });

    it("should resolve Matrix Errors from XHR", () => {
        headers.set("Content-Type", "application/json");
        expect(
            parseErrorResponse(
                {
                    ...xhrHeaderMethods,
                    status: 500,
                } as XMLHttpRequest,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(
            new MatrixError(
                {
                    errcode: "TEST",
                },
                500,
            ),
        );
    });

    it("should resolve Matrix Errors from fetch", () => {
        headers.set("Content-Type", "application/json");
        expect(
            parseErrorResponse(
                {
                    headers,
                    status: 500,
                } as Response,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(
            new MatrixError(
                {
                    errcode: "TEST",
                },
                500,
            ),
        );
    });

    it("should resolve Matrix Errors from XHR with urls", () => {
        headers.set("Content-Type", "application/json");
        expect(
            parseErrorResponse(
                {
                    responseURL: "https://example.com",
                    ...xhrHeaderMethods,
                    status: 500,
                } as XMLHttpRequest,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(
            new MatrixError(
                {
                    errcode: "TEST",
                },
                500,
                "https://example.com",
            ),
        );
    });

    it("should resolve Matrix Errors from fetch with urls", () => {
        headers.set("Content-Type", "application/json");
        expect(
            parseErrorResponse(
                {
                    url: "https://example.com",
                    headers,
                    status: 500,
                } as Response,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(
            new MatrixError(
                {
                    errcode: "TEST",
                },
                500,
                "https://example.com",
            ),
        );
    });

    describe("with HTTP headers", () => {
        function addHeaders(headers: Headers) {
            headers.set("Age", "0");
            headers.set("Date", "Thu, 01 Jan 1970 00:00:00 GMT"); // value contains colons
            headers.set("x-empty", "");
            headers.set("x-multi", "1");
            headers.append("x-multi", "2");
        }

        function compareHeaders(expectedHeaders: Headers, otherHeaders: Headers | undefined) {
            expect(new Map(otherHeaders)).toEqual(new Map(expectedHeaders));
        }

        it("should resolve HTTP Errors from XHR with headers", () => {
            headers.set("Content-Type", "text/plain");
            addHeaders(headers);
            const err = parseErrorResponse({
                ...xhrHeaderMethods,
                status: 500,
            } as XMLHttpRequest) as HTTPError;
            compareHeaders(headers, err.httpHeaders);
        });

        it("should resolve HTTP Errors from fetch with headers", () => {
            headers.set("Content-Type", "text/plain");
            addHeaders(headers);
            const err = parseErrorResponse({
                headers,
                status: 500,
            } as Response) as HTTPError;
            compareHeaders(headers, err.httpHeaders);
        });

        it("should resolve Matrix Errors from XHR with headers", () => {
            headers.set("Content-Type", "application/json");
            addHeaders(headers);
            const err = parseErrorResponse(
                {
                    ...xhrHeaderMethods,
                    status: 500,
                } as XMLHttpRequest,
                '{"errcode": "TEST"}',
            ) as MatrixError;
            compareHeaders(headers, err.httpHeaders);
        });

        it("should resolve Matrix Errors from fetch with headers", () => {
            headers.set("Content-Type", "application/json");
            addHeaders(headers);
            const err = parseErrorResponse(
                {
                    headers,
                    status: 500,
                } as Response,
                '{"errcode": "TEST"}',
            ) as MatrixError;
            compareHeaders(headers, err.httpHeaders);
        });
    });

    it("should set a sensible default error message on MatrixError", () => {
        let err = new MatrixError();
        expect(err.message).toEqual("MatrixError: Unknown message");
        err = new MatrixError({
            error: "Oh no",
        });
        expect(err.message).toEqual("MatrixError: Oh no");
    });

    it("should handle no type gracefully", () => {
        // No Content-Type header
        expect(
            parseErrorResponse(
                {
                    headers,
                    status: 500,
                } as Response,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(new HTTPError("Server returned 500 error", 500));
    });

    it("should handle empty type gracefully", () => {
        headers.set("Content-Type", " ");
        expect(
            parseErrorResponse(
                {
                    headers,
                    status: 500,
                } as Response,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(new Error("Error parsing Content-Type '': TypeError: argument string is required"));
    });

    it("should handle invalid type gracefully", () => {
        headers.set("Content-Type", "unknown");
        expect(
            parseErrorResponse(
                {
                    headers,
                    status: 500,
                } as Response,
                '{"errcode": "TEST"}',
            ),
        ).toStrictEqual(new Error("Error parsing Content-Type 'unknown': TypeError: invalid media type"));
    });

    it("should handle plaintext errors", () => {
        headers.set("Content-Type", "text/plain");
        expect(
            parseErrorResponse(
                {
                    headers,
                    status: 418,
                } as Response,
                "I'm a teapot",
            ),
        ).toStrictEqual(new HTTPError("Server returned 418 error: I'm a teapot", 418));
    });
});

describe("retryNetworkOperation", () => {
    it("should retry given number of times with exponential sleeps", async () => {
        const err = new ConnectionError("test");
        const fn = jest.fn().mockRejectedValue(err);
        mocked(sleep).mockResolvedValue(undefined);
        await expect(retryNetworkOperation(4, fn)).rejects.toThrow(err);
        expect(fn).toHaveBeenCalledTimes(4);
        expect(mocked(sleep)).toHaveBeenCalledTimes(3);
        expect(mocked(sleep).mock.calls[0][0]).toBe(2000);
        expect(mocked(sleep).mock.calls[1][0]).toBe(4000);
        expect(mocked(sleep).mock.calls[2][0]).toBe(8000);
    });

    it("should bail out on errors other than ConnectionError", async () => {
        const err = new TypeError("invalid JSON");
        const fn = jest.fn().mockRejectedValue(err);
        mocked(sleep).mockResolvedValue(undefined);
        await expect(retryNetworkOperation(3, fn)).rejects.toThrow(err);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should return newest ConnectionError when giving up", async () => {
        const err1 = new ConnectionError("test1");
        const err2 = new ConnectionError("test2");
        const err3 = new ConnectionError("test3");
        const errors = [err1, err2, err3];
        const fn = jest.fn().mockImplementation(() => {
            throw errors.shift();
        });
        mocked(sleep).mockResolvedValue(undefined);
        await expect(retryNetworkOperation(3, fn)).rejects.toThrow(err3);
    });
});
