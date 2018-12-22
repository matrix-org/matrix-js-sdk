/*
Copyright 2018 New Vector Ltd

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
 * @module crypto/QRCode
 *
 * QR code key verification.
 */

import Base from "./Base";
import logger from '../../logger';

const MATRIXTO_REGEXP = /^(?:https?:\/\/)?(?:www\.)?matrix\.to\/#\/([#@!+][^?]+)\?(.+)$/;
const KEY_REGEXP = /^key_([^:]+:.+)$/;

/**
 * @class crypto/QRCode/ShowQRCode
 */
export class ShowQRCode extends Base {
    static factory(...args) {
        return new ShowQRCode(...args);
    }

    verify() {
        if (this._started) {
            return this._promise;
        }
        this._started = true;

        if (!this._done) {
            const url = "https://matrix.to/#/" + this._baseApis.userId
                  + "?device=" + encodeURIComponent(this._baseApis.deviceId)
                  + "&action=verify&key_ed25519%3A"
                  + encodeURIComponent(this._baseApis.deviceId) + "="
                  + encodeURIComponent(this._baseApis.getDeviceEd25519Key());
            this.emit("show_qr_code", {
                url: url,
            });
        }
        return this._promise;
    }
}

ShowQRCode.NAME = "m.qr_code.show.v1";

/**
 * @class crypto/QRCode/ScanQRCode
 */
export class ScanQRCode extends Base {
    static factory(...args) {
        return new ScanQRCode(...args);
    }

    async code(code) {
        const match = code.match(MATRIXTO_REGEXP);
        let userId;
        let deviceId;
        const keys = {};
        if (match) {
            userId = match[1];
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
                this.cancel(new Error("Invalid value for QR code"));
                return;
            }
        } else {
            this.cancel(new Error("Invalid value for QR code"));
            return;
        }
        if (!this.userId) {
            const callback = () => {
                return this._verifyKey(userId, keys);
            };
            this.emit("confirm_user_id", {
                userId: userId,
                confirm: callback,
            });
        } else if (this.userId !== userId) {
            this.cancel(new Error(
                `User ID mismatch: expected ${this.userId}, but got ${userId}`,
            ));
        } else {
            return await this._verifyKey(userId, keys);
        }
    }

    async _verifyKey(userId, keys) {
        for (const [keyId, key] of Object.entries(keys)) {
            const deviceId = keyId.split(':', 2)[1];
            // FIXME: make sure key is downloaded
            const device = await this._baseApis.getStoredDevice(userId, deviceId);
            if (!device) {
                return this.cancel(new Error(`Could not find device ${deviceId}`));
            } else if (device.keys[keyId] !== key) {
                return this.cancel(new Error("Keys did not match"));
            }
        }
        for (const keyId of Object.keys(keys)) {
            const deviceId = keyId.split(':', 2)[1];
            await this._baseApis.setDeviceVerified(userId, deviceId);
        }
        this.done();
    }
}

ScanQRCode.NAME = "m.qr_code.scan.v1";
