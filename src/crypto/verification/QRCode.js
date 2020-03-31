/*
Copyright 2018 New Vector Ltd
Copyright 2020 The Matrix.org Foundation C.I.C.

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

/**
 * QR code key verification.
 * @module crypto/verification/QRCode
 */

import {VerificationBase as Base} from "./Base";
import {
    newKeyMismatchError,
} from './Error';
import {decodeBase64} from "../olmlib";

export const SHOW_QR_CODE_METHOD = "m.qr_code.show.v1";
export const SCAN_QR_CODE_METHOD = "m.qr_code.scan.v1";

/**
 * @class crypto/verification/QRCode/ReciprocateQRCode
 * @extends {module:crypto/verification/Base}
 */
export class ReciprocateQRCode extends Base {
    static factory(...args) {
        return new ReciprocateQRCode(...args);
    }

    static get NAME() {
        return "m.reciprocate.v1";
    }

    async _doVerification() {
        if (!this.startEvent) {
            // TODO: Support scanning QR codes
            throw new Error("It is not currently possible to start verification" +
                "with this method yet.");
        }

        // 1. check the secret
        if (this.startEvent.getContent()['secret'] !== this.request.encodedSharedSecret) {
            throw newKeyMismatchError();
        }

        // 2. ask if other user shows shield as well
        await new Promise((resolve, reject) => {
            this.reciprocateQREvent = {
                confirm: resolve,
                cancel: reject, // which code should we cancel with here?
            };
            this.emit("show_reciprocate_qr", this.reciprocateQREvent);
        });

        const keys = {};
        const {qrCodeData} = this.request;
        if (qrCodeData.mode === MODE_VERIFY_OTHER_USER) {
            // add master key to keys to be signed, only if we're not doing self-verification
            const masterKey = qrCodeData.otherUserMasterKey;
            keys[`ed25519:${masterKey}`] = masterKey;
        } else if (qrCodeData.mode === MODE_VERIFY_SELF_TRUSTED) {
            const deviceId = this.request.targetDevice.deviceId;
            keys[`ed25519:${deviceId}`] = qrCodeData.otherDeviceKey;
        } else {
            // TODO: not sure if MODE_VERIFY_SELF_UNTRUSTED makes sense to sign anything here?
        }

        await this._verifyKeys(this.userId, keys, (keyId, device, keyInfo) => {
            const targetKey = keys[keyId];
            if (!targetKey) throw newKeyMismatchError();

            if (keyInfo !== targetKey) {
                console.error("key ID from key info does not match");
                throw newKeyMismatchError();
            }
            for (const deviceKeyId in device.keys) {
                if (!deviceKeyId.startsWith("ed25519")) continue;
                const deviceTargetKey = keys[deviceKeyId];
                if (!deviceTargetKey) throw newKeyMismatchError();
                if (device.keys[deviceKeyId] !== deviceTargetKey) {
                    console.error("master key does not match");
                    throw newKeyMismatchError();
                }
            }

            // Otherwise it is probably fine
        });
    }
}

const CODE_VERSION = 0x02; // the version of binary QR codes we support
const BINARY_PREFIX = "MATRIX"; // ASCII, used to prefix the binary format
const MODE_VERIFY_OTHER_USER = 0x00; // Verifying someone who isn't us
const MODE_VERIFY_SELF_TRUSTED = 0x01; // We trust the master key
const MODE_VERIFY_SELF_UNTRUSTED = 0x02; // We do not trust the master key

export class QRCodeData {
    constructor(request, client) {
        this._mode = QRCodeData._determineMode(request, client);
        this._otherUserMasterKey = null;
        this._otherDeviceKey = null;
        if (this._mode === MODE_VERIFY_OTHER_USER) {
            const otherUserCrossSigningInfo =
                client.getStoredCrossSigningForUser(request.otherUserId);
            this._otherUserMasterKey = otherUserCrossSigningInfo.getId("master");
        } else if (this._mode === MODE_VERIFY_SELF_TRUSTED) {
            this._otherDeviceKey = QRCodeData._getOtherDeviceKey(request, client);
        }
        const qrData = QRCodeData._generateQrData(request, client, this._mode);
        this._buffer = QRCodeData._generateBuffer(qrData);
    }

    get buffer() {
        return this._buffer;
    }

    get mode() {
        return this._mode;
    }

    get otherDeviceKey() {
        return this._otherDeviceKey;
    }

    get otherUserMasterKey() {
        return this._otherUserMasterKey;
    }

    static _getOtherDeviceKey(request, client) {
        const myUserId = client.getUserId();
        const myDevices = client.getStoredDevicesForUser(myUserId) || [];
        const otherDevice = request.targetDevice;
        const otherDeviceId = otherDevice ? otherDevice.deviceId : null;
        const device = myDevices.find(d => d.deviceId === otherDeviceId);
        return device.getFingerprint();
    }

    static _determineMode(request, client) {
        const myUserId = client.getUserId();
        const otherUserId = request.otherUserId;

        let mode = MODE_VERIFY_OTHER_USER;
        if (myUserId === otherUserId) {
            // Mode changes depending on whether or not we trust the master cross signing key
            const myTrust = client.checkUserTrust(myUserId);
            if (myTrust.isCrossSigningVerified()) {
                mode = MODE_VERIFY_SELF_TRUSTED;
            } else {
                mode = MODE_VERIFY_SELF_UNTRUSTED;
            }
        }
        return mode;
    }

    static _generateQrData(request, client, mode) {
        const myUserId = client.getUserId();
        const transactionId = request.channel.transactionId;
        const qrData = {
            prefix: BINARY_PREFIX,
            version: CODE_VERSION,
            mode,
            transactionId,
            firstKeyB64: '', // worked out shortly
            secondKeyB64: '', // worked out shortly
            secretB64: request.encodedSharedSecret,
        };

        const myCrossSigningInfo = client.getStoredCrossSigningForUser(myUserId);
        const myMasterKey = myCrossSigningInfo.getId("master");

        if (mode === MODE_VERIFY_OTHER_USER) {
            // First key is our master cross signing key
            qrData.firstKeyB64 = myMasterKey;
            // Second key is the other user's master cross signing key
            qrData.secondKeyB64 = this._otherUserMasterKey;
        } else if (mode === MODE_VERIFY_SELF_TRUSTED) {
            // First key is our master cross signing key
            qrData.firstKeyB64 = myMasterKey;
            qrData.secondKeyB64 = this._otherDeviceKey;
        } else if (mode === MODE_VERIFY_SELF_UNTRUSTED) {
            // First key is our device's key
            qrData.firstKeyB64 = client.getDeviceEd25519Key();
            // Second key is what we think our master cross signing key is
            qrData.secondKeyB64 = myMasterKey;
        }

        return qrData;
    }

    static _generateBuffer(qrData) {
        let buf = Buffer.alloc(0); // we'll concat our way through life

        const appendByte = (b: number) => {
            const tmpBuf = Buffer.from([b]);
            buf = Buffer.concat([buf, tmpBuf]);
        };
        const appendInt = (i: number) => {
            const tmpBuf = Buffer.alloc(2);
            tmpBuf.writeInt16BE(i, 0);
            buf = Buffer.concat([buf, tmpBuf]);
        };
        const appendStr = (s: string, enc: string, withLengthPrefix = true) => {
            const tmpBuf = Buffer.from(s, enc);
            if (withLengthPrefix) appendInt(tmpBuf.byteLength);
            buf = Buffer.concat([buf, tmpBuf]);
        };
        const appendEncBase64 = (b64: string) => {
            const b = decodeBase64(b64);
            const tmpBuf = Buffer.from(b);
            buf = Buffer.concat([buf, tmpBuf]);
        };

        // Actually build the buffer for the QR code
        appendStr(qrData.prefix, "ascii", false);
        appendByte(qrData.version);
        appendByte(qrData.mode);
        appendStr(qrData.transactionId, "utf-8");
        appendEncBase64(qrData.firstKeyB64);
        appendEncBase64(qrData.secondKeyB64);
        appendEncBase64(qrData.secretB64);

        return buf;
    }
}
