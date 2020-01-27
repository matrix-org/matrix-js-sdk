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
    errorFactory,
    newKeyMismatchError,
    newUserCancelledError,
    newUserMismatchError,
} from './Error';
import * as qs from "qs";

const MATRIXTO_REGEXP = /^(?:https?:\/\/)?(?:www\.)?matrix\.to\/#\/([#@!+][^?]+)\?(.+)$/;
const KEY_REGEXP = /^key_([^:]+:.+)$/;

const newQRCodeError = errorFactory("m.qr_code.invalid", "Invalid QR code");

/**
 * @class crypto/verification/QRCode/ShowQRCode
 * @extends {module:crypto/verification/Base}
 */
export class ShowQRCode extends Base {
    _doVerification() {
        if (!this._done) {
            const crossSigningInfo = this._baseApis.getStoredCrossSigningForUser(this.request.otherUserId);
            const myKeyId = this._baseApis.getCrossSigningId();
            const qrCodeKeys = [
                [this._baseApis.getDeviceId(), this._baseApis.getDeviceEd25519Key()],
                [myKeyId, myKeyId],
            ];
            const query = {
                request: this.request.requestEvent.getId(),
                action: "verify",
                secret: this.request.encodedSharedSecret,
                other_user_key: crossSigningInfo.getId("master"),
            };
            for (const key of qrCodeKeys) {
                query[`key_${key[0]}`] = key[1];
            }

            const uri = `https://matrix.to/#/${this._baseApis.getUserId()}?${qs.stringify(query)}`;
            this.emit("show_qr_code", {
                url: uri,
            });
        }
    }
}

ShowQRCode.NAME = "m.qr_code.show.v1";

/**
 * @class crypto/verification/QRCode/ScanQRCode
 * @extends {module:crypto/verification/Base}
 */
export class ScanQRCode extends Base {
    static factory(...args) {
        return new ScanQRCode(...args);
    }

    async _doVerification() {
        const code = await new Promise((resolve, reject) => {
            this.emit("scan", {
                done: resolve,
                cancel: () => reject(newUserCancelledError()),
            });
        });

        const match = code.match(MATRIXTO_REGEXP);
        let deviceId;
        const keys = {};
        if (!match) {
            throw newQRCodeError();
        }
        const userId = match[1];
        const params = match[2].split("&").map(
            (x) => x.split("=", 2).map(decodeURIComponent),
        );
        let action;
        for (const [name, value] of params) {
            if (name === "device") {
                deviceId = value;
            } else if (name === "action") {
                action = value;
            } else {
                const keyMatch = name.match(KEY_REGEXP);
                if (keyMatch) {
                    keys[keyMatch[1]] = value;
                }
            }
        }
        if (!deviceId || action !== "verify" || Object.keys(keys).length === 0) {
            throw newQRCodeError();
        }

        if (!this.userId) {
            await new Promise((resolve, reject) => {
                this.emit("confirm_user_id", {
                    userId: userId,
                    confirm: resolve,
                    cancel: () => reject(newUserMismatchError()),
                });
            });
        } else if (this.userId !== userId) {
            throw newUserMismatchError({
                expected: this.userId,
                actual: userId,
            });
        }

        await this._verifyKeys(userId, keys, (keyId, device, key) => {
            if (device.keys[keyId] !== key) {
                throw newKeyMismatchError();
            }
        });
    }
}

ScanQRCode.NAME = "m.qr_code.scan.v1";
