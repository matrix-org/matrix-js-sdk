/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { do_not_optimize, summary } from "mitata";
import { expect, it } from "vitest";

import { createRoomFixture, rotatingEncryptor, shareAndDeliverRoomKey, wireEvent } from "../harness/machines.ts";
import { benchmark } from "../harness/mitata.ts";
import { messageContent } from "../harness/payload.ts";
import { runSuite } from "../harness/report.ts";
import { warmUp } from "../harness/warmup.ts";

const PAYLOAD_SIZES = [256, 4096, 65536];

it("megolm event encryption", async () => {
    const fixture = await createRoomFixture({ liveRecipients: 1 });
    await shareAndDeliverRoomKey(fixture);

    // Prove the pipeline actually works, so we can never end up benchmarking a no-op.
    const probe = await fixture.sender.encryptRoomEvent(fixture.roomId, "m.room.message", messageContent(64));
    const decrypted = await fixture.recipients[0]!.decryptRoomEvent(
        fixture.roomId,
        wireEvent(fixture.sender.userId, probe, 0),
    );
    expect(JSON.parse(decrypted.event).content.body).toBe(JSON.parse(messageContent(64)).body);

    const encrypt = rotatingEncryptor(fixture);

    await warmUp(async () => await encrypt(messageContent(256)));

    summary(() => {
        benchmark("encryptRoomEvent ($bytes B)", function* (state) {
            const content = messageContent(state.get<number>("bytes"));
            yield async () => {
                do_not_optimize(await encrypt(content));
            };
        }).args("bytes", PAYLOAD_SIZES);
    });

    await runSuite("encrypt");
});
