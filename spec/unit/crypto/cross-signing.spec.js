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

import '../../olm-loader';

import expect from 'expect';
import anotherjson from 'another-json';

import olmlib from '../../../lib/crypto/olmlib';

import TestClient from '../../TestClient';

import {HttpResponse, setHttpResponses} from '../../test-utils';

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
        // set Alice's cross-signing key
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        await alice.resetCrossSigningKeys();
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

    it("should get cross-signing keys from sync", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );

        const masterKey = new Uint8Array([
            0xda, 0x5a, 0x27, 0x60, 0xe3, 0x3a, 0xc5, 0x82,
            0x9d, 0x12, 0xc3, 0xbe, 0xe8, 0xaa, 0xc2, 0xef,
            0xae, 0xb1, 0x05, 0xc1, 0xe7, 0x62, 0x78, 0xa6,
            0xd7, 0x1f, 0xf8, 0x2c, 0x51, 0x85, 0xf0, 0x1d,
        ]);
        const selfSigningKey = new Uint8Array([
            0x1e, 0xf4, 0x01, 0x6d, 0x4f, 0xa1, 0x73, 0x66,
            0x6b, 0xf8, 0x93, 0xf5, 0xb0, 0x4d, 0x17, 0xc0,
            0x17, 0xb5, 0xa5, 0xf6, 0x59, 0x11, 0x8b, 0x49,
            0x34, 0xf2, 0x4b, 0x64, 0x9b, 0x52, 0xf8, 0x5f,
        ]);

        const keyChangePromise = new Promise((resolve, reject) => {
            alice.once("cross-signing:keysChanged", (e) => {
                resolve(e);
            });
        });

        alice.once("cross-signing:newKey", (e) => {
            e.done(masterKey);
        });

        const deviceInfo = alice._crypto._deviceList._devices["@alice:example.com"]
            .Osborne2;
        const aliceDevice = {
            user_id: "@alice:example.com",
            device_id: "Osborne2",
        };
        aliceDevice.keys = deviceInfo.keys;
        aliceDevice.algorithms = deviceInfo.algorithms;
        await alice._crypto._signObject(aliceDevice);
        olmlib.pkSign(aliceDevice, selfSigningKey, "@alice:example.com");

        // feed sync result that includes master key, ssk, device key
        const responses = [
            HttpResponse.PUSH_RULES_RESPONSE,
            {
                method: "POST",
                path: "/keys/upload/Osborne2",
                data: {
                    one_time_key_counts: {
                        curve25519: 100,
                        signed_curve25519: 100,
                    },
                },
            },
            HttpResponse.filterResponse("@alice:example.com"),
            {
                method: "GET",
                path: "/sync",
                data: {
                    next_batch: "abcdefg",
                    device_lists: {
                        changed: [
                            "@alice:example.com",
                            "@bob:example.com",
                        ],
                    },
                },
            },
            {
                method: "POST",
                path: "/keys/query",
                data: {
                    "failures": {},
                    "device_keys": {
                        "@alice:example.com": {
                            "Osborne2": aliceDevice,
                        },
                    },
                    "master_keys": {
                        "@alice:example.com": {
                            user_id: "@alice:example.com",
                            usage: ["master"],
                            keys: {
                                "ed25519:nqOvzeuGWT/sRx3h7+MHoInYj3Uk2LD/unI9kDYcHwk":
                                "nqOvzeuGWT/sRx3h7+MHoInYj3Uk2LD/unI9kDYcHwk",
                            },
                        },
                    },
                    "self_signing_keys": {
                        "@alice:example.com": {
                            user_id: "@alice:example.com",
                            usage: ["self-signing"],
                            keys: {
                                "ed25519:EmkqvokUn8p+vQAGZitOk4PWjp7Ukp3txV2TbMPEiBQ":
                                "EmkqvokUn8p+vQAGZitOk4PWjp7Ukp3txV2TbMPEiBQ",
                            },
                            signatures: {
                                "@alice:example.com": {
                                    "ed25519:nqOvzeuGWT/sRx3h7+MHoInYj3Uk2LD/unI9kDYcHwk":
                                    "Wqx/HXR851KIi8/u/UX+fbAMtq9Uj8sr8FsOcqrLfVYa6lAmbXs"
                                    + "Vhfy4AlZ3dnEtjgZx0U0QDrghEn2eYBeOCA",
                                },
                            },
                        },
                    },
                },
            },
            {
                method: "POST",
                path: "/keys/upload/Osborne2",
                data: {
                    one_time_key_counts: {
                        curve25519: 100,
                        signed_curve25519: 100,
                    },
                },
            },
        ];
        setHttpResponses(alice, responses);

        await alice.startClient();

        // once ssk is confirmed, device key should be trusted
        await keyChangePromise;
        expect(alice.checkUserTrust("@alice:example.com")).toBe(6);
        expect(alice.checkDeviceTrust("@alice:example.com", "Osborne2")).toBe(7);
    });

    it("should use trust chain to determine device verification", async function() {
        const alice = await makeTestClient(
            {userId: "@alice:example.com", deviceId: "Osborne2"},
        );
        // set Alice's cross-signing key
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        await alice.resetCrossSigningKeys();
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
        // set Alice's cross-signing key
        let privateKeys;
        alice.on("cross-signing:savePrivateKeys", function(e) {
            privateKeys = e;
        });
        await alice.resetCrossSigningKeys();
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
        await alice.resetCrossSigningKeys();
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
