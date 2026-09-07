/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/** How long to exercise an operation before measuring it. */
const DEFAULT_BUDGET_MS = 1_000;

/**
 * Runs `operation` repeatedly so the engine has tiered up the wasm before any measurement starts.
 *
 * mitata takes only two warmup samples. That is far too few for SpiderMonkey to move off the wasm
 * baseline compiler, and because it also stops sampling after 642ms, a slow browser can finish a whole
 * benchmark while still running unoptimised code — which then reports as a large improvement the next
 * time the suite runs.
 */
export async function warmUp(operation: () => Promise<unknown>, budgetMs = DEFAULT_BUDGET_MS): Promise<void> {
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
        await operation();
    }
}
