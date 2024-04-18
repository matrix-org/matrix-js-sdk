/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { logger } from "../logger";

export let crypto = globalThis.window?.crypto;
export let subtleCrypto = globalThis.window?.crypto?.subtle ?? global.window?.crypto?.webkitSubtle;
export let TextEncoder = globalThis.window?.TextEncoder;

/* eslint-disable @typescript-eslint/no-var-requires */
if (!crypto) {
    try {
        crypto = require("crypto").webcrypto;
    } catch (e) {
        logger.error("Failed to load webcrypto", e);
    }
}
if (!subtleCrypto) {
    subtleCrypto = crypto?.subtle;
}
if (!TextEncoder) {
    try {
        TextEncoder = require("util").TextEncoder;
    } catch (e) {
        logger.error("Failed to load TextEncoder util", e);
    }
}
/* eslint-enable @typescript-eslint/no-var-requires */

// Service workers don't have a useful `window` instance to pull these details off of, and in at least Chrome when
// `window.$thing` is accessed, `$thing` will be non-null but complain about being undefined when accessed further.
// To avoid spurious errors, we just override the crypto bits explicitly.
if (isServiceWorker(globalThis)) {
    crypto = globalThis.crypto;
    subtleCrypto = globalThis.crypto.subtle ?? globalThis.crypto.webkitSubtle;
    TextEncoder = globalThis.TextEncoder;
}

// Window is a close enough approximation for what we need it for.
function isServiceWorker(globalThis: any): globalThis is Window {
    // Note: `skipWaiting` is a function exclusive to service workers.
    return typeof globalThis["skipWaiting"] === "function";
}

export function setCrypto(_crypto: Crypto): void {
    crypto = _crypto;
    subtleCrypto = _crypto.subtle ?? _crypto.webkitSubtle;
}

export function setTextEncoder(_TextEncoder: typeof TextEncoder): void {
    TextEncoder = _TextEncoder;
}
