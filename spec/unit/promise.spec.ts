/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { promiseWithResolvers } from "../../src/promise";

describe("promiseWithResolvers", () => {
    it("creates a deferred promise when Promise.withResolvers is unavailable", async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");

        Object.defineProperty(Promise, "withResolvers", {
            value: undefined,
            configurable: true,
            writable: true,
        });

        try {
            const deferred = promiseWithResolvers<number>();

            deferred.resolve(42);
            await expect(deferred.promise).resolves.toBe(42);
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(Promise, "withResolvers", originalDescriptor);
            } else {
                delete (Promise as PromiseConstructor & { withResolvers?: unknown }).withResolvers;
            }
        }
    });
});
