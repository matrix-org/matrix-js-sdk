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

import DeviceInfo from '../../../../lib/crypto/deviceinfo';

import {ShowQRCode, ScanQRCode} from '../../../../lib/crypto/verification/QRCode';

const Olm = global.Olm;

describe("QR code verification", function() {
    if (!global.Olm) {
        console.warn('Not running device verification tests: libolm not present');
        return;
    }

    beforeEach(async function() {
        await Olm.init();
    });

    describe("showing", function() {
        it("should emit an event to show a QR code", async function() {
            const qrCode = new ShowQRCode({
                getUserId: () => "@alice:example.com",
                deviceId: "ABCDEFG",
                getDeviceEd25519Key: function() {
                    return "device+ed25519+key";
                },
            });
            const spy = expect.createSpy().andCall((e) => {
                qrCode.done();
            });
            qrCode.on("show_qr_code", spy);
            await qrCode.verify();
            expect(spy).toHaveBeenCalledWith({
                url: "https://matrix.to/#/@alice:example.com?device=ABCDEFG"
                    + "&action=verify&key_ed25519%3AABCDEFG=device%2Bed25519%2Bkey",
            });
        });
    });

    describe("scanning", function() {
        const QR_CODE_URL = "https://matrix.to/#/@alice:example.com?device=ABCDEFG"
              + "&action=verify&key_ed25519%3AABCDEFG=device%2Bed25519%2Bkey";
        it("should verify when a QR code is sent", async function() {
            const device = DeviceInfo.fromStorage(
                {
                    algorithms: [],
                    keys: {
                        "curve25519:ABCDEFG": "device+curve25519+key",
                        "ed25519:ABCDEFG": "device+ed25519+key",
                    },
                    verified: false,
                    known: false,
                    unsigned: {},
                },
                "ABCDEFG",
            );
            const client = {
                getStoredDevice: expect.createSpy().andReturn(device),
                setDeviceVerified: expect.createSpy(),
            };
            const qrCode = new ScanQRCode(client);
            qrCode.on("confirm_user_id", ({userId, confirm}) => {
                if (userId === "@alice:example.com") {
                    confirm();
                } else {
                    qrCode.cancel(new Error("Incorrect user"));
                }
            });
            qrCode.on("scan", ({done}) => {
                done(QR_CODE_URL);
            });
            await qrCode.verify();
            expect(client.getStoredDevice)
                .toHaveBeenCalledWith("@alice:example.com", "ABCDEFG");
            expect(client.setDeviceVerified)
                .toHaveBeenCalledWith("@alice:example.com", "ABCDEFG");
        });

        it("should error when the user ID doesn't match", async function() {
            const client = {
                getStoredDevice: expect.createSpy(),
                setDeviceVerified: expect.createSpy(),
            };
            const qrCode = new ScanQRCode(client, "@bob:example.com", "ABCDEFG");
            qrCode.on("scan", ({done}) => {
                done(QR_CODE_URL);
            });
            const spy = expect.createSpy();
            await qrCode.verify().catch(spy);
            expect(spy).toHaveBeenCalled();
            expect(client.getStoredDevice).toNotHaveBeenCalled();
            expect(client.setDeviceVerified).toNotHaveBeenCalled();
        });

        it("should error if the key doesn't match", async function() {
            const device = DeviceInfo.fromStorage(
                {
                    algorithms: [],
                    keys: {
                        "curve25519:ABCDEFG": "device+curve25519+key",
                        "ed25519:ABCDEFG": "a+different+device+ed25519+key",
                    },
                    verified: false,
                    known: false,
                    unsigned: {},
                },
                "ABCDEFG",
            );
            const client = {
                getStoredDevice: expect.createSpy().andReturn(device),
                setDeviceVerified: expect.createSpy(),
            };
            const qrCode = new ScanQRCode(client, "@alice:example.com", "ABCDEFG");
            qrCode.on("scan", ({done}) => {
                done(QR_CODE_URL);
            });
            const spy = expect.createSpy();
            await qrCode.verify().catch(spy);
            expect(spy).toHaveBeenCalled();
            expect(client.getStoredDevice).toHaveBeenCalled();
            expect(client.setDeviceVerified).toNotHaveBeenCalled();
        });
    });
});
