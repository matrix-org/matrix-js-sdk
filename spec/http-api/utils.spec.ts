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

import { anySignal, MatrixError, parseErrorResponse, timeoutSignal } from "../../src";

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
        const { signal } = anySignal([
            timeoutSignal(3000),
            timeoutSignal(2000),
        ]);

        const onabort = jest.fn();
        signal.onabort = onabort;
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();

        jest.advanceTimersByTime(2000);
        expect(signal.aborted).toBeTruthy();
        expect(onabort).toHaveBeenCalled();
    });

    it("should cleanup when instructed", () => {
        const { signal, cleanup } = anySignal([
            timeoutSignal(3000),
            timeoutSignal(2000),
        ]);

        const onabort = jest.fn();
        signal.onabort = onabort;
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();

        cleanup();
        jest.advanceTimersByTime(2000);
        expect(signal.aborted).toBeFalsy();
        expect(onabort).not.toHaveBeenCalled();
    });
});

describe("parseErrorResponse", () => {
    it("should resolve Matrix Errors from XHR", () => {
        expect(parseErrorResponse({
            getResponseHeader(name: string): string | null {
                return name === "Content-Type" ? "application/json" : null;
            },
            status: 500,
        } as XMLHttpRequest, '{"errcode": "TEST"}')).toStrictEqual(new MatrixError({
            errcode: "TEST",
        }, 500));
    });

    it("should resolve Matrix Errors from fetch", () => {
        expect(parseErrorResponse({
            headers: {
                get(name: string): string | null {
                    return name === "Content-Type" ? "application/json" : null;
                },
            },
            status: 500,
        } as Response, '{"errcode": "TEST"}')).toStrictEqual(new MatrixError({
            errcode: "TEST",
        }, 500));
    });

    it("should handle unknown type gracefully", () => {
        expect(parseErrorResponse({
            headers: {
                get(name: string): string | null {
                    return name === "Content-Type" ? "application/x-foo" : null;
                },
            },
            status: 500,
        } as Response, '{"errcode": "TEST"}')).toStrictEqual(new Error("Server returned 500 error"));
    });

    it("should handle plaintext errors", () => {
        expect(parseErrorResponse({
            headers: {
                get(name: string): string | null {
                    return name === "Content-Type" ? "text/plain" : null;
                },
            },
            status: 418,
        } as Response, "I'm a teapot")).toStrictEqual(new Error("Server returned 418 error: I'm a teapot"));
    });
});

describe("retryNetworkOperation", () => {

});
