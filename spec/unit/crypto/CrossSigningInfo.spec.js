/*
Copyright 2020 New Vector Ltd
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

import '../../olm-loader';
import { CrossSigningInfo } from '../../../src/crypto/CrossSigning';

const userId = "@alice:example.com";

const masterKey = new Uint8Array([
    0xda, 0x5a, 0x27, 0x60, 0xe3, 0x3a, 0xc5, 0x82,
    0x9d, 0x12, 0xc3, 0xbe, 0xe8, 0xaa, 0xc2, 0xef,
    0xae, 0xb1, 0x05, 0xc1, 0xe7, 0x62, 0x78, 0xa6,
    0xd7, 0x1f, 0xf8, 0x2c, 0x51, 0x85, 0xf0, 0x1d,
]);
const masterKeyPub = "nqOvzeuGWT/sRx3h7+MHoInYj3Uk2LD/unI9kDYcHwk";

describe("CrossSigningInfo.getCrossSigningKey()", function() {
    if (!global.Olm) {
        console.warn('Not running megolm backup unit tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return global.Olm.init();
    });

    it("Throws if no callback is provided", async () => {
        const info = new CrossSigningInfo(userId);
        await expect(info.getCrossSigningKey("master")).rejects.toThrow();
    });

    it("Throws if the callback returns falsey", async () => {
        const info = new CrossSigningInfo(userId, {
            getCrossSigningKey: () => false
        });
        await expect(info.getCrossSigningKey("master")).rejects.toThrow("falsey");
    });

    it("Throws if the expected key doesn't come back", async () => {
        const info = new CrossSigningInfo(userId, {
            getCrossSigningKey: () => masterKeyPub
        });
        await expect(info.getCrossSigningKey("master", "")).rejects.toThrow();
    });

    it("Returns a key from its callback", async () => {
        const info = new CrossSigningInfo(userId, {
            getCrossSigningKey: () => masterKey
        });
        const [ pubKey, ab ] = await info.getCrossSigningKey("master", masterKeyPub);
        expect(pubKey).toEqual(masterKeyPub);
        expect(ab).toEqual({a: 106712, b: 106712});
    });
});
