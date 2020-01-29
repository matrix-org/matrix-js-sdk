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

const newQRCodeError = errorFactory("m.qr_code.invalid", "Invalid QR code");

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

    async _doVerification() {
        const code = await new Promise((resolve, reject) => {
            this.emit("scan", {
                done: resolve,
                cancel: () => reject(newUserCancelledError()),
            });
        });
        const {secret, otherUserKey, keys, targetUserId} = ReciprocateQRCode.splitUrl(code);

        if (!this.userId) {
            await new Promise((resolve, reject) => {
                this.emit("confirm_user_id", {
                    userId: targetUserId,
                    confirm: resolve,
                    cancel: () => reject(newUserMismatchError()),
                });
            });
        } else if (this.userId !== userId) {
            throw newUserMismatchError({
                expected: this.userId,
                actual: targetUserId,
            });
        }

        const crossSigningInfo = this._baseApis.getStoredCrossSigningInfo(targetUserId);
        if (!crossSigningInfo) throw new Error("Missing cross signing info for user"); // this shouldn't happen by now
        if (crossSigningInfo.getId("master") !== otherUserKey) {
            throw newKeyMismatchError();
        }

        if (secret !== this.request.encodedSharedSecret) {
            throw newQRCodeError();
        }

        // Verify our own keys that were sent in this code too
        await this._verifyKeys(this._baseApis.getUserId(), keys, (keyId, device, key) => {
            if (device.keys[keyId] !== key) {
                throw newKeyMismatchError();
            }
        });

        await this._verifyKeys(targetUserId, [otherUserKey, otherUserKey], (keyId, device, key) => {
            if (device.keys[keyId] !== key) {
                throw newKeyMismatchError();
            }
        });
    }

    static splitUrl(code) {
        const match = code.match(MATRIXTO_REGEXP);
        const keys = {};
        if (!match) {
            throw newQRCodeError();
        }
        const targetUserId = match[1];
        const params = match[2].split("&").map(
            (x) => x.split("=", 2).map(decodeURIComponent),
        );
        let action;
        let otherUserKey;
        let secret;
        for (const [name, value] of params) {
            if (name === "action") {
                action = value;
            } else if (name.startsWith("key_")) {
                keys[name.substring("key_".length)] = value;
            } else if (name === "other_user_key") {
                otherUserKey = value;
            } else if (name === "secret") {
                secret = value;
            }
        }
        if (!secret || !otherUserKey || action !== "verify" || Object.keys(keys).length === 0) {
            throw newQRCodeError();
        }

        return {action, secret, otherUserKey, keys, targetUserId};
    }
}

ReciprocateQRCode.NAME = "m.reciprocate.v1";
