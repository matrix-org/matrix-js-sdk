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

import { EventType } from "../../../src/@types/event.ts";
import { CallMembership } from "../../../src/matrixrtc/CallMembership.ts";
import { getRemoteLivekitPublishCandidates } from "../../../src/matrixrtc/LivekitPublishCandidates.ts";
import { type Transport } from "../../../src/matrixrtc/types.ts";
import { makeMockEvent, rtcMembershipTemplate } from "./mocks.ts";

const own = { userId: "@alice:alice.com", deviceId: "ALICE" };

function membership(userId: string, deviceId: string, createdTs: number, published: Transport[]): CallMembership {
    const { user_id: _, ...content } = rtcMembershipTemplate;
    const ev = makeMockEvent(
        EventType.RTCMembership,
        userId,
        "!room:example.org",
        {
            ...content,
            member: { ...content.member, user_id: userId, device_id: deviceId, id: `${userId}:${deviceId}` },
            transports: { published, can_subscribe: ["livekit"] },
        },
        createdTs,
    );
    return new CallMembership(ev, CallMembership.membershipDataFromMatrixEvent(ev), [], "(deprecated)");
}

const bobSfu = { type: "livekit", url: "wss://livekit.bob.com" };
const carolSfu = { type: "livekit", url: "wss://livekit.carol.com" };

describe("getRemoteLivekitPublishCandidates", () => {
    it("returns nothing for an empty session", () => {
        expect(getRemoteLivekitPublishCandidates([], own)).toEqual([]);
    });

    it("builds a publishable transport with server_name from a member's own SFU", () => {
        const candidates = getRemoteLivekitPublishCandidates([membership("@bob:bob.com", "B", 100, [bobSfu])], own);
        expect(candidates).toEqual([
            {
                url: "wss://livekit.bob.com",
                serverName: "bob.com",
                transport: { type: "livekit", url: bobSfu.url, server_name: "bob.com" },
            },
        ]);
    });

    it("orders candidates by membership age, oldest first", () => {
        const candidates = getRemoteLivekitPublishCandidates(
            [membership("@carol:carol.com", "C", 300, [carolSfu]), membership("@bob:bob.com", "B", 100, [bobSfu])],
            own,
        );
        expect(candidates.map((c) => c.url)).toEqual([bobSfu.url, carolSfu.url]);
    });

    it("skips our own membership", () => {
        const candidates = getRemoteLivekitPublishCandidates(
            [
                membership(own.userId, own.deviceId, 50, [{ type: "livekit", url: "wss://livekit.alice.com" }]),
                membership("@bob:bob.com", "B", 100, [bobSfu]),
            ],
            own,
        );
        expect(candidates.map((c) => c.url)).toEqual([bobSfu.url]);
    });

    it("skips transports without a url", () => {
        const candidates = getRemoteLivekitPublishCandidates(
            [
                membership("@bob:bob.com", "B", 100, [
                    { type: "livekit", livekit_service_url: "https://jwt.bob.com" },
                    { type: "other" },
                ]),
                membership("@carol:carol.com", "C", 300, [carolSfu]),
            ],
            own,
        );
        expect(candidates.map((c) => c.url)).toEqual([carolSfu.url]);
    });

    it("drops livekit_service_url from a transitional transport", () => {
        const candidates = getRemoteLivekitPublishCandidates(
            [
                membership("@bob:bob.com", "B", 100, [
                    { type: "livekit", url: "wss://livekit.bob.com", livekit_service_url: "https://jwt.bob.com" },
                ]),
            ],
            own,
        );
        expect(candidates[0].transport).toEqual({
            type: "livekit",
            url: bobSfu.url,
            server_name: "bob.com",
        });
    });

    it("follows a remote publisher's server_name to the SFU's owner", () => {
        // Dave has no SFU of his own and publishes on Bob's. He is the oldest member, but the candidate
        // must still be requested from bob.com, not dave.com.
        const candidates = getRemoteLivekitPublishCandidates(
            [
                membership("@dave:dave.com", "D", 10, [{ ...bobSfu, server_name: "bob.com" }]),
                membership("@bob:bob.com", "B", 100, [bobSfu]),
            ],
            own,
        );
        expect(candidates).toEqual([
            {
                url: "wss://livekit.bob.com",
                serverName: "bob.com",
                transport: { type: "livekit", url: bobSfu.url, server_name: "bob.com" },
            },
        ]);
    });

    it("lists the same url on different homeservers separately", () => {
        const candidates = getRemoteLivekitPublishCandidates(
            [membership("@bob:bob.com", "B", 100, [bobSfu]), membership("@carol:carol.com", "C", 300, [{ ...bobSfu }])],
            own,
        );
        expect(candidates.map((c) => c.serverName)).toEqual(["bob.com", "carol.com"]);
    });
});
