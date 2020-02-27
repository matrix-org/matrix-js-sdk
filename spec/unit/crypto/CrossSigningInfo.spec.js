/*
Copyright 2020 New Vector Ltd
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import '../../olm-loader';
import {
    CrossSigningInfo,
    createCryptoStoreCacheCallbacks,
} from '../../../src/crypto/CrossSigning';
import {
    IndexedDBCryptoStore,
} from '../../../src/crypto/store/indexeddb-crypto-store';
import 'fake-indexeddb/auto';
import 'jest-localstorage-mock';

const userId = "@alice:example.com";

const masterKey = new Uint8Array([
    0xda, 0x5a, 0x27, 0x60, 0xe3, 0x3a, 0xc5, 0x82,
    0x9d, 0x12, 0xc3, 0xbe, 0xe8, 0xaa, 0xc2, 0xef,
    0xae, 0xb1, 0x05, 0xc1, 0xe7, 0x62, 0x78, 0xa6,
    0xd7, 0x1f, 0xf8, 0x2c, 0x51, 0x85, 0xf0, 0x1d,
]);

const badKey = Uint8Array.from(masterKey);
badKey[0] ^= 1;

const masterKeyPub = "nqOvzeuGWT/sRx3h7+MHoInYj3Uk2LD/unI9kDYcHwk";

describe("CrossSigningInfo.getCrossSigningKey()", function() {
    if (!global.Olm) {
        console.warn('Not running megolm backup unit tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return global.Olm.init();
    });

    it("Throws if no callback is provided", async () => {
        const info = new CrossSigningInfo(userId);
        await expect(info.getCrossSigningKey("master")).rejects.toThrow();
    });

    it("Throws if the callback returns falsey", async () => {
        const info = new CrossSigningInfo(userId, {
            getCrossSigningKey: () => false,
        });
        await expect(info.getCrossSigningKey("master")).rejects.toThrow("falsey");
    });

    it("Throws if the expected key doesn't come back", async () => {
        const info = new CrossSigningInfo(userId, {
            getCrossSigningKey: () => masterKeyPub,
        });
        await expect(info.getCrossSigningKey("master", "")).rejects.toThrow();
    });

    it("Returns a key from its callback", async () => {
        const info = new CrossSigningInfo(userId, {
            getCrossSigningKey: () => masterKey,
        });
        const [pubKey, ab] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
        expect(ab).toEqual({a: 106712, b: 106712});
    });

    it("Requests a key from the cache callback (if set) and does not call app" +
         " if one is found", async () => {
        const getCrossSigningKey = jest.fn().mockRejectedValue(
            new Error("Regular callback called"),
        );
        const getCrossSigningKeyCache = jest.fn().mockResolvedValue(masterKey);
        const info = new CrossSigningInfo(
            userId,
            { getCrossSigningKey },
            { getCrossSigningKeyCache },
        );
        const [pubKey] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
        expect(getCrossSigningKeyCache.mock.calls.length).toBe(1);
        expect(getCrossSigningKeyCache.mock. calls[0][0]).toBe("master");
    });

    it("Stores a key with the cache callback (if set)", async () => {
        const getCrossSigningKey = jest.fn().mockResolvedValue(masterKey);
        const storeCrossSigningKeyCache = jest.fn().mockResolvedValue(undefined);
        const info = new CrossSigningInfo(
            userId,
            { getCrossSigningKey },
            { storeCrossSigningKeyCache },
        );
        const [pubKey] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
        expect(storeCrossSigningKeyCache.mock.calls.length).toEqual(1);
        expect(storeCrossSigningKeyCache.mock.calls[0][0]).toBe("master");
        expect(storeCrossSigningKeyCache.mock.calls[0][1]).toBe(masterKey);
    });

    it("Does not store a bad key to the cache", async () => {
        const getCrossSigningKey = jest.fn().mockResolvedValue(badKey);
        const storeCrossSigningKeyCache = jest.fn().mockResolvedValue(undefined);
        const info = new CrossSigningInfo(
            userId,
            { getCrossSigningKey },
            { storeCrossSigningKeyCache },
        );
        await expect(info.getCrossSigningKey("master", masterKeyPub)).rejects.toThrow();
        expect(storeCrossSigningKeyCache.mock.calls.length).toEqual(0);
    });

    it("Does not store a value to the cache if it came from the cache", async () => {
        const getCrossSigningKey = jest.fn().mockRejectedValue(
            new Error("Regular callback called"),
        );
        const getCrossSigningKeyCache = jest.fn().mockResolvedValue(masterKey);
        const storeCrossSigningKeyCache = jest.fn().mockRejectedValue(
            new Error("Tried to store a value from cache"),
        );
        const info = new CrossSigningInfo(
            userId,
            { getCrossSigningKey },
            { getCrossSigningKeyCache, storeCrossSigningKeyCache },
        );
        expect(storeCrossSigningKeyCache.mock.calls.length).toBe(0);
        const [pubKey] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
    });

    it("Requests a key from the cache callback (if set) and then calls app " +
         "if one is not found", async () => {
        const getCrossSigningKey = jest.fn().mockResolvedValue(masterKey);
        const getCrossSigningKeyCache = jest.fn().mockResolvedValue(undefined);
        const storeCrossSigningKeyCache = jest.fn();
        const info = new CrossSigningInfo(
            userId,
            { getCrossSigningKey },
            { getCrossSigningKeyCache, storeCrossSigningKeyCache },
        );
        const [pubKey] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
        expect(getCrossSigningKey.mock.calls.length).toBe(1);
        expect(getCrossSigningKeyCache.mock.calls.length).toBe(1);

        /* Also expect that the cache gets updated */
        expect(storeCrossSigningKeyCache.mock.calls.length).toBe(1);
    });

    it("Requests a key from the cache callback (if set) and then calls app if " +
         "that key doesn't match", async () => {
        const getCrossSigningKey = jest.fn().mockResolvedValue(masterKey);
        const getCrossSigningKeyCache = jest.fn().mockResolvedValue(badKey);
        const storeCrossSigningKeyCache = jest.fn();
        const info = new CrossSigningInfo(
            userId,
            { getCrossSigningKey },
            { getCrossSigningKeyCache, storeCrossSigningKeyCache },
        );
        const [pubKey] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
        expect(getCrossSigningKey.mock.calls.length).toBe(1);
        expect(getCrossSigningKeyCache.mock.calls.length).toBe(1);

        /* Also expect that the cache gets updated */
        expect(storeCrossSigningKeyCache.mock.calls.length).toBe(1);
    });
});

/* XXX/TODO: MemoryStore isn't tested
 * But that's because at time of writing, MemoryStore probably never gets used ever.
 */
describe.each([
    [global.indexedDB],
    [undefined],
])("CrossSigning > createCryptoStoreCacheCallbacks", function(db) {
    let store;

    beforeAll(() => {
        store = new IndexedDBCryptoStore(db, "tests");
    });

    beforeEach(async () => {
        await store.deleteAllData();
    });

    it("Caches data to the store and retrieves it", async () => {
        const { getCrossSigningKeyCache, storeCrossSigningKeyCache } =
          createCryptoStoreCacheCallbacks(store);
        await storeCrossSigningKeyCache("master", masterKey);

        // If we've not saved anything, don't expect anything
        // Definitely don't accidentally return the wrong key for the type
        const nokey = await getCrossSigningKeyCache("self", "");
        expect(nokey).toBeNull();

        const key = await getCrossSigningKeyCache("master", "");
        expect(key).toEqual(masterKey);
    });
});
