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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";

import { preloadRustCrypto } from "../../src/matrix.ts";

vi.mock("@matrix-org/matrix-sdk-crypto-wasm", async (importOriginal) => ({
    ...(await importOriginal<typeof RustSdkCryptoJs>()),
    initAsync: vi.fn().mockResolvedValue(undefined),
}));

describe("preloadRustCrypto", () => {
    it("initialises the Rust Crypto WASM module", async () => {
        expect(RustSdkCryptoJs.initAsync).not.toHaveBeenCalled();
        await preloadRustCrypto();
        expect(RustSdkCryptoJs.initAsync).toHaveBeenCalledTimes(1);
    });
});
