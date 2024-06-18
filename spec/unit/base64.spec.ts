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
import NodeBuffer from "node:buffer";

import { decodeBase64, encodeBase64, encodeUnpaddedBase64, encodeUnpaddedBase64Url } from "../../src/base64";

describe.each(["browser", "node"])("Base64 encoding (%s)", (env) => {
    let origBuffer = Buffer;

    beforeAll(() => {
        if (env === "browser") {
            origBuffer = Buffer;
            // @ts-ignore
            // eslint-disable-next-line no-global-assign
            Buffer = undefined;

            global.atob = NodeBuffer.atob;
            global.btoa = NodeBuffer.btoa;
        }
    });

    afterAll(() => {
        // eslint-disable-next-line no-global-assign
        Buffer = origBuffer;
        // @ts-ignore
        global.atob = undefined;
        // @ts-ignore
        global.btoa = undefined;
    });

    it("Should decode properly encoded data", () => {
        const decoded = new TextDecoder().decode(decodeBase64("ZW5jb2RpbmcgaGVsbG8gd29ybGQ="));

        expect(decoded).toStrictEqual("encoding hello world");
    });

    it("Should encode unpadded URL-safe base64", () => {
        // Chosen to have padding and multiple instances of / and + in the base64
        const toEncode = "???????⊕⊗⊗";
        const data = new TextEncoder().encode(toEncode);

        const encoded = encodeUnpaddedBase64Url(data);
        expect(encoded).toEqual("Pz8_Pz8_P-KKleKKl-KKlw");
    });

    it("Should decode URL-safe base64", () => {
        const decoded = new TextDecoder().decode(decodeBase64("Pz8_Pz8_P-KKleKKl-KKlw=="));

        expect(decoded).toStrictEqual("???????⊕⊗⊗");
    });

    it("Encode unpadded should not have padding", () => {
        const toEncode = "encoding hello world";
        const data = new TextEncoder().encode(toEncode);

        const paddedEncoded = encodeBase64(data);
        const unpaddedEncoded = encodeUnpaddedBase64(data);

        expect(paddedEncoded).not.toEqual(unpaddedEncoded);

        const padding = paddedEncoded.charAt(paddedEncoded.length - 1);
        expect(padding).toStrictEqual("=");
    });

    it("Decode should be indifferent to padding", () => {
        const withPadding = "ZW5jb2RpbmcgaGVsbG8gd29ybGQ=";
        const withoutPadding = "ZW5jb2RpbmcgaGVsbG8gd29ybGQ";

        const decodedPad = decodeBase64(withPadding);
        const decodedNoPad = decodeBase64(withoutPadding);

        expect(decodedPad).toStrictEqual(decodedNoPad);
    });
});
