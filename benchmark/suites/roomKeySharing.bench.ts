/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { do_not_optimize, summary } from "mitata";
import { expect, it } from "vitest";

import { createRoomFixture, type RoomFixture } from "../harness/machines.ts";
import { benchmark } from "../harness/mitata.ts";
import { runSuite } from "../harness/report.ts";
import { warmUp } from "../harness/warmup.ts";

/** Recipient device counts to sweep. Sharing cost is dominated by the per-device Olm encryption. */
const DEVICE_COUNTS = [1, 10, 50];

it("megolm room key sharing", async () => {
    const fixtures = new Map<number, RoomFixture>();
    for (const deviceCount of DEVICE_COUNTS) {
        const fixture = await createRoomFixture({ liveRecipients: 1, extraDevices: deviceCount - 1 });
        expect(fixture.deviceCount).toBe(deviceCount);
        fixtures.set(deviceCount, fixture);
    }

    // A share must actually produce to-device traffic, otherwise we would be timing an early return.
    const probe = fixtures.get(1)!;
    expect(await probe.sender.shareRoomKey(probe.roomId, [probe.recipientUserId])).toBeGreaterThan(0);

    await warmUp(async () => {
        await probe.sender.invalidateRoomKey(probe.roomId);
        await probe.sender.shareRoomKey(probe.roomId, [probe.recipientUserId]);
        probe.hs.clearInboxes();
    });

    summary(() => {
        benchmark("shareRoomKey ($devices devices)", function* (state) {
            const fixture = fixtures.get(state.get<number>("devices"))!;
            yield {
                // Discarding the outbound session is what forces the next share to do real work.
                // Nothing here consumes the to-device events, so they also have to be dropped: over the
                // thousands of iterations mitata runs they would otherwise pile up and skew later samples.
                async [0]() {
                    await fixture.sender.invalidateRoomKey(fixture.roomId);
                    fixture.hs.clearInboxes();
                    return null;
                },
                async bench(_: null) {
                    do_not_optimize(await fixture.sender.shareRoomKey(fixture.roomId, [fixture.recipientUserId]));
                },
            };
        }).args("devices", DEVICE_COUNTS);
    });

    await runSuite("roomKeySharing");
});
