/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { env } from "node:process";
import { type Plugin } from "vite";

const BUILD_INFO_ROUTE = "/__bench__/build-info";
const RESULTS_ROUTE = "/__bench__/results";
const WASM_ROUTE = "/__bench__/wasm";

const WASM_PACKAGE = "@matrix-org/matrix-sdk-crypto-wasm";
const WASM_ASSET = "pkg/matrix_sdk_crypto_wasm_bg.wasm";

/** Anything used to build a results path must match this, so a request can never escape the results directory. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const MAX_RESULT_BYTES = 32 * 1024 * 1024;

const require = createRequire(import.meta.url);

/** Identifies which build of the crypto wasm produced a set of numbers. */
export interface WasmBuildInfo {
    /** Name this run is filed under; `BENCH_LABEL` if set, otherwise the package version. */
    label: string;
    version: string;
    resolvedPath: string;
    wasmBytes: number;
    wasmSha256: string;
}

async function findPackageRoot(entry: string): Promise<string> {
    let dir = path.dirname(entry);
    for (;;) {
        try {
            await access(path.join(dir, "package.json"));
            return dir;
        } catch {
            const parent = path.dirname(dir);
            if (parent === dir) throw new Error(`could not locate the package root for ${entry}`);
            dir = parent;
        }
    }
}

async function resolveWasmBuildInfo(): Promise<WasmBuildInfo> {
    const packageRoot = await findPackageRoot(require.resolve(WASM_PACKAGE));
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const wasm = await readFile(path.join(packageRoot, WASM_ASSET));

    const version = String(manifest.version);
    const label = env["BENCH_LABEL"]?.trim() || version;
    if (!SAFE_SEGMENT.test(label)) {
        throw new Error(`BENCH_LABEL must match ${SAFE_SEGMENT} (got ${JSON.stringify(label)})`);
    }

    return {
        label,
        version,
        resolvedPath: await realpath(packageRoot),
        wasmBytes: wasm.byteLength,
        wasmSha256: createHash("sha256").update(wasm).digest("hex"),
    };
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            size += chunk.length;
            if (size > MAX_RESULT_BYTES) {
                req.destroy();
                reject(new Error("benchmark result payload too large"));
            } else {
                body += chunk;
            }
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
}

export interface BenchServerPluginOptions {
    /** Absolute path of the directory result files are written under. */
    resultsDir: string;
}

/**
 * Dev-server side of the benchmark harness: reports which wasm build is loaded and persists results
 * posted back from the browser.
 */
export function benchServerPlugin({ resultsDir }: BenchServerPluginOptions): Plugin {
    return {
        name: "matrix-js-sdk:bench-server",
        configureServer(server) {
            server.middlewares.use(BUILD_INFO_ROUTE, (_req, res) => {
                resolveWasmBuildInfo().then(
                    (info) => sendJson(res, 200, info),
                    (error: Error) => sendJson(res, 500, { error: error.message }),
                );
            });

            // Served from the resolved package rather than imported, because the package exports map has no
            // subpath for the binary, and this guarantees the bytes match the build reported above.
            server.middlewares.use(WASM_ROUTE, (_req, res) => {
                findPackageRoot(require.resolve(WASM_PACKAGE))
                    .then(async (packageRoot) => {
                        const wasm = await readFile(path.join(packageRoot, WASM_ASSET));
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/wasm");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(wasm);
                    })
                    .catch((error: Error) => sendJson(res, 500, { error: error.message }));
            });

            server.middlewares.use(RESULTS_ROUTE, (req, res) => {
                if (req.method !== "POST") {
                    sendJson(res, 405, { error: "expected POST" });
                    return;
                }

                readBody(req)
                    .then(async (body) => {
                        const payload = JSON.parse(body);
                        const segments = [payload?.build?.label, payload?.browser, payload?.suite];
                        if (!segments.every((segment) => typeof segment === "string" && SAFE_SEGMENT.test(segment))) {
                            sendJson(res, 400, { error: "build.label, browser and suite must be safe path segments" });
                            return;
                        }

                        const [label, browser, suite] = segments as [string, string, string];
                        const dir = path.join(resultsDir, label, browser);
                        await mkdir(dir, { recursive: true });
                        const file = path.join(dir, `${suite}.json`);
                        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
                        server.config.logger.info(`[bench] wrote ${path.relative(server.config.root, file)}`);
                        sendJson(res, 200, { ok: true });
                    })
                    .catch((error: Error) => sendJson(res, 500, { error: error.message }));
            });
        },
    };
}
