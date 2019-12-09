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

import DeviceInfo from '../../../../lib/crypto/deviceinfo';

import {ShowQRCode, ScanQRCode} from '../../../../lib/crypto/verification/QRCode';

const Olm = global.Olm;

describe("QR code verification", function() {
    if (!global.Olm) {
        logger.warn('Not running device verification tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return Olm.init();
    });

    describe("showing", function() {
        it("should emit an event to show a QR code", async function() {
            const channel = {
                send: jest.fn(),
            };
            const qrCode = new ShowQRCode(channel, {
                getUserId: () => "@alice:example.com",
                deviceId: "ABCDEFG",
                getDeviceEd25519Key: function() {
                    return "device+ed25519+key";
                },
            });
            const spy = jest.fn((e) => {
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
                getStoredDevice: jest.fn().mockReturnValue(device),
                setDeviceVerified: jest.fn(),
            };
            const channel = {
                send: jest.fn(),
            };
            const qrCode = new ScanQRCode(channel, client);
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
                getStoredDevice: jest.fn(),
                setDeviceVerified: jest.fn(),
            };
            const channel = {
                send: jest.fn(),
            };
            const qrCode = new ScanQRCode(channel, client, "@bob:example.com", "ABCDEFG");
            qrCode.on("scan", ({done}) => {
                done(QR_CODE_URL);
            });
            const spy = jest.fn();
            await qrCode.verify().catch(spy);
            expect(spy).toHaveBeenCalled();
            expect(channel.send).toHaveBeenCalled();
            expect(client.getStoredDevice).not.toHaveBeenCalled();
            expect(client.setDeviceVerified).not.toHaveBeenCalled();
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
                getStoredDevice: jest.fn().mockReturnValue(device),
                setDeviceVerified: jest.fn(),
            };
            const channel = {
                send: jest.fn(),
            };
            const qrCode = new ScanQRCode(
                channel, client, "@alice:example.com", "ABCDEFG");
            qrCode.on("scan", ({done}) => {
                done(QR_CODE_URL);
            });
            const spy = jest.fn();
            await qrCode.verify().catch(spy);
            expect(spy).toHaveBeenCalled();
            expect(channel.send).toHaveBeenCalled();
            expect(client.getStoredDevice).toHaveBeenCalled();
            expect(client.setDeviceVerified).not.toHaveBeenCalled();
        });
    });
});
