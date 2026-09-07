/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,";

/**
 * Deterministic pseudo-random ASCII of a given length.
 *
 * Deterministic so every build sees identical input, and pseudo-random so nothing downstream can
 * shortcut on repetition.
 */
export function textOfSize(bytes: number, seed = 1): string {
    let state = seed >>> 0 || 1;
    const chars = new Array<string>(bytes);
    for (let i = 0; i < bytes; i++) {
        // xorshift32
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        chars[i] = ALPHABET[state % ALPHABET.length]!;
    }
    return chars.join("");
}

/** A message event body of approximately `bytes` bytes once serialised. */
export function messageContent(bytes: number, seed = 1): string {
    return JSON.stringify({ msgtype: "m.text", body: textOfSize(bytes, seed) });
}
