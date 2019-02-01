/*
Copyright 2019 New Vector Ltd

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
 * @module crypto/sskinfo
 */

/**
  * Information about a user's self-signing key
  *
  * @constructor
  * @alias module:crypto/sskinfo
  *
  * @property {Object.<string,string>} keys a map from
  *      &lt;key type&gt;:&lt;id&gt; -> &lt;base64-encoded key&gt;>
  *
  * @property {module:crypto/sskinfo.SskVerification} verified
  *     whether the device has been verified/blocked by the user
  *
  * @property {boolean} known
  *     whether the user knows of this device's existence (useful when warning
  *     the user that a user has added new devices)
  *
  * @property {Object} unsigned  additional data from the homeserver
  */
export default class SskInfo {
    constructor() {
        this.keys = {};
        this.verified = SskInfo.SskVerification.UNVERIFIED;
        //this.known = false; // is this useful?
        this.unsigned = {};
    }

    /**
     * @enum
     */
    static SskVerification = {
        VERIFIED: 1,
        UNVERIFIED: 0,
        BLOCKED: -1,
    };

    static fromStorage(obj) {
        const res = new SskInfo();
        for (const [prop, val] of Object.entries(obj)) {
            res[prop] = val;
        }
        return res;
    }

    getFingerprint() {
        return Object.values(this.keys)[0];
    }

    isVerified() {
        return this.verified == SskInfo.SskVerification.VERIFIED;
    };

    isUnverified() {
        return this.verified == SskInfo.SskVerification.UNVERIFIED;
    };
}
