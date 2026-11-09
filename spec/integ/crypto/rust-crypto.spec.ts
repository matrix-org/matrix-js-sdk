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
import { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";

import { createClient } from "../../../src";

vi.setConfig({ testTimeout: 15000 });

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    indexedDB = new IDBFactory();
});

describe("MatrixClient.initRustCrypto", () => {
    it("should raise if userId or deviceId is unknown", async () => {
        const unknownUserClient = createClient({
            baseUrl: "http://test.server",
            deviceId: "aliceDevice",
        });
        await expect(() => unknownUserClient.initRustCrypto()).rejects.toThrow("unknown userId");

        const unknownDeviceClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:test",
        });
        await expect(() => unknownDeviceClient.initRustCrypto()).rejects.toThrow("unknown deviceId");
    });

    it("should create the indexed db", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        // No databases.
        expect(await indexedDB.databases()).toHaveLength(0);

        await matrixClient.initRustCrypto();

        // should have an indexed db now
        const databaseNames = (await indexedDB.databases()).map((db) => db.name);
        expect(databaseNames).toEqual(expect.arrayContaining(["matrix-js-sdk::matrix-sdk-crypto"]));
    });

    it("should create the indexed db with a custom prefix", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        // No databases.
        expect(await indexedDB.databases()).toHaveLength(0);

        await matrixClient.initRustCrypto({ cryptoDatabasePrefix: "my-prefix" });

        // should have an indexed db now
        const databaseNames = (await indexedDB.databases()).map((db) => db.name);
        expect(databaseNames).toEqual(expect.arrayContaining(["my-prefix::matrix-sdk-crypto"]));
    });

    it("should create the meta db if given a storageKey", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        // No databases.
        expect(await indexedDB.databases()).toHaveLength(0);

        await matrixClient.initRustCrypto({ storageKey: new Uint8Array(32) });

        // should have two indexed dbs now
        const databaseNames = (await indexedDB.databases()).map((db) => db.name);
        expect(databaseNames).toEqual(
            expect.arrayContaining(["matrix-js-sdk::matrix-sdk-crypto", "matrix-js-sdk::matrix-sdk-crypto-meta"]),
        );
    });

    it("should create the meta db if given a storagePassword", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        // No databases.
        expect(await indexedDB.databases()).toHaveLength(0);

        await matrixClient.initRustCrypto({ storagePassword: "the cow is on the moon" });

        // should have two indexed dbs now
        const databaseNames = (await indexedDB.databases()).map((db) => db.name);
        expect(databaseNames).toEqual(
            expect.arrayContaining(["matrix-js-sdk::matrix-sdk-crypto", "matrix-js-sdk::matrix-sdk-crypto-meta"]),
        );
    });

    const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIUcP2Ij9JBq8IQfZT5dhNLsbPXYwowDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCVUsxDzANBgNVBAgMBkxvbmRvbjETMBEGA1UECgwKZWxl
bWVudC5pbzEQMA4GA1UEAwwHdGVzdC1jYTAeFw0yNjA0MjcxMzIxMjdaFw0yNzA0
MjcxMzIxMjdaMEUxCzAJBgNVBAYTAlVLMQ8wDQYDVQQIDAZMb25kb24xEzARBgNV
BAoMCmVsZW1lbnQuaW8xEDAOBgNVBAMMB3Rlc3QtY2EwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQD3R1GuEpYIBXuZ47E4Cd6GNuaaUgF9ygRuy1dFgoqY
wRt564jkOYB6Ht5le4R/rb3u6fIeu9j4X2k7DNJPc4H5smHX3ih4BJ5Yli2pzG9S
iUj7dFY69bDA02c4DQP/gjVQddbBUEolPj5L5Ig3a++7zaPloegB/AQ+f9NTceI8
eehVQ2dWZlI45ltVlXPxUI5MFm3iSJ889ogX+OQMSouARm6/4d3VMTHpSkPPKpH0
vgFzn/96/C6yWKz7Fis8lM6MRqd8Ka5O5eZ0hAhVktPkUfgVZKpEsCYNVCBqJgOU
OU8FcMLinK9Zp0k8xZkTBXQbFXsKQNTa9/alX9wi2+c41O9d1MmhkYUwkdNh7OJO
//jbm7E5x//10bVgPB7eEqDUA/M/LzSZPmw/94lOcHRHBJyo0mcP74Bcg+tHydwD
xUe8gETLb7ctrlZ+HXMozoeZLeieR7knlHdFbUyufmpsrs/ONLzkPKqG4nqEjhCi
B+PZLFkRM08677FVDTmHWTN2ARAjhdOGWQBSkoD/0qlNJ3cmaqRl4uApPNRCnEKL
HDLwDNA1AH0Y5RmJX9vblfOdmGNEygpxLQmQ5IsQbJS47orupSNnDToP+IjGheOe
r5e8pWTzGO+ptO1a8GaSurrfWLk5D4wVNp+i0rCU1yBa/vCpaUjmSxEn2sG/SyKX
jQIDAQABo1MwUTAdBgNVHQ4EFgQU2F6Rmhfww1sT23VCfSE3mt8+lhEwHwYDVR0j
BBgwFoAU2F6Rmhfww1sT23VCfSE3mt8+lhEwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAgEAJmUlRR7PrS5EXNy+fToAYkSt4xFlTfOeXN6JdQzCia+x
s5TFtqQe/giphQKLN/i9Mm3w0E0u8WA87TKlaWdrZrCivLEhwvieq0u3XwqY628z
8vlcqJuhM4Soe80AQiL51NeHp0WDhBTWnwCXF/e7GA4xryjg7zqhGZjY8+m61vSd
sLT/N05mSsW/m7ZAwxhe2XBVMXvHNTVuAbHX5+4mX9OXRAbnXg5Cexn1sKONsR1L
kN5VjSSvLmzX4AhV0oIRT23NfWBPJnq2s4S9DFDi2uYqE0BWUR1AZOagaVowFsJQ
q8ccwOQMdZZkAC3h2IIVNzYuFFeXkpZM6Bp7Js9IOJrDCL+A/UsndRkv9gX4SVgd
y9vQQBr5iaI5RTKkEiprnZhKOyBd3X/QpAoPRdhiGeImRpKt8vhF+JetGc2E1o+O
CSDpNjD6uI3SHSKt2mlOfeNoZms1pxY36gNYsytFGXf3qdb1I9cP4GRI6cz4JbmP
Y3eczjaqZMcOaPBBZlYz867C5sZi2tvqT75jlB+rVckKRIEl1bL4EZEpvRbK+nfJ
RFSPEY1fryCthLfa67ThB+IAonX4jU663sLoAQW1FEpJp3q08kKJOoCXlCMZ7g1P
eXmIj7ZEOIsufPdiYuKDp/aUdgUHmuCGyegfoCJze36SdFX5q6z8Aq5nKPtz+FM=
-----END CERTIFICATE-----
`;

    it("should pass on the caCertsPem and sign function if supplied", async () => {
        // Given a Matrix client
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        const initFromStore = vi.spyOn(OlmMachine, "initFromStore");

        const x509Signer = async (item: Uint8Array) => {
            return {
                signature_bytes: item,
                certificate_chain: "MYCHAIN",
                signature_scheme: "RsaPssSha512" as const,
            };
        };

        const x509Validity = () => 12000.3;

        // When we init Rust crypto and pass a PEM for the CA certs
        await matrixClient.initRustCrypto({ caCertsPem: CA_PEM, x509Signer, x509Validity });

        // Then that PEM was passed in to the Olm machine
        expect(initFromStore).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            CA_PEM,
            x509Signer,
            x509Validity,
        );
    });

    // eslint-disable-next-line @vitest/expect-expect
    it("should ignore a second call", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        await matrixClient.initRustCrypto();
        await matrixClient.initRustCrypto();
    });
});

describe("MatrixClient.clearStores", () => {
    it("should clear the indexeddbs", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        await matrixClient.initRustCrypto({ storagePassword: "testKey" });
        expect(await indexedDB.databases()).toHaveLength(2);
        matrixClient.stopClient();

        await matrixClient.clearStores();
        expect(await indexedDB.databases()).toHaveLength(0);
    });

    // eslint-disable-next-line @vitest/expect-expect
    it("should not fail in environments without indexedDB", async () => {
        indexedDB = undefined!;
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        matrixClient.stopClient();

        await matrixClient.clearStores();
        // No error thrown in clearStores
    });

    it("should clear the indexeddbs with a custom prefix", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        // No databases.
        expect(await indexedDB.databases()).toHaveLength(0);

        await matrixClient.initRustCrypto({ cryptoDatabasePrefix: "my-prefix" });
        expect(await indexedDB.databases()).toHaveLength(1);
        matrixClient.stopClient();

        await matrixClient.clearStores({ cryptoDatabasePrefix: "my-prefix" });
        expect(await indexedDB.databases()).toHaveLength(0);
    });
});
