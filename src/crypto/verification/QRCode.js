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

    _doVerification() {
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

    async _doVerification() {
        const code = await new Promise((resolve, reject) => {
            this.emit("scan", {
                done: resolve,
                cancel: reject,
            });
        });

        const match = code.match(MATRIXTO_REGEXP);
        let deviceId;
        const keys = {};
        if (!match) {
            throw new Error("Invalid value for QR code");
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
            throw new Error("Invalid value for QR code");
        }

        if (!this.userId) {
            await new Promise((resolve, reject) => {
                this.emit("confirm_user_id", {
                    userId: userId,
                    confirm: resolve,
                    cancel: () => reject(new Error("Incorrect user")),
                });
            });
        } else if (this.userId !== userId) {
            throw new Error(
                `User ID mismatch: expected ${this.userId}, but got ${userId}`,
            );
        }

        await this._verifyKeys(userId, keys, (keyId, device, key) => {
            if (device.keys[keyId] !== key) {
                throw new Error("Keys did not match");
            }
        });
    }
}

ScanQRCode.NAME = "m.qr_code.scan.v1";
