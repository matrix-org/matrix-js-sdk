/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { do_not_optimize, summary } from "mitata";
import { expect, it } from "vitest";

import { createRoomFixture, shareAndDeliverRoomKey, wireEvent } from "../harness/machines.ts";
import { benchmark } from "../harness/mitata.ts";
import { messageContent } from "../harness/payload.ts";
import { runSuite } from "../harness/report.ts";
import { warmUp } from "../harness/warmup.ts";

const PAYLOAD_SIZES = [256, 4096, 65536];

it("megolm event decryption", async () => {
    const fixture = await createRoomFixture({ liveRecipients: 1 });
    await shareAndDeliverRoomKey(fixture);

    const recipient = fixture.recipients[0]!;

    // Each size gets one fixed event, decrypted over and over.
    //
    // Cycling through a pool instead would drag the megolm ratchet backwards on every wrap-around, and the
    // resulting re-derivation cost would swamp the thing we actually want to see: the AES/HMAC and
    // marshalling work per event.
    const events = new Map<number, string>();
    for (const [index, bytes] of PAYLOAD_SIZES.entries()) {
        const encrypted = await fixture.sender.encryptRoomEvent(
            fixture.roomId,
            "m.room.message",
            messageContent(bytes),
        );
        const event = wireEvent(fixture.sender.userId, encrypted, index);
        const decrypted = await recipient.decryptRoomEvent(fixture.roomId, event);
        expect(JSON.parse(decrypted.event).content.body).toHaveLength(bytes);
        events.set(bytes, event);
    }

    await warmUp(async () => await recipient.decryptRoomEvent(fixture.roomId, events.get(PAYLOAD_SIZES[0]!)!));

    summary(() => {
        benchmark("decryptRoomEvent ($bytes B)", function* (state) {
            const event = events.get(state.get<number>("bytes"))!;
            yield async () => {
                do_not_optimize(await recipient.decryptRoomEvent(fixture.roomId, event));
            };
        }).args("bytes", PAYLOAD_SIZES);
    });

    await runSuite("decrypt");
});
