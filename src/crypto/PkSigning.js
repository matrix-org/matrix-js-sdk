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

const anotherjson = require('another-json');

/**
 * Higher level wrapper around olm.PkSigning that signs JSON objects
 * @param {Object} obj Object to sign
 * @param {Uint8Array} seed The private key seed (32 bytes)
 * @param {string} userId The user ID who owns the signing key
 */
export function pkSign(obj, seed, userId) {
    const signing = new global.Olm.PkSigning();
    try {
        const pubkey = signing.init_with_seed(seed);
        const sigs = obj.signatures || {};
        const mysigs = sigs[userId] || {};
        sigs[userId] = mysigs;

        delete obj.signatures;
        const unsigned = obj.unsigned;
        if (obj.unsigned) delete obj.unsigned;

        mysigs['ed25519:' + pubkey] = signing.sign(anotherjson.stringify(obj));
        obj.signatures = sigs;
        if (unsigned) obj.unsigned = unsigned;
    } finally {
        signing.free();
    }
}
