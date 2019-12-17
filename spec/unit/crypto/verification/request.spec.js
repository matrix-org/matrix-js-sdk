/*
Copyright 2019 New Vector Ltd
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
import "../../../olm-loader";
import {verificationMethods} from "../../../../src/crypto";
import {logger} from "../../../../src/logger";
import {SAS} from "../../../../src/crypto/verification/SAS";
import {makeTestClients} from './util';

const Olm = global.Olm;

describe("verification request", function() {
    if (!global.Olm) {
        logger.warn('Not running device verification unit tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return Olm.init();
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
        alice.client._crypto._deviceList.getRawStoredDevicesForUser = function() {
            return {
                Dynabook: {
                    keys: {
                        "ed25519:Dynabook": "bob+base64+ed25519+key",
                    },
                },
            };
        };
        alice.client.downloadKeys = () => {
            return Promise.resolve();
        };
        bob.client.downloadKeys = () => {
            return Promise.resolve();
        };
        bob.client.on("crypto.verification.request", (request) => {
            const bobVerifier = request.beginKeyVerification(verificationMethods.SAS);
            bobVerifier.verify();

            // XXX: Private function access (but it's a test, so we're okay)
            bobVerifier._endTimer();
        });
        const aliceVerifier = await alice.client.requestVerification("@bob:example.com");
        expect(aliceVerifier).toBeInstanceOf(SAS);

        // XXX: Private function access (but it's a test, so we're okay)
        aliceVerifier._endTimer();
    });
});
