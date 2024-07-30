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

import { sha256Base64UrlUnpadded } from "../../../src/crypto/digest";

describe("sha256Base64UrlUnpadded", () => {
    it("should hash a string", async () => {
        const hash = await sha256Base64UrlUnpadded("test");
        expect(hash).toBe("n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg");
    });

    it("should hash a string with emoji", async () => {
        const hash = await sha256Base64UrlUnpadded("test 🍱");
        expect(hash).toBe("X2aDNrrwfq3nCTOl90R9qg9ynxhHnSzsMqtrdYX-SGw");
    });
});
