/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { type Plugin, defineConfig } from "vitest/config";

import { benchServerPlugin } from "./harness/serverPlugin.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const resultsDir = fileURLToPath(new URL("./results", import.meta.url));

/**
 * mitata probes for host capabilities it can only have under Node/Deno: an optional native counters addon,
 * CPU details from `os`, and heap statistics from `v8`. Every probe is wrapped in a try/catch and never
 * runs in a browser, but Vite still has to resolve the specifiers, and its externalisation stubs log a
 * warning per probe that buries the benchmark output. Resolving them to an inert module keeps both quiet.
 */
function stubMitataHostProbes(): Plugin {
    const stubbed = new Set(["@mitata/counters", "os", "node:os", "v8", "node:v8"]);
    const resolvedId = "\0matrix-js-sdk:mitata-host-probe";
    return {
        name: "matrix-js-sdk:bench-mitata-host-probes",
        enforce: "pre",
        resolveId: (source) => (stubbed.has(source) ? resolvedId : undefined),
        load: (id) => (id === resolvedId ? "export default {};" : undefined),
    };
}

export default defineConfig({
    root: repoRoot,
    plugins: [stubMitataHostProbes(), benchServerPlugin({ resultsDir })],
    server: {
        // Cross-origin isolation unclamps `performance.now()`. Without it browsers coarsen it to 100us
        // (Chromium) or 1ms (Firefox, WebKit), which is longer than most of the operations measured here,
        // so every sample lands on a clock tick and the numbers become meaningless.
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    },
    optimizeDeps: {
        // The wasm glue locates its .wasm asset relative to its own module URL; esbuild prebundling rewrites
        // that to something that no longer resolves.
        exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
    },
    test: {
        include: ["benchmark/suites/**/*.bench.ts"],
        // Benchmarks are long-running by construction.
        testTimeout: 0,
        hookTimeout: 0,
        // Anything running alongside a benchmark shows up as noise in its numbers.
        fileParallelism: false,
        maxWorkers: 1,
        browser: {
            enabled: true,
            headless: true,
            provider: playwright({
                // Firefox keeps a 1ms floor on `performance.now()` even when cross-origin isolated.
                // The pref is ignored by the other browsers.
                launchOptions: { firefoxUserPrefs: { "privacy.reduceTimerPrecision": false } },
            }),
            screenshotFailures: false,
            instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
        },
    },
});
