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

import { sleep } from "./utils.ts";

/**
 * Ensures sticky events with the same room, event type and sticky key are sent in the order
 * they were queued and at least 1 millisecond apart. Otherwise both events could get the same
 * `origin_server_ts` which would make them tie break on event ID in the ephemeral sticky map.
 */
export class StickyEventSendQueue {
    /**
     * The latest send per room, event type and sticky key, resolving to when it completed.
     * The map key is the JSON serialization of [roomId, eventType, stickyKey].
     */
    private readonly latestSends = new Map<string, Promise<number>>();

    /**
     * Queues a send behind earlier sends with the same room, event type and sticky key.
     *
     * Call this before doing anything asynchronous, so that concurrent sends go out in the order
     * they were queued.
     *
     * @param roomId - The room the event is sent to.
     * @param eventType - The type of the event.
     * @param stickyKey - The sticky key of the event. Events without a sticky key are sent right away.
     * @param send - Sends the event.
     * @returns The result of `send`.
     */
    public enqueue<T>(
        roomId: string,
        eventType: string,
        stickyKey: string | undefined,
        send: () => Promise<T>,
    ): Promise<T> {
        if (stickyKey === undefined) {
            return send();
        }
        const key = JSON.stringify([roomId, eventType, stickyKey]);
        const previous = this.latestSends.get(key);
        // Await in an inner function rather than here, so that this send is recorded synchronously below.
        // Otherwise a send queued right after this one would wait for the one before it rather than for
        // this one.
        const result = (async (): Promise<T> => {
            if (previous) {
                const waitMs = (await previous) + 1 - Date.now();
                if (waitMs > 0) await sleep(waitMs);
            }
            return send();
        })();
        // Record when the send completed, whether or not it succeeded, for the next send to wait on.
        const completedAt = result.then(
            () => Date.now(),
            () => Date.now(),
        );
        this.latestSends.set(key, completedAt);
        // Once the gap has passed there is nothing left to wait for, so forget the key.
        void completedAt
            .then(() => sleep(1))
            .then(() => {
                if (this.latestSends.get(key) === completedAt) this.latestSends.delete(key);
            });
        return result;
    }
}
