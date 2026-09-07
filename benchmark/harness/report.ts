/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { run } from "mitata";
import { server } from "vitest/browser";

import { type WasmBuildInfo } from "./serverPlugin.ts";

const BUILD_INFO_ROUTE = "/__bench__/build-info";
const RESULTS_ROUTE = "/__bench__/results";

interface BenchStats {
    avg: number;
    min: number;
    max: number;
    p25: number;
    p50: number;
    p75: number;
    p99: number;
    p999: number;
    samples: number;
    /**
     * Total iterations behind those samples.
     *
     * When an operation is short mitata measures batches of iterations rather than single ones, so a
     * batched run reports few samples despite covering a great many iterations. Comparing sample counts
     * alone would write those off as unreliable when they are in fact the most precise measurements.
     */
    ticks: number;
}

interface BenchRecord {
    name: string;
    args: Record<string, unknown>;
    stats: BenchStats | null;
    error: string | null;
}

export interface SuiteResults {
    suite: string;
    browser: string;
    recordedAt: string;
    build: WasmBuildInfo;
    environment: {
        userAgent: string;
        crossOriginIsolated: boolean;
        clockResolutionNs: number;
        hardwareConcurrency: number;
    };
    benchmarks: BenchRecord[];
}

async function fetchBuildInfo(): Promise<WasmBuildInfo> {
    const response = await fetch(BUILD_INFO_ROUTE);
    if (!response.ok) throw new Error(`could not read the wasm build info: HTTP ${response.status}`);
    return (await response.json()) as WasmBuildInfo;
}

/** Smallest non-zero gap `performance.now()` will report, in nanoseconds. */
function clockResolutionNs(): number {
    let smallest = Infinity;
    for (let i = 0; i < 100; i++) {
        const start = performance.now();
        let end = performance.now();
        while (end === start) end = performance.now();
        smallest = Math.min(smallest, end - start);
    }
    return smallest * 1e6;
}

function toRecords(benchmarks: Awaited<ReturnType<typeof run>>["benchmarks"]): BenchRecord[] {
    return benchmarks.flatMap((trial) =>
        trial.runs.map((entry) => ({
            name: trial.alias,
            args: entry.args ?? {},
            // Sample arrays are dropped: they dominate the file size and the percentiles already summarise them.
            stats: entry.stats
                ? {
                      avg: entry.stats.avg,
                      min: entry.stats.min,
                      max: entry.stats.max,
                      p25: entry.stats.p25,
                      p50: entry.stats.p50,
                      p75: entry.stats.p75,
                      p99: entry.stats.p99,
                      p999: entry.stats.p999,
                      samples: entry.stats.samples.length,
                      ticks: entry.stats.ticks,
                  }
                : null,
            error: entry.error ? String((entry.error as Error).message ?? entry.error) : null,
        })),
    );
}

/**
 * Runs every benchmark registered in the current module, prints mitata's table and posts the results
 * back to the dev server so they can be diffed against another wasm build.
 */
export async function runSuite(suite: string): Promise<SuiteResults> {
    const build = await fetchBuildInfo();
    const environment = {
        userAgent: navigator.userAgent,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        clockResolutionNs: clockResolutionNs(),
        hardwareConcurrency: navigator.hardwareConcurrency,
    };

    console.log(
        `[bench] suite=${suite} browser=${server.browser} wasm=${build.version} label=${build.label} ` +
            `crossOriginIsolated=${environment.crossOriginIsolated} clock=${environment.clockResolutionNs.toFixed(0)}ns`,
    );

    const { benchmarks } = await run({ throw: true, colors: false });

    const results: SuiteResults = {
        suite,
        browser: server.browser,
        recordedAt: new Date().toISOString(),
        build,
        environment,
        benchmarks: toRecords(benchmarks),
    };

    const response = await fetch(RESULTS_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(results),
    });
    if (!response.ok) throw new Error(`could not persist results: HTTP ${response.status}`);

    return results;
}
