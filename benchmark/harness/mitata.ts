/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type B, bench } from "mitata";

/** mitata's per-benchmark argument state; the package does not export its own type for it. */
export interface BenchState {
    get<T>(name: string): T;
}

type BenchBody = (state: BenchState) => Generator<unknown, void, undefined>;

/**
 * `bench`, with the argument state typed.
 *
 * mitata's published overloads only describe generators that yield a bare function, so the
 * `{ [0]: setup, bench: fn }` form used for untimed per-iteration setup does not type check
 * against them.
 */
export function benchmark(name: string, body: BenchBody): B {
    return bench(name, body as never);
}
