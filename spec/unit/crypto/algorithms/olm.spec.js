/*
Copyright 2018 New Vector Ltd

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
import WebStorageSessionStore from '../../../../lib/store/session/webstorage';
import MemoryCryptoStore from '../../../../lib/crypto/store/memory-crypto-store.js';
import MockStorageApi from '../../../MockStorageApi';
import testUtils from '../../../test-utils';

import OlmDevice from '../../../../lib/crypto/OlmDevice';

function makeOlmDevice() {
    const mockStorage = new MockStorageApi();
    const sessionStore = new WebStorageSessionStore(mockStorage);
    const cryptoStore = new MemoryCryptoStore(mockStorage);
    const olmDevice = new OlmDevice(sessionStore, cryptoStore);
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
    });
});
