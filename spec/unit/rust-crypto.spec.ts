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

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { RustCrypto } from "../../src/rust-crypto/rust-crypto";
import { initRustCrypto } from "../../src/rust-crypto";
import { IHttpOpts, MatrixHttpApi } from "../../src";

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory();
});

describe("RustCrypto", () => {
    const TEST_USER = "@alice:example.com";
    const TEST_DEVICE_ID = "TEST_DEVICE";

    let rustCrypto: RustCrypto;

    beforeEach(async () => {
        const mockHttpApi = {} as MatrixHttpApi<IHttpOpts>;
        rustCrypto = (await initRustCrypto(mockHttpApi, TEST_USER, TEST_DEVICE_ID)) as RustCrypto;
    });

    describe(".exportRoomKeys", () => {
        it("should return a list", async () => {
            const keys = await rustCrypto.exportRoomKeys();
            expect(Array.isArray(keys)).toBeTruthy();
        });
    });
});
