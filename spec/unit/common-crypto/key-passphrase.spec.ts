/*
 * Copyright 2024 The Matrix.org Foundation C.I.C.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { keyFromAuthData } from "../../../src/common-crypto/key-passphrase.ts";

describe("key-passphrase", () => {
    describe("keyFromAuthData", () => {
        it("should throw an error if salt or iterations are missing", async () => {
            // missing salt
            expect(() => keyFromAuthData({ private_key_iterations: 5 }, "passphrase")).toThrow(
                "Salt and/or iterations not found: this backup cannot be restored with a passphrase",
            );

            // missing iterations
            expect(() => keyFromAuthData({ private_key_salt: "salt" }, "passphrase")).toThrow(
                "Salt and/or iterations not found: this backup cannot be restored with a passphrase",
            );
        });

        it("should derive key from auth data", async () => {
            const key = await keyFromAuthData({ private_key_salt: "salt", private_key_iterations: 5 }, "passphrase");
            expect(key).toBeDefined();
        });
    });
});
