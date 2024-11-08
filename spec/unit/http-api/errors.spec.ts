/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { MatrixError } from "../../../src";

type IErrorJson = MatrixError["data"];

describe("MatrixError", () => {
    let headers: Headers;

    beforeEach(() => {
        headers = new Headers({ "Content-Type": "application/json" });
    });

    function makeMatrixError(httpStatus: number, data: IErrorJson, url?: string): MatrixError {
        return new MatrixError(data, httpStatus, url, undefined, headers);
    }

    it("should accept absent retry time from rate-limit error", () => {
        const err = makeMatrixError(429, { errcode: "M_LIMIT_EXCEEDED" });
        expect(err.isRateLimitError()).toBe(true);
        expect(err.getRetryAfterMs()).toEqual(null);
    });

    it("should retrieve retry_after_ms from rate-limit error", () => {
        const err = makeMatrixError(429, { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 150000 });
        expect(err.isRateLimitError()).toBe(true);
        expect(err.getRetryAfterMs()).toEqual(150000);
    });

    it("should ignore retry_after_ms if errcode is not M_LIMIT_EXCEEDED", () => {
        const err = makeMatrixError(429, { errcode: "M_UNKNOWN", retry_after_ms: 150000 });
        expect(err.isRateLimitError()).toBe(true);
        expect(err.getRetryAfterMs()).toEqual(null);
    });

    it("should retrieve numeric Retry-After header from rate-limit error", () => {
        headers.set("Retry-After", "120");
        const err = makeMatrixError(429, { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 150000 });
        expect(err.isRateLimitError()).toBe(true);
        // prefer Retry-After header over retry_after_ms
        expect(err.getRetryAfterMs()).toEqual(120000);
    });

    it("should retrieve Date Retry-After header from rate-limit error", () => {
        headers.set("Retry-After", `${new Date(160000).toUTCString()}`);
        jest.spyOn(globalThis.Date, "now").mockImplementationOnce(() => 100000);
        const err = makeMatrixError(429, { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 150000 });
        expect(err.isRateLimitError()).toBe(true);
        // prefer Retry-After header over retry_after_ms
        expect(err.getRetryAfterMs()).toEqual(60000);
    });

    it("should prefer M_FORBIDDEN errcode over HTTP status code 429", () => {
        headers.set("Retry-After", "120");
        const err = makeMatrixError(429, { errcode: "M_FORBIDDEN" });
        expect(err.isRateLimitError()).toBe(false);
        // retrieve Retry-After header even for non-M_LIMIT_EXCEEDED errors
        expect(err.getRetryAfterMs()).toEqual(120000);
    });

    it("should prefer M_LIMIT_EXCEEDED errcode over HTTP status code 400", () => {
        headers.set("Retry-After", "120");
        const err = makeMatrixError(400, { errcode: "M_LIMIT_EXCEEDED" });
        expect(err.isRateLimitError()).toBe(true);
        // retrieve Retry-After header even for non-429 errors
        expect(err.getRetryAfterMs()).toEqual(120000);
    });

    it("should reject invalid Retry-After header", () => {
        for (const invalidValue of ["-1", "1.23", new Date(0).toString()]) {
            headers.set("Retry-After", invalidValue);
            const err = makeMatrixError(429, { errcode: "M_LIMIT_EXCEEDED" });
            expect(() => err.getRetryAfterMs()).toThrow(
                "value is not a valid HTTP-date or non-negative decimal integer",
            );
        }
    });

    it("should reject too-large Retry-After header", () => {
        headers.set("Retry-After", "1" + Array(500).fill("0").join(""));
        const err = makeMatrixError(429, { errcode: "M_LIMIT_EXCEEDED" });
        expect(() => err.getRetryAfterMs()).toThrow("integer value is too large");
    });

    describe("can be converted to data compatible with the widget api", () => {
        it("from default values", () => {
            const matrixError = new MatrixError();

            const widgetApiErrorData = {
                http_status: 400,
                http_headers: {},
                url: "",
                response: {
                    errcode: "M_UNKNOWN",
                    error: "Unknown message",
                },
            };

            expect(matrixError.asWidgetApiErrorData()).toEqual(widgetApiErrorData);
        });

        it("from non-default values", () => {
            headers.set("Retry-After", "120");
            const statusCode = 429;
            const data = {
                errcode: "M_LIMIT_EXCEEDED",
                error: "Request is rate-limited.",
                retry_after_ms: 120000,
            };
            const url = "http://example.net";

            const matrixError = makeMatrixError(statusCode, data, url);

            const widgetApiErrorData = {
                http_status: statusCode,
                http_headers: {
                    "content-type": "application/json",
                    "retry-after": "120",
                },
                url,
                response: data,
            };

            expect(matrixError.asWidgetApiErrorData()).toEqual(widgetApiErrorData);
        });
    });

    describe("can be created from data received from the widget api", () => {
        it("from minimal data", () => {
            const statusCode = 400;
            const data = {
                errcode: "M_UNKNOWN",
                error: "Something went wrong.",
            };
            const url = "";

            const widgetApiErrorData = {
                http_status: statusCode,
                http_headers: {},
                url,
                response: data,
            };

            headers.delete("Content-Type");
            const matrixError = makeMatrixError(statusCode, data, url);

            expect(MatrixError.fromWidgetApiErrorData(widgetApiErrorData)).toEqual(matrixError);
        });

        it("from more data", () => {
            const statusCode = 429;
            const data = {
                errcode: "M_LIMIT_EXCEEDED",
                error: "Request is rate-limited.",
                retry_after_ms: 120000,
            };
            const url = "http://example.net";

            const widgetApiErrorData = {
                http_status: statusCode,
                http_headers: {
                    "content-type": "application/json",
                    "retry-after": "120",
                },
                url,
                response: data,
            };

            headers.set("Retry-After", "120");
            const matrixError = makeMatrixError(statusCode, data, url);

            expect(MatrixError.fromWidgetApiErrorData(widgetApiErrorData)).toEqual(matrixError);
        });
    });
});
