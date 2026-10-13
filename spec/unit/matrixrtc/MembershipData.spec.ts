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

import { computeRtcIdentityRaw, isLeftMembershipContent } from "../../../src/matrixrtc/membershipData/index.ts";

describe("isLeftMembershipContent", () => {
    it("detects left memberships via member.membership", () => {
        expect(
            isLeftMembershipContent({
                slot_id: "m.call#ROOM",
                slot_event_id: "$slot",
                member: { id: "MEMBER", membership: "leave" },
                msc4354_sticky_key: "MEMBER",
            }),
        ).toBe(true);
    });

    it("detects left memberships predating member.membership", () => {
        expect(isLeftMembershipContent({ slot_id: "m.call#ROOM", msc4354_sticky_key: "MEMBER" })).toBe(true);
        expect(
            isLeftMembershipContent({ slot_id: "m.call#ROOM", slot_event_id: "$slot", msc4354_sticky_key: "MEMBER" }),
        ).toBe(true);
    });

    it("does not treat joined memberships as left", () => {
        expect(
            isLeftMembershipContent({
                slot_id: "m.call#ROOM",
                slot_event_id: "$slot",
                member: { id: "MEMBER", membership: "join" },
                application: { type: "m.call" },
                msc4354_sticky_key: "MEMBER",
            }),
        ).toBe(false);
    });
});

describe("computeRtcIdentityRaw", () => {
    it("should compute the correct identity hash", async () => {
        // Test vector taken from the spec, with the expected output updated to match the unpadded base64 encoding
        // https://github.com/hughns/matrix-spec-proposals/blob/hughns/matrixrtc-livekit/proposals/4195-matrixrtc-livekit.md#appendix-hash-derivation-test-vectors
        const result = await computeRtcIdentityRaw("@alice:example.com", "memberABC");
        // Add assertions based on expected hash output
        expect(result).toBe("M3VnsLXrkbxIDINXO64u8PZzFyD9ZYFiQULR2dshWYs");
    });
});
