/*
Copyright 2018,2019 New Vector Ltd

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

import '../../../olm-loader';

import expect from 'expect';
import MemoryCryptoStore from '../../../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../../../MockStorageApi';
import testUtils from '../../../test-utils';

import OlmDevice from '../../../../lib/crypto/OlmDevice';
import olmlib from '../../../../lib/crypto/olmlib';
import DeviceInfo from '../../../../lib/crypto/deviceinfo';

function makeOlmDevice() {
    const mockStorage = new MockStorageApi();
    const cryptoStore = new MemoryCryptoStore(mockStorage);
    const olmDevice = new OlmDevice(cryptoStore);
    return olmDevice;
}

async function setupSession(initiator, opponent) {
    await opponent.generateOneTimeKeys(1);
    const keys = await opponent.getOneTimeKeys();
    const firstKey = Object.values(keys['curve25519'])[0];

    const sid = await initiator.createOutboundSession(
        opponent.deviceCurve25519Key, firstKey,
    );
    return sid;
}

describe("OlmDecryption", function() {
    if (!global.Olm) {
        console.warn('Not running megolm unit tests: libolm not present');
        return;
    }

    let aliceOlmDevice;
    let bobOlmDevice;

    beforeEach(async function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        await global.Olm.init();

        aliceOlmDevice = makeOlmDevice();
        bobOlmDevice = makeOlmDevice();
        await aliceOlmDevice.init();
        await bobOlmDevice.init();
    });

    describe('olm', function() {
        it("can decrypt messages", async function() {
            const sid = await setupSession(aliceOlmDevice, bobOlmDevice);

            const ciphertext = await aliceOlmDevice.encryptMessage(
                bobOlmDevice.deviceCurve25519Key,
                sid,
                "The olm or proteus is an aquatic salamander in the family Proteidae",
            );

            const result = await bobOlmDevice.createInboundSession(
                aliceOlmDevice.deviceCurve25519Key,
                ciphertext.type,
                ciphertext.body,
            );
            expect(result.payload).toEqual(
                "The olm or proteus is an aquatic salamander in the family Proteidae",
            );
        });

        it("creates only one session at a time", async function() {
            // if we call ensureOlmSessionsForDevices multiple times, it should
            // only try to create one session at a time, even if the server is
            // slow
            let count = 0;
            const baseApis = {
                claimOneTimeKeys: () => {
                    // simulate a very slow server (.5 seconds to respond)
                    count++;
                    return new Promise((resolve, reject) => {
                        setTimeout(reject, 500);
                    });
                },
            };
            const devicesByUser = {
                "@bob:example.com": [
                    DeviceInfo.fromStorage({
                        keys: {
                            "curve25519:ABCDEFG": "akey",
                        },
                    }, "ABCDEFG"),
                ],
            };
            function alwaysSucceed(promise) {
                // swallow any exception thrown by a promise, so that
                // Promise.all doesn't abort
                return promise.catch(() => {});
            }

            // start two tasks that try to ensure that there's an olm session
            const promises = Promise.all([
                alwaysSucceed(olmlib.ensureOlmSessionsForDevices(
                    aliceOlmDevice, baseApis, devicesByUser,
                )),
                alwaysSucceed(olmlib.ensureOlmSessionsForDevices(
                    aliceOlmDevice, baseApis, devicesByUser,
                )),
            ]);

            await new Promise((resolve) => {
                setTimeout(resolve, 200);
            });

            // after .2s, both tasks should have started, but one should be
            // waiting on the other before trying to create a session, so
            // claimOneTimeKeys should have only been called once
            expect(count).toBe(1);

            await promises;

            // after waiting for both tasks to complete, the first task should
            // have failed, so the second task should have tried to create a
            // new session and will have called claimOneTimeKeys
            expect(count).toBe(2);
        });
    });
});
