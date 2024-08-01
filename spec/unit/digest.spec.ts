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

import { encodeUnpaddedBase64Url } from "../../src";
import { sha256 } from "../../src/digest";

describe("sha256", () => {
    it("should hash a string", async () => {
        const hash = await sha256("test");
        expect(encodeUnpaddedBase64Url(hash)).toBe("n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg");
    });

    it("should hash a string with emoji", async () => {
        const hash = await sha256("test 🍱");
        expect(encodeUnpaddedBase64Url(hash)).toBe("X2aDNrrwfq3nCTOl90R9qg9ynxhHnSzsMqtrdYX-SGw");
    });

    it("throws if webcrypto is not available", async () => {
        const oldCrypto = global.crypto;
        try {
            global.crypto = {} as any;
            await expect(sha256("test")).rejects.toThrow();
        } finally {
            global.crypto = oldCrypto;
        }
    });
});
