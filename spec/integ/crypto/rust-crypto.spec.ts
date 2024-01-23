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
import fetchMock from "fetch-mock-jest";

import { createClient, CryptoEvent, IndexedDBCryptoStore } from "../../../src";
import { populateStore } from "../../test-utils/test_indexeddb_cryptostore_dump";

jest.setTimeout(15000);

afterEach(() => {
    // reset fake-indexeddb after each test, to make sure we don't leak connections
    // cf https://github.com/dumbmatter/fakeIndexedDB#wipingresetting-the-indexeddb-for-a-fresh-state
    // eslint-disable-next-line no-global-assign
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

    it("should create the meta db if given a pickleKey", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
            pickleKey: "testKey",
        });

        // No databases.
        expect(await indexedDB.databases()).toHaveLength(0);

        await matrixClient.initRustCrypto();

        // should have two indexed dbs now
        const databaseNames = (await indexedDB.databases()).map((db) => db.name);
        expect(databaseNames).toEqual(
            expect.arrayContaining(["matrix-js-sdk::matrix-sdk-crypto", "matrix-js-sdk::matrix-sdk-crypto-meta"]),
        );
    });

    it("should ignore a second call", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        await matrixClient.initRustCrypto();
        await matrixClient.initRustCrypto();
    });

    it("should migrate from libolm", async () => {
        fetchMock.get("path:/_matrix/client/v3/room_keys/version", {
            auth_data: {
                public_key: "q+HZiJdHl2Yopv9GGvv7EYSzDMrAiRknK4glSdoaomI",
                signatures: {
                    "@vdhtest200713:matrix.org": {
                        "ed25519:gh9fGr39eNZUdWynEMJ/q/WZq/Pk/foFxHXFBFm18ZI":
                            "reDp6Mu+j+tfUL3/T6f5OBT3N825Lzpc43vvG+RvjX6V+KxXzodBQArgCoeEHLtL9OgSBmNrhTkSOX87MWCKAw",
                        "ed25519:KMFSTJSMLB":
                            "F8tyV5W6wNi0GXTdSg+gxSCULQi0EYxdAAqfkyNq58KzssZMw5i+PRA0aI2b+D7NH/aZaJrtiYNHJ0gWLSQvAw",
                    },
                },
            },
            version: "7",
            algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
            etag: "1",
            count: 79,
        });

        const testStoreName = "test-store";
        await populateStore(testStoreName);
        const cryptoStore = new IndexedDBCryptoStore(indexedDB, testStoreName);

        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@vdhtest200713:matrix.org",
            deviceId: "KMFSTJSMLB",
            cryptoStore,
            pickleKey: "+1k2Ppd7HIisUY824v7JtV3/oEE4yX0TqtmNPyhaD7o",
        });

        const progressListener = jest.fn();
        matrixClient.addListener(CryptoEvent.LegacyCryptoStoreMigrationProgress, progressListener);

        await matrixClient.initRustCrypto();

        // Do some basic checks on the imported data
        const deviceKeys = await matrixClient.getCrypto()!.getOwnDeviceKeys();
        expect(deviceKeys.curve25519).toEqual("LKv0bKbc0EC4h0jknbemv3QalEkeYvuNeUXVRgVVTTU");
        expect(deviceKeys.ed25519).toEqual("qK70DEqIXq7T+UU3v/al47Ab4JkMEBLpNrTBMbS5rrw");

        expect(await matrixClient.getCrypto()!.getActiveSessionBackupVersion()).toEqual("7");

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
});

describe("MatrixClient.clearStores", () => {
    it("should clear the indexeddbs", async () => {
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
            pickleKey: "testKey",
        });

        await matrixClient.initRustCrypto();
        expect(await indexedDB.databases()).toHaveLength(2);
        await matrixClient.stopClient();

        await matrixClient.clearStores();
        expect(await indexedDB.databases()).toHaveLength(0);
    });

    it("should not fail in environments without indexedDB", async () => {
        // eslint-disable-next-line no-global-assign
        indexedDB = undefined!;
        const matrixClient = createClient({
            baseUrl: "http://test.server",
            userId: "@alice:localhost",
            deviceId: "aliceDevice",
        });

        await matrixClient.stopClient();

        await matrixClient.clearStores();
        // No error thrown in clearStores
    });
});
