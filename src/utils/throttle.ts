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

type ThrottleFunction = (...args: any[]) => void;

/**
 * Throttles a function to only be called once per `delay` milliseconds.
 * Simple, dependency-free replacement for lodash's throttle. This version executes
 * on the leading and trailing edge.
 * @param fn - The function to throttle.
 * @param delay - The delay in milliseconds.
 * @returns The throttled function.
 */
export function throttle(fn: ThrottleFunction, delay: number): ThrottleFunction {
    let lastExecutionTime = 0;
    let timeout: ReturnType<typeof setTimeout>;

    return (...args: any[]) => {
        const currentTime = Date.now();

        if (currentTime - lastExecutionTime < delay) {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }

            timeout = setTimeout(() => {
                lastExecutionTime = currentTime;
                fn(...args);
            }, delay);
        } else {
            lastExecutionTime = currentTime;
            fn(...args);
        }
    };
}
