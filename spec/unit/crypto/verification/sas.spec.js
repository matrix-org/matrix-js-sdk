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

let ALICE_DEVICES;
let BOB_DEVICES;

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

        // Cancel the SAS for cleanup (we started a verification, so abort)
        sas.cancel();
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

            const aliceDevice = alice.client._crypto._olmDevice;
            const bobDevice = bob.client._crypto._olmDevice;

            ALICE_DEVICES = {
                Osborne2: {
                    user_id: "@alice:example.com",
                    device_id: "Osborne2",
                    algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                    keys: {
                        "ed25519:Osborne2": aliceDevice.deviceEd25519Key,
                        "curve25519:Osborne2": aliceDevice.deviceCurve25519Key,
                    },
                },
            };

            BOB_DEVICES = {
                Dynabook: {
                    user_id: "@bob:example.com",
                    device_id: "Dynabook",
                    algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                    keys: {
                        "ed25519:Dynabook": bobDevice.deviceEd25519Key,
                        "curve25519:Dynabook": bobDevice.deviceCurve25519Key,
                    },
                },
            };

            alice.client._crypto._deviceList.storeDevicesForUser(
                "@bob:example.com", BOB_DEVICES,
            );
            alice.downloadKeys = () => {
                return Promise.resolve();
            };

            bob.client._crypto._deviceList.storeDevicesForUser(
                "@alice:example.com", ALICE_DEVICES,
            );
            bob.downloadKeys = () => {
                return Promise.resolve();
            };

            aliceSasEvent = null;
            bobSasEvent = null;

            bobPromise = new Promise((resolve, reject) => {
                bob.client.on("crypto.verification.start", (verifier) => {
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

            aliceVerifier = alice.client.beginKeyVerification(
                verificationMethods.SAS, bob.client.getUserId(), bob.deviceId,
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
            const origSendToDevice = alice.client.sendToDevice;
            bob.client.sendToDevice = function(type, map) {
                if (type === "m.key.verification.accept") {
                    macMethod = map[alice.client.getUserId()][alice.client.deviceId]
                        .message_authentication_code;
                }
                return origSendToDevice.call(this, type, map);
            };

            alice.httpBackend.when('POST', '/keys/query').respond(200, {
                failures: {},
                device_keys: {
                    "@bob:example.com": BOB_DEVICES,
                },
            });
            bob.httpBackend.when('POST', '/keys/query').respond(200, {
                failures: {},
                device_keys: {
                    "@alice:example.com": ALICE_DEVICES,
                },
            });

            await Promise.all([
                aliceVerifier.verify(),
                bobPromise.then((verifier) => verifier.verify()),
                alice.httpBackend.flush(),
                bob.httpBackend.flush(),
            ]);

            // make sure that it uses the preferred method
            expect(macMethod).toBe("hkdf-hmac-sha256");

            // make sure Alice and Bob verified each other
            const bobDevice
                  = await alice.client.getStoredDevice("@bob:example.com", "Dynabook");
            expect(bobDevice.isVerified()).toBeTruthy();
            const aliceDevice
                  = await bob.client.getStoredDevice("@alice:example.com", "Osborne2");
            expect(aliceDevice.isVerified()).toBeTruthy();
        });

        it("should be able to verify using the old MAC", async function() {
            // pretend that Alice can only understand the old (incorrect) MAC,
            // and make sure that she can still verify with Bob
            let macMethod;
            const origSendToDevice = alice.client.sendToDevice;
            alice.client.sendToDevice = function(type, map) {
                if (type === "m.key.verification.start") {
                    // Note: this modifies not only the message that Bob
                    // receives, but also the copy of the message that Alice
                    // has, since it is the same object.  If this does not
                    // happen, the verification will fail due to a hash
                    // commitment mismatch.
                    map[bob.client.getUserId()][bob.client.deviceId]
                        .message_authentication_codes = ['hmac-sha256'];
                }
                return origSendToDevice.call(this, type, map);
            };
            bob.client.sendToDevice = function(type, map) {
                if (type === "m.key.verification.accept") {
                    macMethod = map[alice.client.getUserId()][alice.client.deviceId]
                        .message_authentication_code;
                }
                return origSendToDevice.call(this, type, map);
            };

            alice.httpBackend.when('POST', '/keys/query').respond(200, {
                failures: {},
                device_keys: {
                    "@bob:example.com": BOB_DEVICES,
                },
            });
            bob.httpBackend.when('POST', '/keys/query').respond(200, {
                failures: {},
                device_keys: {
                    "@alice:example.com": ALICE_DEVICES,
                },
            });

            await Promise.all([
                aliceVerifier.verify(),
                bobPromise.then((verifier) => verifier.verify()),
                alice.httpBackend.flush(),
                bob.httpBackend.flush(),
            ]);

            expect(macMethod).toBe("hmac-sha256");

            const bobDevice
                  = await alice.client.getStoredDevice("@bob:example.com", "Dynabook");
            expect(bobDevice.isVerified()).toBeTruthy();
            const aliceDevice
                  = await bob.client.getStoredDevice("@alice:example.com", "Osborne2");
            expect(aliceDevice.isVerified()).toBeTruthy();
        });

        it("should verify a cross-signing key", async function() {
            alice.httpBackend.when('POST', '/keys/device_signing/upload').respond(
                200, {},
            );
            alice.httpBackend.when('POST', '/keys/signatures/upload').respond(200, {});
            alice.httpBackend.flush(undefined, 2);
            await alice.client.resetCrossSigningKeys();
            bob.httpBackend.when('POST', '/keys/device_signing/upload').respond(200, {});
            bob.httpBackend.when('POST', '/keys/signatures/upload').respond(200, {});
            bob.httpBackend.flush(undefined, 2);

            await bob.client.resetCrossSigningKeys();

            bob.client._crypto._deviceList.storeCrossSigningForUser(
                "@alice:example.com", {
                    keys: alice.client._crypto._crossSigningInfo.keys,
                },
            );

            alice.httpBackend.when('POST', '/keys/query').respond(200, {
                failures: {},
                device_keys: {
                    "@bob:example.com": BOB_DEVICES,
                },
            });
            bob.httpBackend.when('POST', '/keys/query').respond(200, {
                failures: {},
                device_keys: {
                    "@alice:example.com": ALICE_DEVICES,
                },
            });

            const verifyProm = Promise.all([
                aliceVerifier.verify(),
                bobPromise.then((verifier) => {
                    bob.httpBackend.when(
                        'POST', '/keys/signatures/upload',
                    ).respond(200, {});
                    bob.httpBackend.flush(undefined, 2);
                    return verifier.verify();
                }),
            ]);

            await alice.httpBackend.flush(undefined, 1);
            console.log("alice reqs flushed");

            await verifyProm;

            const bobDeviceTrust = alice.client.checkDeviceTrust("@bob:example.com", "Dynabook");
            expect(bobDeviceTrust.isLocallyVerified()).toBeTruthy();
            expect(bobDeviceTrust.isCrossSigningVerified()).toBeFalsy();

            const aliceTrust = bob.client.checkUserTrust("@alice:example.com");
            expect(aliceTrust.isCrossSigningVerified()).toBeTruthy();
            expect(aliceTrust.isTofu()).toBeTruthy();

            const aliceDeviceTrust = bob.client.checkDeviceTrust("@alice:example.com", "Osborne2");
            expect(aliceDeviceTrust.isLocallyVerified()).toBeTruthy();
            expect(aliceDeviceTrust.isCrossSigningVerified()).toBeFalsy();
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
        alice.client.setDeviceVerified = expect.createSpy();
        alice.client.downloadKeys = () => {
            return Promise.resolve();
        };
        bob.client.setDeviceVerified = expect.createSpy();
        bob.client.downloadKeys = () => {
            return Promise.resolve();
        };

        const bobPromise = new Promise((resolve, reject) => {
            bob.client.on("crypto.verification.start", (verifier) => {
                verifier.on("show_sas", (e) => {
                    e.mismatch();
                });
                resolve(verifier);
            });
        });

        const aliceVerifier = alice.client.beginKeyVerification(
            verificationMethods.SAS, bob.client.getUserId(), bob.client.deviceId,
        );

        const aliceSpy = expect.createSpy();
        const bobSpy = expect.createSpy();
        await Promise.all([
            aliceVerifier.verify().catch(aliceSpy),
            bobPromise.then((verifier) => verifier.verify()).catch(bobSpy),
        ]);
        expect(aliceSpy).toHaveBeenCalled();
        expect(bobSpy).toHaveBeenCalled();
        expect(alice.client.setDeviceVerified)
            .toNotHaveBeenCalled();
        expect(bob.client.setDeviceVerified)
            .toNotHaveBeenCalled();
    });

    describe("verification in DM", function() {
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

            alice.client.setDeviceVerified = expect.createSpy();
            alice.client.getDeviceEd25519Key = () => {
                return "alice+base64+ed25519+key";
            };
            alice.client.getStoredDevice = () => {
                return DeviceInfo.fromStorage(
                    {
                        keys: {
                            "ed25519:Dynabook": "bob+base64+ed25519+key",
                        },
                    },
                    "Dynabook",
                );
            };
            alice.client.downloadKeys = () => {
                return Promise.resolve();
            };

            bob.client.setDeviceVerified = expect.createSpy();
            bob.client.getStoredDevice = () => {
                return DeviceInfo.fromStorage(
                    {
                        keys: {
                            "ed25519:Osborne2": "alice+base64+ed25519+key",
                        },
                    },
                    "Osborne2",
                );
            };
            bob.client.getDeviceEd25519Key = () => {
                return "bob+base64+ed25519+key";
            };
            bob.client.downloadKeys = () => {
                return Promise.resolve();
            };

            aliceSasEvent = null;
            bobSasEvent = null;

            bobPromise = new Promise((resolve, reject) => {
                bob.client.on("event", async (event) => {
                    const content = event.getContent();
                    if (event.getType() === "m.room.message"
                        && content.msgtype === "m.key.verification.request") {
                        expect(content.methods).toInclude(SAS.NAME);
                        expect(content.to).toBe(bob.client.getUserId());
                        const verifier = bob.client.acceptVerificationDM(event, SAS.NAME);
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
                        await verifier.verify();
                        resolve();
                    }
                });
            });

            aliceVerifier = await alice.client.requestVerificationDM(
                bob.client.getUserId(), "!room_id", [verificationMethods.SAS],
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
            await Promise.all([
                aliceVerifier.verify(),
                bobPromise,
            ]);

            // make sure Alice and Bob verified each other
            expect(alice.client.setDeviceVerified)
                .toHaveBeenCalledWith(bob.client.getUserId(), bob.client.deviceId);
            expect(bob.client.setDeviceVerified)
                .toHaveBeenCalledWith(alice.client.getUserId(), alice.client.deviceId);
        });
    });
});
