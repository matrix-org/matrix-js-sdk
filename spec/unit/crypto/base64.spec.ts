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

import {
    encodeBase64,
    decodeBase64,
    encodeUnpaddedBase64,
} from "../../../src/crypto/olmlib";

function parseAscii(string: string): Uint8Array {
    const out = new Uint8Array(string.length);
    for (let i = 0; i < string.length; ++i) {
        out[i] = string.charCodeAt(i);
    }
    return out;
}

describe("Base64", function() {
    describe("base64", function() {
        const paddedVectors = [
            ['', ''],
            ['f', 'Zg=='],
            ['fo', 'Zm8='],
            ['foo', 'Zm9v'],
            ['foob', 'Zm9vYg=='],
            ['fooba', 'Zm9vYmE='],
            ['foobar', 'Zm9vYmFy'],
            ['>>>>', 'Pj4+Pg=='],
            ['????', 'Pz8/Pw=='],
        ];

        for (const [data, encoded] of paddedVectors) {
            it(`base64 round-trips "${encoded}"`, function() {
                const dataAsArray = parseAscii(data);
                expect(encodeBase64(dataAsArray)).toEqual(encoded);
                expect(decodeBase64(encoded).toString()).toEqual(data);
            });
        }
    });

    describe("unpadded base64", function() {
        const unpaddedVectors = [
            ['', ''],
            ['f', 'Zg'],
            ['fo', 'Zm8'],
            ['foo', 'Zm9v'],
            ['foob', 'Zm9vYg'],
            ['fooba', 'Zm9vYmE'],
            ['foobar', 'Zm9vYmFy'],
            ['>>>>', 'Pj4+Pg'],
            ['????', 'Pz8/Pw'],
        ];

        for (const [data, encoded] of unpaddedVectors) {
            it(`unpadded base64 round-trips "${encoded}"`, function() {
                const dataAsArray = parseAscii(data);
                expect(encodeUnpaddedBase64(dataAsArray)).toEqual(encoded);
                expect(decodeBase64(encoded).toString()).toEqual(data);
            });
        }
    });
});
