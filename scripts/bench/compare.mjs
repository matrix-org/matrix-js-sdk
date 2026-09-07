/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const RESULTS_DIR = fileURLToPath(new URL("../../benchmark/results", import.meta.url));

const METRICS = ["avg", "p50", "p99"];

/**
 * Below this many measured iterations a delta says more about scheduling luck than about the build.
 *
 * Counted in iterations rather than samples because mitata batches short operations, and a batched run
 * reports very few samples while actually being the most precise measurement of the set.
 */
const LOW_CONFIDENCE_TICKS = 30;

function usage() {
    return [
        "Usage: pnpm bench:compare <baseline-label> <candidate-label> [--threshold <percent>] [--metric avg|p50|p99]",
        "",
        "Labels are the directory names under benchmark/results/ (set with BENCH_LABEL when running pnpm bench).",
    ].join("\n");
}

async function loadLabel(label) {
    const dir = path.join(RESULTS_DIR, label);
    let browsers;
    try {
        browsers = await readdir(dir, { withFileTypes: true });
    } catch {
        throw new Error(`no results found for ${JSON.stringify(label)} (looked in ${dir})`);
    }

    /** key -> { browser, suite, name, stats } */
    const entries = new Map();
    let build;

    for (const browser of browsers.filter((entry) => entry.isDirectory())) {
        const files = await readdir(path.join(dir, browser.name));
        for (const file of files.filter((name) => name.endsWith(".json"))) {
            const results = JSON.parse(await readFile(path.join(dir, browser.name, file), "utf8"));
            build ??= results.build;
            for (const benchmark of results.benchmarks) {
                if (!benchmark.stats) continue;
                // A benchmark run over `.args()` reports one entry per argument value under a shared
                // name, so the arguments have to be part of the key or the variants overwrite each other.
                const args = benchmark.args ?? {};
                const key = `${browser.name}\u0000${results.suite}\u0000${benchmark.name}\u0000${JSON.stringify(args)}`;
                entries.set(key, {
                    browser: browser.name,
                    suite: results.suite,
                    name: resolveName(benchmark.name, args),
                    stats: benchmark.stats,
                });
            }
        }
    }

    if (entries.size === 0) throw new Error(`no benchmark results recorded under ${dir}`);
    return { build, entries };
}

/** Substitutes mitata's `$arg` placeholders so each argument variant gets a distinct, readable label. */
function resolveName(name, args) {
    let resolved = name;
    const unused = [];
    for (const [key, value] of Object.entries(args)) {
        const placeholder = `$${key}`;
        if (resolved.includes(placeholder)) resolved = resolved.replaceAll(placeholder, String(value));
        else unused.push(`${key}=${value}`);
    }
    return unused.length > 0 ? `${resolved} [${unused.join(" ")}]` : resolved;
}

function formatNs(ns) {
    if (ns < 1_000) return `${ns.toFixed(0)}ns`;
    if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)}µs`;
    if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
    return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

function renderTable(rows) {
    const header = ["browser", "suite", "benchmark", "baseline", "candidate", "delta", "iters"];
    const body = rows.map((row) => [
        row.browser,
        row.suite,
        row.name,
        formatNs(row.baseline),
        formatNs(row.candidate),
        `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)}%`,
        `${row.iterations}${row.lowConfidence ? " (!)" : ""}`,
    ]);

    const widths = header.map((_, column) =>
        Math.max(header[column].length, ...body.map((cells) => cells[column].length)),
    );
    const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");

    return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            threshold: { type: "string", default: "5" },
            // The median ignores the occasional very slow sample that GC or scheduling produces, which the
            // mean does not, and which is what makes the slower suites look like they moved between runs.
            metric: { type: "string", default: "p50" },
            help: { type: "boolean", default: false },
        },
    });

    if (values.help || positionals.length !== 2) {
        console.log(usage());
        process.exit(values.help ? 0 : 1);
    }

    if (!METRICS.includes(values.metric)) {
        throw new Error(`--metric must be one of ${METRICS.join(", ")}`);
    }
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold)) throw new Error("--threshold must be a number");

    const [baselineLabel, candidateLabel] = positionals;
    const baseline = await loadLabel(baselineLabel);
    const candidate = await loadLabel(candidateLabel);

    const rows = [];
    const missing = [];
    for (const [key, candidateEntry] of candidate.entries) {
        const baselineEntry = baseline.entries.get(key);
        if (!baselineEntry) {
            missing.push(`${candidateEntry.browser} / ${candidateEntry.suite} / ${candidateEntry.name}`);
            continue;
        }
        const before = baselineEntry.stats[values.metric];
        const after = candidateEntry.stats[values.metric];
        // Older result files predate `ticks`, so fall back to the sample count.
        const ticksOf = (stats) => stats.ticks ?? stats.samples;
        const iterations = Math.min(ticksOf(baselineEntry.stats), ticksOf(candidateEntry.stats));
        rows.push({
            browser: candidateEntry.browser,
            suite: candidateEntry.suite,
            name: candidateEntry.name,
            baseline: before,
            candidate: after,
            delta: ((after - before) / before) * 100,
            iterations,
            lowConfidence: iterations < LOW_CONFIDENCE_TICKS,
        });
    }

    rows.sort((a, b) => b.delta - a.delta);

    console.log(`baseline  ${baselineLabel}  (wasm ${baseline.build?.version} ${baseline.build?.wasmSha256?.slice(0, 12)})`);
    console.log(`candidate ${candidateLabel}  (wasm ${candidate.build?.version} ${candidate.build?.wasmSha256?.slice(0, 12)})`);
    console.log(`metric    ${values.metric}   negative delta = candidate is faster\n`);
    console.log(renderTable(rows));

    if (missing.length > 0) {
        console.log(`\nnot present in the baseline:\n  ${missing.join("\n  ")}`);
    }

    const lowConfidence = rows.filter((row) => row.lowConfidence);
    if (lowConfidence.length > 0) {
        console.log(
            `\n(!) ${lowConfidence.length} benchmark(s) ran fewer than ${LOW_CONFIDENCE_TICKS} iterations; ` +
                `treat their deltas as indicative only`,
        );
    }

    const regressions = rows.filter((row) => row.delta > threshold && !row.lowConfidence);
    if (regressions.length > 0) {
        console.log(`\n${regressions.length} benchmark(s) regressed by more than ${threshold}%`);
        process.exitCode = 1;
    }
}

await main();
