/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { computeRtcIdentityRaw } from "../../../src/matrixrtc/membershipData/index.ts";

describe("computeRtcIdentityRaw", () => {
    it("should compute the correct identity hash", async () => {
        // Test vector taken from the spec, with the expected output updated to match the unpadded base64 encoding
        // https://github.com/hughns/matrix-spec-proposals/blob/hughns/matrixrtc-livekit/proposals/4195-matrixrtc-livekit.md#appendix-hash-derivation-test-vectors
        const result = await computeRtcIdentityRaw("@alice:example.com", "DEVICE123", "memberABC");
        // Add assertions based on expected hash output
        expect(result).toBe("J+T45tGruxc+HrUOqJJlyQSV33m728Cme4+vt8/SWrU");
    });
});
