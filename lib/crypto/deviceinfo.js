"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DeviceInfo = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

/*
Copyright 2016 - 2021 The Matrix.org Foundation C.I.C.

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
 * @module crypto/deviceinfo
 */
var DeviceVerification;
/**
  * Information about a user's device
  *
  * @constructor
  * @alias module:crypto/deviceinfo
  *
  * @property {string} deviceId the ID of this device
  *
  * @property {string[]} algorithms list of algorithms supported by this device
  *
  * @property {Object.<string,string>} keys a map from
  *      &lt;key type&gt;:&lt;id&gt; -> &lt;base64-encoded key&gt;>
  *
  * @property {module:crypto/deviceinfo.DeviceVerification} verified
  *     whether the device has been verified/blocked by the user
  *
  * @property {boolean} known
  *     whether the user knows of this device's existence (useful when warning
  *     the user that a user has added new devices)
  *
  * @property {Object} unsigned  additional data from the homeserver
  *
  * @param {string} deviceId id of the device
  */

(function (DeviceVerification) {
  DeviceVerification[DeviceVerification["Blocked"] = -1] = "Blocked";
  DeviceVerification[DeviceVerification["Unverified"] = 0] = "Unverified";
  DeviceVerification[DeviceVerification["Verified"] = 1] = "Verified";
})(DeviceVerification || (DeviceVerification = {}));

class DeviceInfo {
  /**
   * rehydrate a DeviceInfo from the session store
   *
   * @param {object} obj  raw object from session store
   * @param {string} deviceId id of the device
   *
   * @return {module:crypto~DeviceInfo} new DeviceInfo
   */
  static fromStorage(obj, deviceId) {
    const res = new DeviceInfo(deviceId);

    for (const prop in obj) {
      if (obj.hasOwnProperty(prop)) {
        res[prop] = obj[prop];
      }
    }

    return res;
  }
  /**
   * @enum
   */


  constructor(deviceId) {
    this.deviceId = deviceId;
    (0, _defineProperty2.default)(this, "algorithms", void 0);
    (0, _defineProperty2.default)(this, "keys", {});
    (0, _defineProperty2.default)(this, "verified", DeviceVerification.Unverified);
    (0, _defineProperty2.default)(this, "known", false);
    (0, _defineProperty2.default)(this, "unsigned", {});
    (0, _defineProperty2.default)(this, "signatures", {});
  }
  /**
   * Prepare a DeviceInfo for JSON serialisation in the session store
   *
   * @return {object} deviceinfo with non-serialised members removed
   */


  toStorage() {
    return {
      algorithms: this.algorithms,
      keys: this.keys,
      verified: this.verified,
      known: this.known,
      unsigned: this.unsigned,
      signatures: this.signatures
    };
  }
  /**
   * Get the fingerprint for this device (ie, the Ed25519 key)
   *
   * @return {string} base64-encoded fingerprint of this device
   */


  getFingerprint() {
    return this.keys["ed25519:" + this.deviceId];
  }
  /**
   * Get the identity key for this device (ie, the Curve25519 key)
   *
   * @return {string} base64-encoded identity key of this device
   */


  getIdentityKey() {
    return this.keys["curve25519:" + this.deviceId];
  }
  /**
   * Get the configured display name for this device, if any
   *
   * @return {string?} displayname
   */


  getDisplayName() {
    return this.unsigned.device_display_name || null;
  }
  /**
   * Returns true if this device is blocked
   *
   * @return {Boolean} true if blocked
   */


  isBlocked() {
    return this.verified == DeviceVerification.Blocked;
  }
  /**
   * Returns true if this device is verified
   *
   * @return {Boolean} true if verified
   */


  isVerified() {
    return this.verified == DeviceVerification.Verified;
  }
  /**
   * Returns true if this device is unverified
   *
   * @return {Boolean} true if unverified
   */


  isUnverified() {
    return this.verified == DeviceVerification.Unverified;
  }
  /**
   * Returns true if the user knows about this device's existence
   *
   * @return {Boolean} true if known
   */


  isKnown() {
    return this.known === true;
  }

}

exports.DeviceInfo = DeviceInfo;
(0, _defineProperty2.default)(DeviceInfo, "DeviceVerification", {
  VERIFIED: DeviceVerification.Verified,
  UNVERIFIED: DeviceVerification.Unverified,
  BLOCKED: DeviceVerification.Blocked
});