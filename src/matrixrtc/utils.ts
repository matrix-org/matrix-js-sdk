/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import type { InboundEncryptionSession, ParticipantId } from "./types.ts";

/**
 * Detects when a key for a given index is outdated.
 */
export class OutdatedKeyFilter {
    // Map of participantId -> keyIndex -> timestamp
    private tsBuffer: Map<ParticipantId, Map<number, number>> = new Map();

    public constructor() {}

    /**
     * Check if there is a recent key with the same keyId (index) and then use the creationTS to decide what to
     * do with the key. If the key received is older than the one already in the buffer, it is ignored.
     * @param participantId
     * @param item
     */
    public isOutdated(participantId: ParticipantId, item: InboundEncryptionSession): boolean {
        if (!this.tsBuffer.has(participantId)) {
            this.tsBuffer.set(participantId, new Map<number, number>());
        }

        const latestTimestamp = this.tsBuffer.get(participantId)?.get(item.keyIndex);
        if (latestTimestamp && latestTimestamp > item.creationTS) {
            // The existing key is more recent, ignore this one
            return true;
        }
        this.tsBuffer.get(participantId)!.set(item.keyIndex, item.creationTS);
        return false;
    }
}

export function getParticipantId(userId: string, deviceId: string): ParticipantId {
    return `${userId}:${deviceId}`;
}
