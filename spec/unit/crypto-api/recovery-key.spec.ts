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

import { decodeRecoveryKey, encodeRecoveryKey } from "../../../src/crypto-api";

describe("recovery key", () => {
    describe("decodeRecoveryKey", () => {
        it("should thrown an incorrect length error", () => {
            const key = [0, 1];
            const encodedKey = encodeRecoveryKey(key)!;

            expect(() => decodeRecoveryKey(encodedKey)).toThrow("Incorrect length");
        });

        it("should thrown an incorrect parity", () => {
            const key = Array.from({ length: 32 }, (_, i) => i);
            let encodedKey = encodeRecoveryKey(key)!;
            // Mutate the encoded key to have incorrect parity
            encodedKey = encodedKey.replace("EsSz", "EsSZ");

            expect(() => decodeRecoveryKey(encodedKey!)).toThrow("Incorrect parity");
        });

        it("should decode a valid encoded key", () => {
            const key = Array.from({ length: 32 }, (_, i) => i);
            const encodedKey = encodeRecoveryKey(key)!;

            expect(decodeRecoveryKey(encodedKey)).toEqual(new Uint8Array(key));
        });
    });
});
