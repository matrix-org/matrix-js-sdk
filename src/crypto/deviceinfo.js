/*
Copyright 2016 OpenMarket Ltd

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
"use strict";

const olmlib = require("./olmlib");

/**
 * @module crypto/deviceinfo
 */

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
  * @param {string} ownerUserId ID of the user who owns this device
  * @param {Object} deviceList DeviceList - if supplied, isVerified can
  *     attempt to establish trust via cross-signing
  * @param {string} loggedinUserId ID of the logged-in user
  * @param {Object} olmDevice OlmDevice to use for signature verification
  */
function DeviceInfo(deviceId, ownerUserId, deviceList, loggedinUserId, olmDevice) {
    // you can't change the deviceId
    Object.defineProperty(this, 'deviceId', {
        enumerable: true,
        value: deviceId,
    });

    this._deviceList = deviceList;
    this._ownerUserId = ownerUserId;
    this._loggedinUserId = loggedinUserId;
    this._olmDevice = olmDevice;

    this.algorithms = [];
    this.keys = {};
    this.verified = DeviceVerification.UNVERIFIED;
    this.known = false;
    this.unsigned = {};
    this.signatures = null;
}

/**
 * rehydrate a DeviceInfo from the session store
 *
 * @param {object} obj  raw object from session store
 * @param {string} deviceId id of the device
 *
 * @return {module:crypto~DeviceInfo} new DeviceInfo
 */
DeviceInfo.fromStorage = function(obj, deviceId, ownerUserId, deviceList, loggedinUserId, olmDevice) {
    const res = new DeviceInfo(deviceId, ownerUserId, deviceList, loggedinUserId, olmDevice);
    for (const prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            res[prop] = obj[prop];
        }
    }
    return res;
};

/**
 * Prepare a DeviceInfo for JSON serialisation in the session store
 *
 * @return {object} deviceinfo with non-serialised members removed
 */
DeviceInfo.prototype.toStorage = function() {
    return {
        algorithms: this.algorithms,
        keys: this.keys,
        verified: this.verified,
        known: this.known,
        unsigned: this.unsigned,
        signatures: this.signatures,
    };
};

DeviceInfo.prototype.toDeviceObject = function() {
    return {
        algorithms: this.algorithms,
        keys: this.keys,
        signatures: this.signatures,
        user_id: this._ownerUserId,
        device_id: this.deviceId,
    };
};

/**
 * Get the fingerprint for this device (ie, the Ed25519 key)
 *
 * @return {string} base64-encoded fingerprint of this device
 */
DeviceInfo.prototype.getFingerprint = function() {
    return this.keys["ed25519:" + this.deviceId];
};

/**
 * Get the identity key for this device (ie, the Curve25519 key)
 *
 * @return {string} base64-encoded identity key of this device
 */
DeviceInfo.prototype.getIdentityKey = function() {
    return this.keys["curve25519:" + this.deviceId];
};

/**
 * Get the configured display name for this device, if any
 *
 * @return {string?} displayname
 */
DeviceInfo.prototype.getDisplayName = function() {
    return this.unsigned.device_display_name || null;
};

/**
 * Returns true if this device is blocked
 *
 * @return {Boolean} true if blocked
 */
DeviceInfo.prototype.isBlocked = function() {
    return this.verified == DeviceVerification.BLOCKED;
};

/**
 * Returns true if this device is verified
 *
 * @return {Boolean} true if verified
 */
DeviceInfo.prototype.isVerified = function() {
    if (this.verified === DeviceVerification.VERIFIED) {
        return true; // we've verified it ourselves
    } else if (this.verified === DeviceVerification.UNVERIFIED && this.isTrustedFromSsk()) {
        // If we haven't verified it directly, see if we can get a chain
        // of trust to it via cross-signing
        return DeviceVerification.VERIFIED;
    } else {
        return DeviceVerification.UNVERIFIED;
    }
};

DeviceInfo.prototype.isTrustedFromSsk = function() {
    // XXX this does signature verification in-line (ie. in the render method for react)
    const mySsk = this._deviceList.getStoredSskForUser(this._loggedinUserId);
    if (!mySsk) return false;
    if (!mySsk.isVerified()) return false;

    const sskPubkey = mySsk.getFingerprint();
    const deviceObject = this.toDeviceObject();

    try {
        olmlib.verifySignature(
            this._olmDevice,
            deviceObject,
            this._ownerUserId,
            sskPubkey,
            sskPubkey,
        );
        return true;
    } catch (e) {
    }
    return false;
};

/**
 * Returns true if this device is unverified
 *
 * @return {Boolean} true if unverified
 */
DeviceInfo.prototype.isUnverified = function() {
    //return this.verified == DeviceVerification.UNVERIFIED;
    // XXX: as with isVerified but is this right?
    return !this.isVerified();
};

/**
 * Returns true if the user knows about this device's existence
 *
 * @return {Boolean} true if known
 */
DeviceInfo.prototype.isKnown = function() {
    return this.known == true;
};

/**
 * @enum
 */
DeviceInfo.DeviceVerification = {
    VERIFIED: 1,
    UNVERIFIED: 0,
    BLOCKED: -1,
};

const DeviceVerification = DeviceInfo.DeviceVerification;

/** */
module.exports = DeviceInfo;
