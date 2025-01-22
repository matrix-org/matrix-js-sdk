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

import { decodeBase64 } from "../../src/base64";
import {
    secureRandomString,
    secureRandomBase64Url,
    secureRandomStringFrom,
    LOWERCASE,
    UPPERCASE,
} from "../../src/randomstring";

describe("Random strings", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each([8, 16, 32])("secureRandomBase64 generates %i valid base64 bytes", (n: number) => {
        const randb641 = secureRandomBase64Url(n);
        const randb642 = secureRandomBase64Url(n);

        expect(randb641).not.toEqual(randb642);

        const decoded = decodeBase64(randb641);
        expect(decoded).toHaveLength(n);
    });

    it.each([8, 16, 32])("secureRandomString generates string of %i characters", (n: number) => {
        const rand1 = secureRandomString(n);
        const rand2 = secureRandomString(n);

        expect(rand1).not.toEqual(rand2);

        expect(rand1).toHaveLength(n);
    });

    it.each([8, 16, 32])(
        "secureRandomStringFrom generates lowercase string of %i characters when given lowercase",
        (n: number) => {
            const rand1 = secureRandomStringFrom(n, LOWERCASE);
            const rand2 = secureRandomStringFrom(n, LOWERCASE);

            expect(rand1).not.toEqual(rand2);

            expect(rand1).toHaveLength(n);

            expect(rand1.toLowerCase()).toEqual(rand1);
        },
    );

    it.each([8, 16, 32])(
        "secureRandomStringFrom generates uppercase string of %i characters when given uppercase",
        (n: number) => {
            const rand1 = secureRandomStringFrom(n, UPPERCASE);
            const rand2 = secureRandomStringFrom(n, UPPERCASE);

            expect(rand1).not.toEqual(rand2);

            expect(rand1).toHaveLength(n);

            expect(rand1.toUpperCase()).toEqual(rand1);
        },
    );

    it("throws if given character set less than 2 characters", () => {
        expect(() => secureRandomStringFrom(8, "a")).toThrow();
    });

    it("throws if given character set more than 256 characters", () => {
        const charSet = Array.from({ length: 257 }, (_, i) => "a").join("");

        expect(() => secureRandomStringFrom(8, charSet)).toThrow();
    });

    it("throws if given length less than 1", () => {
        expect(() => secureRandomStringFrom(0, "abc")).toThrow();
    });

    it("throws if given length more than 32768", () => {
        expect(() => secureRandomStringFrom(32769, "abc")).toThrow();
    });

    it("asks for more entropy if given entropy is unusable", () => {
        // This is testing the internal implementation details of the function rather
        // than strictly the public API. The intention is to have some assertion that
        // the rejection sampling to make the distribution even over all possible characters
        // is doing what it's supposed to do.

        // mock once to fill with 255 the first time: 255 should be unusable because
        // we give 10 possible characters below and 256 is not evenly divisible by 10, so
        // this should force it to call for more entropy.
        jest.spyOn(globalThis.crypto, "getRandomValues").mockImplementationOnce((arr) => {
            if (arr === null) throw new Error("Buffer is null");
            new Uint8Array(arr.buffer).fill(255);
            return arr;
        });

        secureRandomStringFrom(8, "0123456789");
        expect(globalThis.crypto.getRandomValues).toHaveBeenCalledTimes(2);
    });
});
