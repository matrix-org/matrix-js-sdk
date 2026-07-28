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
import fetchMock from "@fetch-mock/vitest";
import { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";

import { createClient, IndexedDBCryptoStore } from "../../../src";
import { populateStore } from "../../test-utils/test_indexeddb_cryptostore_dump";
import { MSK_NOT_CACHED_DATASET } from "../../test-utils/test_indexeddb_cryptostore_dump/no_cached_msk_dump";
import { IDENTITY_NOT_TRUSTED_DATASET } from "../../test-utils/test_indexeddb_cryptostore_dump/unverified";
import { FULL_ACCOUNT_DATASET } from "../../test-utils/test_indexeddb_cryptostore_dump/full_account";
import { EMPTY_ACCOUNT_DATASET } from "../../test-utils/test_indexeddb_cryptostore_dump/empty_account";
import { CryptoEvent } from "../../../src/crypto-api";

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

    it("should pass on the caCertsPem if supplied", async () => {
        // Given a Matrix client
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        const initFromStore = vi.spyOn(OlmMachine, "initFromStore");

        // When we init Rust crypto and pass a PEM for the CA certs
        await matrixClient.initRustCrypto({ caCertsPem: CA_PEM });

        // Then that PEM was passed in to the Olm machine
        expect(initFromStore).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            CA_PEM,
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

    describe("Libolm Migration", () => {
        it("should migrate from libolm", async () => {
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", FULL_ACCOUNT_DATASET.backupResponse);

            fetchMock.post("path:/_matrix/client/v3/keys/query", FULL_ACCOUNT_DATASET.keyQueryResponse);

            const testStoreName = "test-store";
            await populateStore(testStoreName, FULL_ACCOUNT_DATASET.dumpPath);
            const cryptoStore = new IndexedDBCryptoStore(indexedDB, testStoreName);

            const matrixClient = createClient({
                baseUrl: "http://test.server",
                userId: FULL_ACCOUNT_DATASET.userId,
                deviceId: FULL_ACCOUNT_DATASET.deviceId,
                cryptoStore,
                pickleKey: FULL_ACCOUNT_DATASET.pickleKey,
            });

            const progressListener = vi.fn();
            matrixClient.addListener(CryptoEvent.LegacyCryptoStoreMigrationProgress, progressListener);

            await matrixClient.initRustCrypto();

            const verificationStatus = await matrixClient
                .getCrypto()!
                .getDeviceVerificationStatus(FULL_ACCOUNT_DATASET.userId, FULL_ACCOUNT_DATASET.deviceId);

            // Check that the current device and identity trust is migrated correctly just after migration
            expect(verificationStatus).toBeDefined();
            expect(verificationStatus!.crossSigningVerified).toEqual(true);
            expect(verificationStatus!.signedByOwner).toEqual(true);

            // Do some basic checks on the imported data
            const deviceKeys = await matrixClient.getCrypto()!.getOwnDeviceKeys();
            expect(deviceKeys.curve25519).toEqual("LKv0bKbc0EC4h0jknbemv3QalEkeYvuNeUXVRgVVTTU");
            expect(deviceKeys.ed25519).toEqual("qK70DEqIXq7T+UU3v/al47Ab4JkMEBLpNrTBMbS5rrw");

            expect(await matrixClient.getCrypto()!.getActiveSessionBackupVersion()).toEqual("7");

            expect(await matrixClient.getCrypto()!.isEncryptionEnabledInRoom("!CWLUCoEWXSFyTCOtfL:matrix.org")).toBe(
                true,
            );

            // check the progress callback
            expect(progressListener.mock.calls.length).toBeGreaterThan(50);

            // The first call should have progress == 0
            const [firstProgress, totalSteps] = progressListener.mock.calls[0];
            expect(totalSteps).toBeGreaterThan(3000);
            expect(firstProgress).toEqual(0);

            for (let i = 1; i < progressListener.mock.calls.length - 1; i++) {
                const [progress, total] = progressListener.mock.calls[i];
                expect(total).toEqual(totalSteps);
                expect(progress).toBeGreaterThan(progressListener.mock.calls[i - 1][0]);
                expect(progress).toBeLessThanOrEqual(totalSteps);
            }

            // The final call should have progress == total == -1
            expect(progressListener).toHaveBeenLastCalledWith(-1, -1);
        }, 60000);

        describe("Private key backup migration", () => {
            it("should not migrate the backup private key if backup has changed", async () => {
                // Here we have a new backup server side, and the migrated account has the previous backup key.
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", MSK_NOT_CACHED_DATASET.newBackupResponse);

                fetchMock.post("path:/_matrix/client/v3/keys/query", MSK_NOT_CACHED_DATASET.keyQueryResponse);

                await populateStore("test-store", MSK_NOT_CACHED_DATASET.dumpPath);
                const cryptoStore = new IndexedDBCryptoStore(indexedDB, "test-store");

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: MSK_NOT_CACHED_DATASET.userId,
                    deviceId: MSK_NOT_CACHED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: MSK_NOT_CACHED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const privateBackupKey = await matrixClient.getCrypto()?.getSessionBackupPrivateKey();
                expect(privateBackupKey).toBeNull();
            });

            it("should not migrate the backup private key if backup has unknown algorithm", async () => {
                // Here we have a new backup server side, and the migrated account has the previous backup key.
                const backupResponse = {
                    ...MSK_NOT_CACHED_DATASET.backupResponse,
                    algorithm: "m.megolm_backup.v8",
                };
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", backupResponse);

                fetchMock.post("path:/_matrix/client/v3/keys/query", MSK_NOT_CACHED_DATASET.keyQueryResponse);

                await populateStore("test-store", MSK_NOT_CACHED_DATASET.dumpPath);
                const cryptoStore = new IndexedDBCryptoStore(indexedDB, "test-store");

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: MSK_NOT_CACHED_DATASET.userId,
                    deviceId: MSK_NOT_CACHED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: MSK_NOT_CACHED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const privateBackupKey = await matrixClient.getCrypto()?.getSessionBackupPrivateKey();
                expect(privateBackupKey).toBeNull();
            });

            it("should not migrate the backup private key if the backup has been deleted", async () => {
                // The old backup has been deleted server side.
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                    status: 404,
                    body: {
                        errcode: "M_NOT_FOUND",
                        error: "No backup found",
                    },
                });

                fetchMock.post("path:/_matrix/client/v3/keys/query", MSK_NOT_CACHED_DATASET.keyQueryResponse);

                await populateStore("test-store", MSK_NOT_CACHED_DATASET.dumpPath);
                const cryptoStore = new IndexedDBCryptoStore(indexedDB, "test-store");

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: MSK_NOT_CACHED_DATASET.userId,
                    deviceId: MSK_NOT_CACHED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: MSK_NOT_CACHED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const privateBackupKey = await matrixClient.getCrypto()?.getSessionBackupPrivateKey();
                expect(privateBackupKey).toBeNull();
            });

            it("should migrate the backup private key if the backup matches", async () => {
                // The old backup has been deleted server side.
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", MSK_NOT_CACHED_DATASET.backupResponse);

                fetchMock.post("path:/_matrix/client/v3/keys/query", MSK_NOT_CACHED_DATASET.keyQueryResponse);

                await populateStore("test-store", MSK_NOT_CACHED_DATASET.dumpPath);
                const cryptoStore = new IndexedDBCryptoStore(indexedDB, "test-store");

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: MSK_NOT_CACHED_DATASET.userId,
                    deviceId: MSK_NOT_CACHED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: MSK_NOT_CACHED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const privateBackupKey = await matrixClient.getCrypto()?.getSessionBackupPrivateKey();
                expect(privateBackupKey).toBeDefined();
            });
        });

        it("should not migrate if account data is missing", async () => {
            // See https://github.com/element-hq/element-web/issues/27447

            // Given we have an almost-empty legacy account in the database
            fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                status: 404,
                body: { errcode: "M_NOT_FOUND", error: "No backup found" },
            });
            fetchMock.post("path:/_matrix/client/v3/keys/query", EMPTY_ACCOUNT_DATASET.keyQueryResponse);

            const testStoreName = "test-store";
            await populateStore(testStoreName, EMPTY_ACCOUNT_DATASET.dumpPath);
            const cryptoStore = new IndexedDBCryptoStore(indexedDB, testStoreName);

            const matrixClient = createClient({
                baseUrl: "http://test.server",
                userId: EMPTY_ACCOUNT_DATASET.userId,
                deviceId: EMPTY_ACCOUNT_DATASET.deviceId,
                cryptoStore,
                pickleKey: EMPTY_ACCOUNT_DATASET.pickleKey,
            });

            // When we start Rust crypto, potentially triggering an upgrade
            const progressListener = vi.fn();
            matrixClient.addListener(CryptoEvent.LegacyCryptoStoreMigrationProgress, progressListener);

            await matrixClient.initRustCrypto();

            // Then no error occurs, and no upgrade happens
            expect(progressListener.mock.calls.length).toBe(0);
        }, 60000);

        describe("Legacy trust migration", () => {
            async function populateAndStartLegacyCryptoStore(dumpPath: string): Promise<IndexedDBCryptoStore> {
                const testStoreName = "test-store";
                await populateStore(testStoreName, dumpPath);
                const cryptoStore = new IndexedDBCryptoStore(indexedDB, testStoreName);
                await cryptoStore.startup();
                return cryptoStore;
            }

            it("should not revert to untrusted if legacy was trusted but msk not in cache, big account", async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                    status: 404,
                    body: {
                        errcode: "M_NOT_FOUND",
                        error: "No backup found",
                    },
                });

                fetchMock.post("path:/_matrix/client/v3/keys/query", FULL_ACCOUNT_DATASET.keyQueryResponse);

                const cryptoStore = await populateAndStartLegacyCryptoStore(FULL_ACCOUNT_DATASET.dumpPath);

                // Remove the master key from the cache
                await cryptoStore.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) => {
                    const objectStore = txn.objectStore("account");
                    objectStore.delete(`ssss_cache:master`);
                });

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: FULL_ACCOUNT_DATASET.userId,
                    deviceId: FULL_ACCOUNT_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: FULL_ACCOUNT_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const verificationStatus = await matrixClient
                    .getCrypto()!
                    .getUserVerificationStatus(FULL_ACCOUNT_DATASET.userId);

                expect(verificationStatus.isCrossSigningVerified()).toBe(true);
            }, 60000);

            it("should not revert to untrusted if legacy was trusted but msk not in cache", async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", MSK_NOT_CACHED_DATASET.backupResponse);

                fetchMock.post("path:/_matrix/client/v3/keys/query", MSK_NOT_CACHED_DATASET.keyQueryResponse);

                const cryptoStore = await populateAndStartLegacyCryptoStore(MSK_NOT_CACHED_DATASET.dumpPath);

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: MSK_NOT_CACHED_DATASET.userId,
                    deviceId: MSK_NOT_CACHED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: MSK_NOT_CACHED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const verificationStatus = await matrixClient
                    .getCrypto()!
                    .getUserVerificationStatus("@migration:localhost");

                expect(verificationStatus.isCrossSigningVerified()).toBe(true);
            });

            it("should not migrate local trust if key has changed", async () => {
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", MSK_NOT_CACHED_DATASET.backupResponse);

                fetchMock.post("path:/_matrix/client/v3/keys/query", MSK_NOT_CACHED_DATASET.rotatedKeyQueryResponse);

                const cryptoStore = await populateAndStartLegacyCryptoStore(MSK_NOT_CACHED_DATASET.dumpPath);

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: MSK_NOT_CACHED_DATASET.userId,
                    deviceId: MSK_NOT_CACHED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: MSK_NOT_CACHED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const verificationStatus = await matrixClient
                    .getCrypto()!
                    .getUserVerificationStatus("@migration:localhost");

                expect(verificationStatus.isCrossSigningVerified()).toBe(false);
            });

            it("should not migrate local trust if was not trusted in legacy", async () => {
                // Just 404 here for the test
                fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
                    status: 404,
                    body: {
                        errcode: "M_NOT_FOUND",
                        error: "No backup found",
                    },
                });

                fetchMock.post("path:/_matrix/client/v3/keys/query", IDENTITY_NOT_TRUSTED_DATASET.keyQueryResponse);

                const cryptoStore = await populateAndStartLegacyCryptoStore(IDENTITY_NOT_TRUSTED_DATASET.dumpPath);

                const matrixClient = createClient({
                    baseUrl: "http://test.server",
                    userId: IDENTITY_NOT_TRUSTED_DATASET.userId,
                    deviceId: IDENTITY_NOT_TRUSTED_DATASET.deviceId,
                    cryptoStore,
                    pickleKey: IDENTITY_NOT_TRUSTED_DATASET.pickleKey,
                });

                await matrixClient.initRustCrypto();

                const verificationStatus = await matrixClient
                    .getCrypto()!
                    .getUserVerificationStatus("@untrusted:localhost");

                expect(verificationStatus.isCrossSigningVerified()).toBe(false);
            });
        });
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
