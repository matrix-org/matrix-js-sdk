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

import base58check from 'base58check';

// picked arbitrarily but to try & avoid clashing with any bitcoin ones
const OLM_RECOVERY_KEY_PREFIX = [0x8B, 0x01];

export function encodeRecoveryKey(key) {
    const base58key = base58check.encode(Buffer.from(OLM_RECOVERY_KEY_PREFIX), Buffer.from(key));
    return base58key.match(/.{1,4}/g).join(" ");
}

export function decodeRecoveryKey(recoverykey) {
    const result = base58check.decode(recoverykey.replace(/ /, ''));
    // the encoding doesn't include the length of the prefix, so the
    // decoder assumes it's 1 byte. sigh.
    const prefix = Buffer.concat([result.prefix, result.data.slice(0, OLM_RECOVERY_KEY_PREFIX.length - 1)]);

    if (!prefix.equals(Buffer.from(OLM_RECOVERY_KEY_PREFIX))) {
        throw new Error("Incorrect prefix");
    }

    const key = result.data.slice(OLM_RECOVERY_KEY_PREFIX.length - 1);

    if (key.length !== global.Olm.PRIVATE_KEY_LENGTH) {
        throw new Error("Incorrect length");
    }

    return key;
}
