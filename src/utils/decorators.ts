/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

/**
 * Method decorator to ensure that only one instance of the method is running at a time,
 * and any concurrent calls will return the same promise as the original call.
 * After execution is complete a new call will be able to run the method again.
 */
export function singleAsyncExecution<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Promise<Return>,
): (this: This, ...args: Args) => Promise<Return> {
    let promise: Promise<Return> | undefined;

    async function replacementMethod(this: This, ...args: Args): Promise<Return> {
        if (promise) return promise;
        try {
            promise = target.call(this, ...args);
            await promise;
            return promise;
        } finally {
            promise = undefined;
        }
    }

    return replacementMethod;
}
