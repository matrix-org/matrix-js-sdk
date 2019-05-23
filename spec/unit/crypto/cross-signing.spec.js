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

import '../../olm-loader';

import expect from 'expect';
import anotherjson from 'another-json';

import olmlib from '../../../lib/crypto/olmlib';

import TestClient from '../../TestClient';

async function makeTestClient(userInfo, options) {
    const client = (new TestClient(
        userInfo.userId, userInfo.deviceId, undefined, undefined, options,
    )).client;

    await client.initCrypto();

    return client;
}

describe("Cross Signing", function() {
    if (!global.Olm) {
        console.warn('Not running megolm backup unit tests: libolm not present');
        return;
    }

    beforeEach(async function() {
        await global.Olm.init();
    });

    it("should upload a signature when a user is verified", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        // set Alices' cross-signing key
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        alice.resetCrossSigningKeys();
        // Alice downloads Bob's device key
        alice._crypto._deviceList.storeCrossSigningForUser("@bob:example.com", {
            keys: {
                master: {
                    user_id: "@bob:example.com",
                    usage: ["master"],
                    keys: {
                        "ed25519:bobs+master+pubkey": "bobs+master+pubkey",
                    },
                },
            },
            verified: 0,
            unsigned: {},
        });
        // Alice verifies Bob's key
        alice.on("cross-signing:getKey", function(e) {
            expect(e.type).toBe("user_signing");
            e.done(privateKeys.user_signing);
        });
        const promise = new Promise((resolve, reject) => {
            alice.uploadKeySignatures = (...args) => {
                resolve(...args);
            };
        });
        await alice.setDeviceVerified("@bob:example.com", "bobs+master+pubkey", true);
        // Alice should send a signature of Bob's key to the server
        await promise;
    });

    it("should get ssk and usk from sync", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        alice.on("cross-signing:newKey", function(e) {
            // FIXME: ???
        });
        // feed sync result that includes ssk, usk, device key
        // client should emit event asking about ssk
        // once ssk is confirmed, device key should be trusted
    });

    it("should use trust chain to determine device verification", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        // set Alices' cross-signing key
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        alice.resetCrossSigningKeys();
        // Alice downloads Bob's ssk and device key
        const bobMasterSigning = new global.Olm.PkSigning();
        const bobMasterPrivkey = bobMasterSigning.generate_seed();
        const bobMasterPubkey = bobMasterSigning.init_with_seed(bobMasterPrivkey);
        const bobSigning = new global.Olm.PkSigning();
        const bobPrivkey = bobSigning.generate_seed();
        const bobPubkey = bobSigning.init_with_seed(bobPrivkey);
        const bobSSK = {
            user_id: "@bob:example.com",
            usage: ["self_signing"],
            keys: {
                ["ed25519:" + bobPubkey]: bobPubkey,
            },
        };
        const sskSig = bobMasterSigning.sign(anotherjson.stringify(bobSSK));
        bobSSK.signatures = {
            "@bob:example.com": {
                ["ed25519:" + bobMasterPubkey]: sskSig,
            },
        };
        alice._crypto._deviceList.storeCrossSigningForUser("@bob:example.com", {
            keys: {
                master: {
                    user_id: "@bob:example.com",
                    usage: ["master"],
                    keys: {
                        ["ed25519:" + bobMasterPubkey]: bobMasterPubkey,
                    },
                },
                self_signing: bobSSK,
            },
            fu: 1,
            unsigned: {},
        });
        const bobDevice = {
            user_id: "@bob:example.com",
            device_id: "Dynabook",
            algorithms: ["m.olm.curve25519-aes-sha256", "m.megolm.v1.aes-sha"],
            keys: {
                "curve25519:Dynabook": "somePubkey",
                "ed25519:Dynabook": "someOtherPubkey",
            },
        };
        const sig = bobSigning.sign(anotherjson.stringify(bobDevice));
        bobDevice.signatures = {
            "@bob:example.com": {
                ["ed25519:" + bobPubkey]: sig,
            },
        };
        alice._crypto._deviceList.storeDevicesForUser("@bob:example.com", {
            Dynabook: bobDevice,
        });
        // Bob's device key should be TOFU
        expect(alice.checkUserTrust("@bob:example.com")).toBe(2);
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(2);
        // Alice verifies Bob's SSK
        alice.on("cross-signing:getKey", function(e) {
            expect(e.type).toBe("user_signing");
            e.done(privateKeys.user_signing);
        });
        alice.uploadKeySignatures = () => {};
        await alice.setDeviceVerified("@bob:example.com", bobMasterPubkey, true);
        // Bob's device key should be trusted
        expect(alice.checkUserTrust("@bob:example.com")).toBe(6);
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(6);
    });

    it("should trust signatures received from other devices", async function() {
        // Alice downloads Bob's keys
        // - device key
        // - ssk signed by her usk
        // Bob's device key should be trusted
    });

    it("should dis-trust an unsigned device", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        // set Alices' cross-signing key
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        alice.resetCrossSigningKeys();
        // Alice downloads Bob's ssk and device key
        // (NOTE: device key is not signed by ssk)
        const bobMasterSigning = new global.Olm.PkSigning();
        const bobMasterPrivkey = bobMasterSigning.generate_seed();
        const bobMasterPubkey = bobMasterSigning.init_with_seed(bobMasterPrivkey);
        const bobSigning = new global.Olm.PkSigning();
        const bobPrivkey = bobSigning.generate_seed();
        const bobPubkey = bobSigning.init_with_seed(bobPrivkey);
        const bobSSK = {
            user_id: "@bob:example.com",
            usage: ["self_signing"],
            keys: {
                ["ed25519:" + bobPubkey]: bobPubkey,
            },
        };
        const sskSig = bobMasterSigning.sign(anotherjson.stringify(bobSSK));
        bobSSK.signatures = {
            "@bob:example.com": {
                ["ed25519:" + bobMasterPubkey]: sskSig,
            },
        };
        alice._crypto._deviceList.storeCrossSigningForUser("@bob:example.com", {
            keys: {
                master: {
                    user_id: "@bob:example.com",
                    usage: ["master"],
                    keys: {
                        ["ed25519:" + bobMasterPubkey]: bobMasterPubkey,
                    },
                },
                self_signing: bobSSK,
            },
            fu: 1,
            unsigned: {},
        });
        const bobDevice = {
            user_id: "@bob:example.com",
            device_id: "Dynabook",
            algorithms: ["m.olm.curve25519-aes-sha256", "m.megolm.v1.aes-sha"],
            keys: {
                "curve25519:Dynabook": "somePubkey",
                "ed25519:Dynabook": "someOtherPubkey",
            },
        };
        alice._crypto._deviceList.storeDevicesForUser("@bob:example.com", {
            Dynabook: bobDevice,
        });
        // Bob's device key should be untrusted
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(0);
        // Alice verifies Bob's SSK
        alice.on("cross-signing:getKey", function(e) {
            expect(e.type).toBe("user_signing");
            e.done(privateKeys.user_signing);
        });
        alice.uploadKeySignatures = () => {};
        await alice.setDeviceVerified("@bob:example.com", bobMasterPubkey, true);
        // Bob's device key should be untrusted
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(0);
    });

    it("should dis-trust a user when their ssk changes", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        alice.resetCrossSigningKeys();
        // Alice downloads Bob's keys
        const bobMasterSigning = new global.Olm.PkSigning();
        const bobMasterPrivkey = bobMasterSigning.generate_seed();
        const bobMasterPubkey = bobMasterSigning.init_with_seed(bobMasterPrivkey);
        const bobSigning = new global.Olm.PkSigning();
        const bobPrivkey = bobSigning.generate_seed();
        const bobPubkey = bobSigning.init_with_seed(bobPrivkey);
        const bobSSK = {
            user_id: "@bob:example.com",
            usage: ["self_signing"],
            keys: {
                ["ed25519:" + bobPubkey]: bobPubkey,
            },
        };
        const sskSig = bobMasterSigning.sign(anotherjson.stringify(bobSSK));
        bobSSK.signatures = {
            "@bob:example.com": {
                ["ed25519:" + bobMasterPubkey]: sskSig,
            },
        };
        alice._crypto._deviceList.storeCrossSigningForUser("@bob:example.com", {
            keys: {
                master: {
                    user_id: "@bob:example.com",
                    usage: ["master"],
                    keys: {
                        ["ed25519:" + bobMasterPubkey]: bobMasterPubkey,
                    },
                },
                self_signing: bobSSK,
            },
            fu: 1,
            unsigned: {},
        });
        const bobDevice = {
            user_id: "@bob:example.com",
            device_id: "Dynabook",
            algorithms: ["m.olm.curve25519-aes-sha256", "m.megolm.v1.aes-sha"],
            keys: {
                "curve25519:Dynabook": "somePubkey",
                "ed25519:Dynabook": "someOtherPubkey",
            },
        };
        const bobDeviceString = anotherjson.stringify(bobDevice);
        const sig = bobSigning.sign(bobDeviceString);
        bobDevice.signatures = {};
        bobDevice.signatures["@bob:example.com"] = {};
        bobDevice.signatures["@bob:example.com"]["ed25519:" + bobPubkey] = sig;
        alice._crypto._deviceList.storeDevicesForUser("@bob:example.com", {
            Dynabook: bobDevice,
        });
        // Alice verifies Bob's SSK
        alice.on("cross-signing:getKey", function(e) {
            expect(e.type).toBe("user_signing");
            e.done(privateKeys.user_signing);
        });
        alice.uploadKeySignatures = () => {};
        await alice.setDeviceVerified("@bob:example.com", bobMasterPubkey, true);
        // Bob's device key should be trusted
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(6);
        // Alice downloads new SSK for Bob
        const bobMasterSigning2 = new global.Olm.PkSigning();
        const bobMasterPrivkey2 = bobMasterSigning2.generate_seed();
        const bobMasterPubkey2 = bobMasterSigning2.init_with_seed(bobMasterPrivkey2);
        const bobSigning2 = new global.Olm.PkSigning();
        const bobPrivkey2 = bobSigning2.generate_seed();
        const bobPubkey2 = bobSigning2.init_with_seed(bobPrivkey2);
        const bobSSK2 = {
            user_id: "@bob:example.com",
            usage: ["self_signing"],
            keys: {
                ["ed25519:" + bobPubkey2]: bobPubkey2,
            },
        };
        const sskSig2 = bobMasterSigning2.sign(anotherjson.stringify(bobSSK2));
        bobSSK2.signatures = {
            "@bob:example.com": {
                ["ed25519:" + bobMasterPubkey2]: sskSig2,
            },
        };
        alice._crypto._deviceList.storeCrossSigningForUser("@bob:example.com", {
            keys: {
                master: {
                    user_id: "@bob:example.com",
                    usage: ["master"],
                    keys: {
                        ["ed25519:" + bobMasterPubkey2]: bobMasterPubkey2,
                    },
                },
                self_signing: bobSSK2,
            },
            fu: 0,
            unsigned: {},
        });
        // Bob's and his device should be untrusted
        expect(alice.checkUserTrust("@bob:example.com")).toBe(0);
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(0);
        // Alice verifies Bob's SSK
        alice.on("cross-signing:getKey", function(e) {
            expect(e.type).toBe("user_signing");
            e.done(privateKeys.user_signing);
        });
        alice.uploadKeySignatures = () => {};
        await alice.setDeviceVerified("@bob:example.com", bobMasterPubkey2, true);
        // Bob should be trusted but not his device
        expect(alice.checkUserTrust("@bob:example.com")).toBe(4);
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(0);
        // Alice gets new signature for device
        const sig2 = bobSigning2.sign(bobDeviceString);
        bobDevice.signatures["@bob:example.com"]["ed25519:" + bobPubkey2] = sig2;
        alice._crypto._deviceList.storeDevicesForUser("@bob:example.com", {
            Dynabook: bobDevice,
        });
        // Bob's device should be trusted again (but not TOFU)
        expect(alice.checkUserTrust("@bob:example.com")).toBe(4);
        expect(alice.checkDeviceTrust("@bob:example.com", "Dynabook")).toBe(4);
    });
});
