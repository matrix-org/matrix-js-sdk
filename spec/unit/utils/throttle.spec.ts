import { throttle } from "../../../src/utils/throttle";

/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

describe("throttle", () => {
    let mockFn: jest.Mock;
    let throttledFn: ReturnType<typeof throttle>;

    beforeEach(() => {
        mockFn = jest.fn();
        throttledFn = throttle(mockFn, 100);

        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllMocks();

        jest.useRealTimers();
    });

    it("should throttle multiple successive calls to a single call", () => {
        throttledFn();
        throttledFn();
        throttledFn();

        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should execute the function each time the delay elapses", () => {
        throttledFn();
        // should execute here (leading edge)
        expect(mockFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(40);
        throttledFn();
        // delay hasn't elapsed yet: don't execute
        expect(mockFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(40);
        throttledFn();
        // still hasn't elapsed
        expect(mockFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(40);
        throttledFn();
        // delay has now elapsed
        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("should execute the function on leading & trailing edge", () => {
        // call it twice...
        throttledFn();
        throttledFn();
        // This should have executed the first call but not the second
        expect(mockFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(110);
        // now the second call should have been executed
        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("should only execute once if the function is called once", () => {
        // call it once...
        throttledFn();
        // This should have executed
        expect(mockFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(110);
        // still should only have executed once
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should pass arguments to the throttled function", () => {
        const arg1 = "arg1";
        const arg2 = 123;

        throttledFn(arg1, arg2);

        expect(mockFn).toHaveBeenCalledWith(arg1, arg2);
    });
});
