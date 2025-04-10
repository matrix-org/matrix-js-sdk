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

type BufferEntry = {
    keys: Map<number, InboundEncryptionSession>;
    timeout: any;
};

/**
 * Holds the key received for a few seconds before dropping them in order to support some edge case with
 * out of order keys.
 */
export class KeyBuffer {
    private readonly ttl;

    private buffer: Map<ParticipantId, BufferEntry> = new Map();

    public constructor(ttl?: number) {
        this.ttl = ttl ?? 1000; // Default 1 second
    }

    /**
     * Check if there is a recent key with the same keyId (index) and then use the creationTS to decide what to
     * do with the key. If the key received is older than the one already in the buffer, it is ignored.
     * @param participantId
     * @param item
     */
    public disambiguate(participantId: ParticipantId, item: InboundEncryptionSession): InboundEncryptionSession | null {
        if (!this.buffer.has(participantId)) {
            const timeout = setTimeout(() => {
                this.buffer.delete(participantId);
            }, this.ttl);

            const map = new Map<number, InboundEncryptionSession>();
            map.set(item.keyId, item);
            const entry: BufferEntry = {
                keys: map,
                timeout,
            };
            this.buffer.set(participantId, entry);
            return item;
        }

        const entry = this.buffer.get(participantId)!;
        clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
            this.buffer.delete(participantId);
        }, this.ttl);

        const existing = entry.keys.get(item.keyId);
        if (existing && existing.creationTS > item.creationTS) {
            // The existing is more recent just ignore this one, it is a key received out of order
            return null;
        } else {
            entry.keys.set(item.keyId, item);
            return item;
        }
    }

    public clear(): void {
        this.buffer.forEach((entry) => {
            clearTimeout(entry.timeout);
        });
        this.buffer.clear();
    }
}
