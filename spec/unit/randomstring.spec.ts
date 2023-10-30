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
    randomLowercaseString,
    randomString,
    randomUppercaseString,
    secureRandomBase64Url,
} from "../../src/randomstring";

describe("Random strings", () => {
    it.each([8, 16, 32])("secureRandomBase64 generates %i valid base64 bytes", (n: number) => {
        const randb641 = secureRandomBase64Url(n);
        const randb642 = secureRandomBase64Url(n);

        expect(randb641).not.toEqual(randb642);

        const decoded = decodeBase64(randb641);
        expect(decoded).toHaveLength(n);
    });

    it.each([8, 16, 32])("randomString generates string of %i characters", (n: number) => {
        const rand1 = randomString(n);
        const rand2 = randomString(n);

        expect(rand1).not.toEqual(rand2);

        expect(rand1).toHaveLength(n);
    });

    it.each([8, 16, 32])("randomLowercaseString generates lowercase string of %i characters", (n: number) => {
        const rand1 = randomLowercaseString(n);
        const rand2 = randomLowercaseString(n);

        expect(rand1).not.toEqual(rand2);

        expect(rand1).toHaveLength(n);

        expect(rand1.toLowerCase()).toEqual(rand1);
    });

    it.each([8, 16, 32])("randomUppercaseString generates lowercase string of %i characters", (n: number) => {
        const rand1 = randomUppercaseString(n);
        const rand2 = randomUppercaseString(n);

        expect(rand1).not.toEqual(rand2);

        expect(rand1).toHaveLength(n);

        expect(rand1.toUpperCase()).toEqual(rand1);
    });
});
