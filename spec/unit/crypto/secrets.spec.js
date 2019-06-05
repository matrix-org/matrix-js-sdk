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
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        const secretStorage = alice._crypto._secretStorage;

        const decryption = new global.Olm.PkDecryption();
        const pubkey = decryption.generate_key();
        const privkey = decryption.get_private_key();

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

        const getKey = expect.createSpy().andCall(function(e) {
            expect(Object.keys(e.keys)).toEqual(["abc"]);
            e.done("abc", privkey);
        });
        alice.once("crypto.secrets.getKey", getKey);

        expect(await secretStorage.get("foo")).toBe("bar");

        expect(getKey).toHaveBeenCalled();
    });

    it("should request secrets from other clients", async function() {
        const [osborne2, vax] = await makeTestClients(
            [
                {userId: "@alice:example.com", deviceId: "Osborne2"},
                {userId: "@alice:example.com", deviceId: "VAX"},
            ],
        );

        const vaxDevice = vax._crypto._olmDevice;
        const osborne2Device = osborne2._crypto._olmDevice;
        const secretStorage = osborne2._crypto._secretStorage;

        osborne2._crypto._deviceList.storeDevicesForUser("@alice:example.com", {
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
        vax._crypto._deviceList.storeDevicesForUser("@alice:example.com", {
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

        vax.once("crypto.secrets.request", function(e) {
            expect(e.name).toBe("foo");
            e.send("bar");
        });

        await osborne2Device.generateOneTimeKeys(1);
        const otks = (await osborne2Device.getOneTimeKeys()).curve25519;
        await osborne2Device.markKeysAsPublished();

        await vax._crypto._olmDevice.createOutboundSession(
            osborne2Device.deviceCurve25519Key,
            Object.values(otks)[0],
        );

        const request = await secretStorage.request("foo", ["VAX"]);
        const secret = await request.promise;

        expect(secret).toBe("bar");
    });
});
