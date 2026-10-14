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

import { type CallMembership } from "./CallMembership.ts";
import { type CallMembershipIdentityParts } from "./EncryptionManager.ts";
import { isUnstableLivekitTransportWithUrl, type UnstableLivekitTransportWithUrl } from "./LivekitTransport.ts";
import { isMyMembership } from "./types.ts";

/**
 * An SFU that another session member publishes on, which we may be able to publish on.
 *
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export interface LivekitPublishCandidate {
    /**
     * The WebSocket URL of the SFU.
     */
    url: string;
    /**
     * The homeserver that operates the SFU.
     */
    serverName: string;
    /**
     * The transport to advertise in our own membership should we publish on this SFU.
     */
    transport: UnstableLivekitTransportWithUrl & { server_name: string };
}

/**
 * Lists the SFUs of other session members that we may be able to publish on.
 *
 * The candidates are deduplicated and ordered by the age of the membership that advertises
 * them, oldest first.
 *
 * @param memberships The memberships of the session, in any order.
 * @param ownIdentity Our own identity, so that our own membership is skipped.
 * @experimental Part of [MSC4195](https://github.com/matrix-org/matrix-spec-proposals/pull/4195).
 */
export function getRemoteLivekitPublishCandidates(
    memberships: CallMembership[],
    ownIdentity: Pick<CallMembershipIdentityParts, "userId" | "deviceId">,
): LivekitPublishCandidate[] {
    const candidates = new Map<string, LivekitPublishCandidate>();
    const byAge = [...memberships].sort((a, b) => a.createdTs() - b.createdTs());
    for (const membership of byAge) {
        // Ignore our own membership.
        if (isMyMembership(membership, ownIdentity.userId, ownIdentity.deviceId)) continue;
        for (const transport of membership.transports) {
            // Only transports with a `url` qualify since remote publishing requires using the C-S API.
            if (!isUnstableLivekitTransportWithUrl(transport)) continue;
            const { url } = transport;
            const serverName = membership.getTransportServerName(transport);
            const key = JSON.stringify([url, serverName]);
            // Ignore duplicate candidates.
            if (candidates.has(key)) continue;
            candidates.set(key, {
                url,
                serverName,
                transport: { type: "livekit", url, server_name: serverName },
            });
        }
    }
    return [...candidates.values()]; // values() preserves insertion order.
}
