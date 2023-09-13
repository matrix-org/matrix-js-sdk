/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { TextEncoder, TextDecoder } from "util";

import { decodeBase64, encodeBase64, encodeUnpaddedBase64 } from "../../../src/common-crypto/base64";

describe("Crypto Base64 encoding", () => {
    it("Should decode properly encoded data", async () => {
        const toEncode = "encoding hello world";
        const encoded = encodeBase64(new TextEncoder().encode(toEncode));
        const decoded = new TextDecoder().decode(decodeBase64(encoded));

        expect(decoded).toStrictEqual(toEncode);
    });

    it("Encode unpadded should not have padding", async () => {
        const toEncode = "encoding hello world";
        const data = new TextEncoder().encode(toEncode);

        const paddedEncoded = encodeBase64(data);
        const unpaddedEncoded = encodeUnpaddedBase64(data);

        expect(paddedEncoded).not.toEqual(unpaddedEncoded);

        const padding = paddedEncoded.charAt(paddedEncoded.length - 1);
        expect(padding).toStrictEqual("=");
    });

    it("Decode should be indifferent to padding", async () => {
        const withPadding = "ZW5jb2RpbmcgaGVsbG8gd29ybGQ=";
        const withoutPadding = "ZW5jb2RpbmcgaGVsbG8gd29ybGQ";

        const decodedPad = decodeBase64(withPadding);
        const decodedNoPad = decodeBase64(withoutPadding);

        expect(decodedPad).toStrictEqual(decodedNoPad);
    });
});
