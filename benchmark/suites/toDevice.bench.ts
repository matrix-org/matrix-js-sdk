/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { do_not_optimize, summary } from "mitata";
import { expect, it } from "vitest";

import { type ToDeviceEvent } from "../harness/fakeHomeserver.ts";
import { createRoomFixture } from "../harness/machines.ts";
import { benchmark } from "../harness/mitata.ts";
import { runSuite } from "../harness/report.ts";
import { warmUp } from "../harness/warmup.ts";

/**
 * Number of inbound `m.room_key` events per `receiveSyncChanges` call.
 *
 * mitata stops a benchmark once it has 12 samples and 642ms of measured time, so a batch that takes tens
 * of milliseconds yields the bare minimum 12 samples and a percentile spread too wide to compare builds
 * against. These sizes keep a batch cheap enough to collect a useful number of samples; the per-key cost
 * is what matters here, and larger batches only multiply it.
 */
const BATCH_SIZES = [1, 4, 16];

it("to-device room key receipt", async () => {
    const fixture = await createRoomFixture({ liveRecipients: 1 });
    const recipient = fixture.recipients[0]!;

    /** Rotates the room key `count` times and collects what lands in the recipient's inbox. */
    async function collectRoomKeyEvents(count: number): Promise<ToDeviceEvent[]> {
        const events: ToDeviceEvent[] = [];
        for (let i = 0; i < count; i++) {
            await fixture.sender.invalidateRoomKey(fixture.roomId);
            await fixture.sender.shareRoomKey(fixture.roomId, [fixture.recipientUserId]);
            events.push(...fixture.hs.takeInbox(recipient.userId, recipient.deviceId));
        }
        return events;
    }

    const probe = await collectRoomKeyEvents(1);
    expect(probe).toHaveLength(1);
    expect(await recipient.receiveToDevice(probe)).toHaveLength(1);

    await warmUp(async () => await recipient.receiveToDevice(await collectRoomKeyEvents(1)));

    summary(() => {
        benchmark("receiveSyncChanges ($keys room keys)", function* (state) {
            const count = state.get<number>("keys");
            yield {
                async [0]() {
                    return await collectRoomKeyEvents(count);
                },
                async bench(events: ToDeviceEvent[]) {
                    do_not_optimize(await recipient.receiveToDevice(events));
                },
            };
        }).args("keys", BATCH_SIZES);
    });

    await runSuite("toDevice");
});
