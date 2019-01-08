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

try {
    global.Olm = require('olm');
} catch (e) {
    console.warn("unable to run device verification tests: libolm not available");
}

import expect from 'expect';

import sdk from '../../../..';

import {verificationMethods} from '../../../../lib/crypto';
import DeviceInfo from '../../../../lib/crypto/deviceinfo';

import SAS from '../../../../lib/crypto/verification/SAS';

const Olm = global.Olm;

const MatrixEvent = sdk.MatrixEvent;

import {makeTestClients} from './util';

describe("SAS verification", function() {
    if (!global.Olm) {
        console.warn('Not running device verification unit tests: libolm not present');
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

    it("should verify a key", async function() {
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
        alice.getDeviceEd25519Key = () => {
            return "alice+base64+ed25519+key";
        };
        alice.getStoredDevice = () => {
            return DeviceInfo.fromStorage(
                {
                    keys: {
                        "ed25519:Dynabook": "bob+base64+ed25519+key",
                    },
                },
                "Dynabook",
            );
        };

        bob.setDeviceVerified = expect.createSpy();
        bob.getStoredDevice = () => {
            return DeviceInfo.fromStorage(
                {
                    keys: {
                        "ed25519:Osborne2": "alice+base64+ed25519+key",
                    },
                },
                "Osborne2",
            );
        };
        bob.getDeviceEd25519Key = () => {
            return "bob+base64+ed25519+key";
        };

        let aliceSasEvent;
        let bobSasEvent;

        const bobPromise = new Promise((resolve, reject) => {
            bob.on("crypto.verification.start", (verifier) => {
                verifier.on("show_sas", (e) => {
                    if (!aliceSasEvent) {
                        bobSasEvent = e;
                    } else if (e.sas === aliceSasEvent.sas) {
                        e.confirm();
                        aliceSasEvent.confirm();
                    } else {
                        e.mismatch();
                        aliceSasEvent.mismatch();
                    }
                });
                resolve(verifier);
            });
        });

        const aliceVerifier = alice.beginKeyVerification(
            verificationMethods.SAS, bob.getUserId(), bob.deviceId,
        );
        aliceVerifier.on("show_sas", (e) => {
            if (!bobSasEvent) {
                aliceSasEvent = e;
            } else if (e.sas === bobSasEvent.sas) {
                e.confirm();
                bobSasEvent.confirm();
            } else {
                e.mismatch();
                bobSasEvent.mismatch();
            }
        });
        await Promise.all([
            aliceVerifier.verify(),
            bobPromise.then((verifier) => verifier.verify()),
        ]);
        expect(alice.setDeviceVerified)
            .toHaveBeenCalledWith(bob.getUserId(), bob.deviceId);
        expect(bob.setDeviceVerified)
            .toHaveBeenCalledWith(alice.getUserId(), alice.deviceId);
    });

    it("should send a cancellation message on error", async function() {
        let bob;
        let bobResolve;
        const bobPromise = new Promise((resolve, reject) => {
            bobResolve = resolve;
        });
        const alice = new SAS({
            getUserId: () => "@alice:example.com",
            deviceId: "ABCDEFG",
            sendToDevice: function(type, map) {
                if (map["@bob:example.com"] && map["@bob:example.com"]["HIJKLMN"]) {
                    const event = new MatrixEvent({
                        sender: "@alice:example.com",
                        type: type,
                        content: map["@bob:example.com"]["HIJKLMN"],
                    });
                    if (type === "m.key.verification.start") {
                        expect(bob).toNotExist();
                        bob = new SAS({
                            getUserId: () => "@bob:example.com",
                            deviceId: "HIJKLMN",
                            sendToDevice: function(type, map) {
                                if (map["@alice:example.com"]
                                    && map["@alice:example.com"]["ABCDEFG"]) {
                                    setTimeout(() => alice.handleEvent(new MatrixEvent({
                                        sender: "@bob:example.com",
                                        type: type,
                                        content: map["@alice:example.com"]["ABCDEFG"],
                                    })), 0);
                                }
                            },
                            getStoredDevice: () => {
                                return DeviceInfo.fromStorage(
                                    {
                                        keys: {
                                            "ed25519:ABCDEFG": "alice+base64+ed25519+key",
                                        },
                                    },
                                    "ABCDEFG",
                                );
                            },
                            setDeviceVerified: expect.createSpy(),
                            getDeviceEd25519Key: () => {
                                return "bob+base64+ed25519+key";
                            },
                        }, "@alice:example.com", "ABCDEFG", "transaction", event);
                        bobResolve();
                    } else {
                        setTimeout(() => bob.handleEvent(event), 0);
                    }
                }
            },
            getStoredDevice: () => {
                return DeviceInfo.fromStorage(
                    {
                        keys: {
                            "ed25519:HIJKLMN": "bob+base64+ed25519+key",
                        },
                    },
                    "HIJKLMN",
                );
            },
            setDeviceVerified: expect.createSpy(),
            getDeviceEd25519Key: () => {
                return "alice+base64+ed25519+key";
            },
        }, "@bob:example.com", "HIJKLMN", "transaction");
        let aliceSasEvent;
        let bobSasEvent;
        alice.on("show_sas", (e) => {
            if (!bobSasEvent) {
                aliceSasEvent = e;
            } else {
                bobSasEvent.mismatch();
            }
        });
        // start the verification, but don't await on it yet.  We will await on
        // it after Bob is all set up
        alice.verify();
        await bobPromise;
        bob.on("show_sas", (e) => {
            if (!aliceSasEvent) {
                bobSasEvent = e;
            } else {
                e.mismatch();
            }
        });
        const aliceSpy = expect.createSpy();
        const bobSpy = expect.createSpy();
        await Promise.all([alice.verify().catch(aliceSpy), bob.verify().catch(bobSpy)]);
        expect(aliceSpy).toHaveBeenCalled();
        expect(bobSpy).toHaveBeenCalled();
        expect(alice._baseApis.setDeviceVerified)
            .toNotHaveBeenCalled();
        expect(bob._baseApis.setDeviceVerified)
            .toNotHaveBeenCalled();
    });
});
