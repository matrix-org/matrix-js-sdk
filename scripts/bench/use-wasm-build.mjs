/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE = "@matrix-org/matrix-sdk-crypto-wasm";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = path.join(repoRoot, "package.json");
const backupPath = path.join(repoRoot, "benchmark", ".wasm-spec-backup.json");

function usage() {
    return [
        `Usage: pnpm bench:use <spec>     switch ${PACKAGE} to another build`,
        "       pnpm bench:use --restore  put the original spec back",
        "",
        "<spec> is anything pnpm understands, for example:",
        "  ../matrix-rust-sdk-crypto-wasm     a local checkout (resolved to an absolute file: path)",
        "  18.4.0                             a published version",
        "  npm:@matrix-org/matrix-sdk-crypto-wasm@18.3.0",
    ].join("\n");
}

async function readManifest() {
    return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function currentSpec() {
    const manifest = await readManifest();
    const spec = manifest.dependencies?.[PACKAGE] ?? manifest.devDependencies?.[PACKAGE];
    if (!spec) throw new Error(`${PACKAGE} is not listed in package.json`);
    return spec;
}

function runPnpm(args) {
    // Prefer the pnpm that invoked this script; it is not necessarily on PATH.
    const execPath = process.env["npm_execpath"];
    const [command, prefix] = execPath ? [process.execPath, [execPath]] : ["pnpm", []];

    console.log(`> pnpm ${args.join(" ")}`);
    const result = spawnSync(command, [...prefix, ...args], { cwd: repoRoot, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pnpm exited with code ${result.status}`);
}

async function restore() {
    let backup;
    try {
        backup = JSON.parse(await readFile(backupPath, "utf8"));
    } catch {
        throw new Error("nothing to restore: no build has been swapped in");
    }

    runPnpm(["add", `${PACKAGE}@${backup.spec}`]);
    await rm(backupPath, { force: true });
    console.log(`\nRestored ${PACKAGE} to ${backup.spec}`);
}

async function use(spec) {
    // Record the pristine spec the first time only, so repeated swaps still know where to return to.
    try {
        await readFile(backupPath, "utf8");
    } catch {
        await writeFile(backupPath, `${JSON.stringify({ spec: await currentSpec() }, null, 2)}\n`);
    }

    // A bare path is far more likely to be meant as a local build than as a version range.
    const resolved =
        spec.startsWith(".") || path.isAbsolute(spec) ? `file:${path.resolve(process.cwd(), spec)}` : spec;

    runPnpm(["add", `${PACKAGE}@${resolved}`]);

    const manifest = await readManifest();
    const installed = JSON.parse(
        await readFile(path.join(repoRoot, "node_modules", PACKAGE, "package.json"), "utf8"),
    );

    console.log(`\n${PACKAGE} is now ${manifest.dependencies[PACKAGE]} (version ${installed.version})`);
    console.log("Run the benchmarks against it with, for example:");
    console.log("  BENCH_LABEL=candidate pnpm bench");
    console.log("and put the original build back with:");
    console.log("  pnpm bench:use --restore");
}

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { restore: { type: "boolean", default: false }, help: { type: "boolean", default: false } },
});

if (values.help || (!values.restore && positionals.length !== 1)) {
    console.log(usage());
    process.exit(values.help ? 0 : 1);
}

if (values.restore) {
    await restore();
} else {
    await use(positionals[0]);
}
