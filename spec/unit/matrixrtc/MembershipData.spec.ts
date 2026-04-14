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