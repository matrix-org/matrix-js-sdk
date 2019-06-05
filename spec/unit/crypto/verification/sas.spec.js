/*
Copyright 2018-2019 New Vector Ltd

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
import logger from '../../../../src/logger';

try {
    global.Olm = require('olm');
} catch (e) {
    logger.warn("unable to run device verification tests: libolm not available");
}

import expect from 'expect';
import olmlib from '../../../../lib/crypto/olmlib';

import sdk from '../../../..';

import {verificationMethods} from '../../../../lib/crypto';
import DeviceInfo from '../../../../lib/crypto/deviceinfo';

import SAS from '../../../../lib/crypto/verification/SAS';

const Olm = global.Olm;

const MatrixEvent = sdk.MatrixEvent;

import {makeTestClients} from './util';

describe("SAS verification", function() {
    if (!global.Olm) {
        logger.warn('Not running device verification unit tests: libolm not present');
        return;
    }

    beforeEach(async function() {
        await Olm.init();
    });

    it("should error on an unexpected event", async function() {
        const sas = new SAS({}, "@alice:example.com", "ABCDEFG");
        sas.handleEvent(new MatrixEvent({
            sender: "@alice:example.com",
            type: "es.inquisition",
            content: {},
        }));
        const spy = expect.createSpy();
        await sas.verify()
            .catch(spy);
        expect(spy).toHaveBeenCalled();
    });

    describe("verification", function() {
        let alice;
        let bob;
        let aliceSasEvent;
        let bobSasEvent;
        let aliceVerifier;
        let bobPromise;

        beforeEach(async function() {
            [alice, bob] = await makeTestClients(
                [
                    {userId: "@alice:example.com", deviceId: "Osborne2"},
                    {userId: "@bob:example.com", deviceId: "Dynabook"},
                ],
                {
                    verificationMethods: [verificationMethods.SAS],
                },
            );

            const aliceDevice = alice._crypto._olmDevice;
            const bobDevice = bob._crypto._olmDevice;

            alice._crypto._deviceList.storeDevicesForUser("@bob:example.com", {
                Dynabook: {
                    user_id: "@bob:example.com",
                    device_id: "Dynabook",
                    algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                    keys: {
                        "ed25519:Dynabook": bobDevice.deviceEd25519Key,
                        "curve25519:Dynabook": bobDevice.deviceCurve25519Key,
                    },
                },
            });
            alice.downloadKeys = () => {
                return Promise.resolve();
            };

            bob._crypto._deviceList.storeDevicesForUser("@alice:example.com", {
                Osborne2: {
                    user_id: "@alice:example.com",
                    device_id: "Osborne2",
                    algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                    keys: {
                        "ed25519:Osborne2": aliceDevice.deviceEd25519Key,
                        "curve25519:Osborne2": aliceDevice.deviceCurve25519Key,
                    },
                },
            });
            bob.downloadKeys = () => {
                return Promise.resolve();
            };

            aliceSasEvent = null;
            bobSasEvent = null;

            bobPromise = new Promise((resolve, reject) => {
                bob.on("crypto.verification.start", (verifier) => {
                    verifier.on("show_sas", (e) => {
                        if (!e.sas.emoji || !e.sas.decimal) {
                            e.cancel();
                        } else if (!aliceSasEvent) {
                            bobSasEvent = e;
                        } else {
                            try {
                                expect(e.sas).toEqual(aliceSasEvent.sas);
                                e.confirm();
                                aliceSasEvent.confirm();
                            } catch (error) {
                                e.mismatch();
                                aliceSasEvent.mismatch();
                            }
                        }
                    });
                    resolve(verifier);
                });
            });

            aliceVerifier = alice.beginKeyVerification(
                verificationMethods.SAS, bob.getUserId(), bob.deviceId,
            );
            aliceVerifier.on("show_sas", (e) => {
                if (!e.sas.emoji || !e.sas.decimal) {
                    e.cancel();
                } else if (!bobSasEvent) {
                    aliceSasEvent = e;
                } else {
                    try {
                        expect(e.sas).toEqual(bobSasEvent.sas);
                        e.confirm();
                        bobSasEvent.confirm();
                    } catch (error) {
                        e.mismatch();
                        bobSasEvent.mismatch();
                    }
                }
            });
        });

        it("should verify a key", async function() {
            let macMethod;
            const origSendToDevice = alice.sendToDevice;
            bob.sendToDevice = function(type, map) {
                if (type === "m.key.verification.accept") {
                    macMethod = map[alice.getUserId()][alice.deviceId]
                        .message_authentication_code;
                }
                return origSendToDevice.call(this, type, map);
            };

            await Promise.all([
                aliceVerifier.verify(),
                bobPromise.then((verifier) => verifier.verify()),
            ]);

            // make sure that it uses the preferred method
            expect(macMethod).toBe("hkdf-hmac-sha256");

            // make sure Alice and Bob verified each other
            const bobDevice
                  = await alice.getStoredDevice("@bob:example.com", "Dynabook");
            expect(bobDevice.isVerified()).toBeTruthy();
            const aliceDevice
                  = await bob.getStoredDevice("@alice:example.com", "Osborne2");
            expect(aliceDevice.isVerified()).toBeTruthy();
        });

        it("should be able to verify using the old MAC", async function() {
            // pretend that Alice can only understand the old (incorrect) MAC,
            // and make sure that she can still verify with Bob
            let macMethod;
            const origSendToDevice = alice.sendToDevice;
            alice.sendToDevice = function(type, map) {
                if (type === "m.key.verification.start") {
                    // Note: this modifies not only the message that Bob
                    // receives, but also the copy of the message that Alice
                    // has, since it is the same object.  If this does not
                    // happen, the verification will fail due to a hash
                    // commitment mismatch.
                    map[bob.getUserId()][bob.deviceId]
                        .message_authentication_codes = ['hmac-sha256'];
                }
                return origSendToDevice.call(this, type, map);
            };
            bob.sendToDevice = function(type, map) {
                if (type === "m.key.verification.accept") {
                    macMethod = map[alice.getUserId()][alice.deviceId]
                        .message_authentication_code;
                }
                return origSendToDevice.call(this, type, map);
            };

            await Promise.all([
                aliceVerifier.verify(),
                bobPromise.then((verifier) => verifier.verify()),
            ]);

            expect(macMethod).toBe("hmac-sha256");

            const bobDevice
                  = await alice.getStoredDevice("@bob:example.com", "Dynabook");
            expect(bobDevice.isVerified()).toBeTruthy();
            const aliceDevice
                  = await bob.getStoredDevice("@alice:example.com", "Osborne2");
            expect(aliceDevice.isVerified()).toBeTruthy();
        });

        it("should verify a cross-signing key", async function() {
            const privateKeys = {};
            alice.on("cross-signing:savePrivateKeys", function(e) {
                privateKeys.alice = e;
            });
            await alice.resetCrossSigningKeys();
            bob.on("cross-signing:savePrivateKeys", function(e) {
                privateKeys.bob = e;
            });
            await bob.resetCrossSigningKeys();

            bob.on("cross-signing:getKey", function(e) {
                e.done(privateKeys.bob[e.type]);
            });

            bob._crypto._deviceList.storeCrossSigningForUser("@alice:example.com", {
                keys: alice._crypto._crossSigningInfo.keys,
            });
            await Promise.all([
                aliceVerifier.verify(),
                bobPromise.then((verifier) => verifier.verify()),
            ]);

            expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(1);
            expect(bob.checkUserTrust("@alice:example.com")).toBe(6);
            expect(bob.checkDeviceTrust("@alice:example.com", "Osborne2")).toBe(1);
        });
    });

    it("should send a cancellation message on error", async function() {
        const [alice, bob] = await makeTestClients(
            [
                {userId: "@alice:example.com", deviceId: "Osborne2"},
                {userId: "@bob:example.com", deviceId: "Dynabook"},
            ],
            {
                verificationMethods: [verificationMethods.SAS],
            },
        );
        alice.setDeviceVerified = expect.createSpy();
        alice.downloadKeys = () => {
            return Promise.resolve();
        };
        bob.setDeviceVerified = expect.createSpy();
        bob.downloadKeys = () => {
            return Promise.resolve();
        };

        const bobPromise = new Promise((resolve, reject) => {
            bob.on("crypto.verification.start", (verifier) => {
                verifier.on("show_sas", (e) => {
                    e.mismatch();
                });
                resolve(verifier);
            });
        });

        const aliceVerifier = alice.beginKeyVerification(
            verificationMethods.SAS, bob.getUserId(), bob.deviceId,
        );

        const aliceSpy = expect.createSpy();
        const bobSpy = expect.createSpy();
        await Promise.all([
            aliceVerifier.verify().catch(aliceSpy),
            bobPromise.then((verifier) => verifier.verify()).catch(bobSpy),
        ]);
        expect(aliceSpy).toHaveBeenCalled();
        expect(bobSpy).toHaveBeenCalled();
        expect(alice.setDeviceVerified)
            .toNotHaveBeenCalled();
        expect(bob.setDeviceVerified)
            .toNotHaveBeenCalled();
    });
});
