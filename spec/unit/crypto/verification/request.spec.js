/*
Copyright 2019 New Vector Ltd

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

try {
    global.Olm = require('olm');
} catch (e) {
    console.warn("unable to run device verification tests: libolm not available");
}

import expect from 'expect';

import {verificationMethods} from '../../../../lib/crypto';

import SAS from '../../../../lib/crypto/verification/SAS';

const Olm = global.Olm;

import {makeTestClients} from './util';

describe("verification request", function() {
    if (!global.Olm) {
        console.warn('Not running device verification unit tests: libolm not present');
        return;
    }

    beforeEach(async function() {
        await Olm.init();
    });

    it("should request and accept a verification", async function() {
        const [alice, bob] = await makeTestClients(
            [
                {userId: "@alice:example.com", deviceId: "Osborne2"},
                {userId: "@bob:example.com", deviceId: "Dynabook"},
            ],
            {
                verificationMethods: [verificationMethods.SAS],
            },
        );
        alice._crypto._deviceList.getRawStoredDevicesForUser = function() {
            return {
                Dynabook: {
                    keys: {
                        "ed25519:Dynabook": "bob+base64+ed25519+key",
                    },
                },
            };
        };
        alice.downloadKeys = () => {
            return Promise.resolve();
        };
        bob.downloadKeys = () => {
            return Promise.resolve();
        };
        bob.on("crypto.verification.request", (request) => {
            const bobVerifier = request.beginKeyVerification(verificationMethods.SAS);
            bobVerifier.verify();
        });
        const aliceVerifier = await alice.requestVerification("@bob:example.com");
        expect(aliceVerifier).toBeAn(SAS);
    });
});
