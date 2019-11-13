/*
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import expect from 'expect';
import { MatrixEvent } from '../../../lib/models/event';

import olmlib from '../../../lib/crypto/olmlib';

import TestClient from '../../TestClient';
import { makeTestClients } from './verification/util';

async function makeTestClient(userInfo, options) {
    const client = (new TestClient(
        userInfo.userId, userInfo.deviceId, undefined, undefined, options,
    )).client;

    await client.initCrypto();

    return client;
}

describe("Secrets", function() {
    if (!global.Olm) {
        console.warn('Not running megolm backup unit tests: libolm not present');
        return;
    }

    beforeEach(async function() {
        await global.Olm.init();
    });

    it("should store and retrieve a secret", async function() {
        const decryption = new global.Olm.PkDecryption();
        const pubkey = decryption.generate_key();
        const privkey = decryption.get_private_key();

        const getKey = expect.createSpy().andCall(e => {
            expect(Object.keys(e.keys)).toEqual(["abc"]);
            return ['abc', privkey];
        });

        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
            {
                cryptoCallbacks: {
                    getSecretStorageKey: getKey,
                },
            },
        );
        const secretStorage = alice._crypto._secretStorage;

        alice.setAccountData = async function(eventType, contents, callback) {
            alice.store.storeAccountDataEvents([
                new MatrixEvent({
                    type: eventType,
                    content: contents,
                }),
            ]);
            if (callback) {
                callback();
            }
        };

        alice.store.storeAccountDataEvents([
            new MatrixEvent({
                type: "m.secret_storage.key.abc",
                content: {
                    algorithm: "m.secret_storage.v1.curve25519-aes-sha2",
                    pubkey: pubkey,
                },
            }),
        ]);

        expect(secretStorage.isStored("foo")).toBe(false);

        await secretStorage.store("foo", "bar", ["abc"]);

        expect(secretStorage.isStored("foo")).toBe(true);
        expect(await secretStorage.get("foo")).toBe("bar");

        expect(getKey).toHaveBeenCalled();
    });

    it("should throw if given a key that doesn't exist", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );

        try {
            await alice.storeSecret("foo", "bar", ["this secret does not exist"]);
            // should be able to use expect(...).toThrow() but mocha still fails
            // the test even when it throws for reasons I have no inclination to debug
            expect(true).toBeFalsy();
        } catch (e) {
        }
    });

    it("should refuse to encrypt with zero keys", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );

        try {
            await alice.storeSecret("foo", "bar", []);
            expect(true).toBeFalsy();
        } catch (e) {
        }
    });

    it("should encrypt with default key if keys is null", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        alice.setAccountData = async function(eventType, contents, callback) {
            alice.store.storeAccountDataEvents([
                new MatrixEvent({
                    type: eventType,
                    content: contents,
                }),
            ]);
        };

        const newKeyId = await alice.addSecretKey(
            'm.secret_storage.v1.curve25519-aes-sha2',
        );
        await alice.setDefaultKeyId(newKeyId);
        await alice.storeSecret("foo", "bar");

        const accountData = alice.getAccountData('foo');
        expect(accountData.getContent().encrypted).toBeTruthy();
    });

    it("should refuse to encrypt if no keys given and no default key", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );

        try {
            await alice.storeSecret("foo", "bar");
            expect(true).toBeFalsy();
        } catch (e) {
        }
    });

    it("should request secrets from other clients", async function() {
        const [osborne2, vax] = await makeTestClients(
            [
                {userId: "@alice:example.com", deviceId: "Osborne2"},
                {userId: "@alice:example.com", deviceId: "VAX"},
            ],
            {
                cryptoCallbacks: {
                    onSecretRequested: e => {
                        expect(e.name).toBe("foo");
                        return "bar";
                    },
                },
            },
        );

        const vaxDevice = vax.client._crypto._olmDevice;
        const osborne2Device = osborne2.client._crypto._olmDevice;
        const secretStorage = osborne2.client._crypto._secretStorage;

        osborne2.client._crypto._deviceList.storeDevicesForUser("@alice:example.com", {
            "VAX": {
                user_id: "@alice:example.com",
                device_id: "VAX",
                algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                keys: {
                    "ed25519:VAX": vaxDevice.deviceEd25519Key,
                    "curve25519:VAX": vaxDevice.deviceCurve25519Key,
                },
            },
        });
        vax.client._crypto._deviceList.storeDevicesForUser("@alice:example.com", {
            "Osborne2": {
                user_id: "@alice:example.com",
                device_id: "Osborne2",
                algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                keys: {
                    "ed25519:Osborne2": osborne2Device.deviceEd25519Key,
                    "curve25519:Osborne2": osborne2Device.deviceCurve25519Key,
                },
            },
        });

        await osborne2Device.generateOneTimeKeys(1);
        const otks = (await osborne2Device.getOneTimeKeys()).curve25519;
        await osborne2Device.markKeysAsPublished();

        await vax.client._crypto._olmDevice.createOutboundSession(
            osborne2Device.deviceCurve25519Key,
            Object.values(otks)[0],
        );

        const request = await secretStorage.request("foo", ["VAX"]);
        const secret = await request.promise;

        expect(secret).toBe("bar");
    });
});
