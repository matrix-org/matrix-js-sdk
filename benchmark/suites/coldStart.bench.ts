/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { do_not_optimize, summary } from "mitata";
import { expect, it } from "vitest";

import { benchmark } from "../harness/mitata.ts";
import { runSuite } from "../harness/report.ts";

const WASM_ROUTE = "/__bench__/wasm";

/**
 * Imports satisfying the module's declared dependencies without the real wasm-bindgen glue.
 *
 * Instantiation only has to link, not run: wasm-bindgen exposes its initialiser as an exported
 * `__wbindgen_start` rather than a wasm start section, so none of these stubs are ever called.
 */
function stubImports(module: WebAssembly.Module): WebAssembly.Imports {
    const imports: WebAssembly.Imports = {};
    for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
        const target = (imports[from] ??= {});
        switch (kind) {
            case "function":
                target[name] = () => undefined;
                break;
            case "memory":
                target[name] = new WebAssembly.Memory({ initial: 1 });
                break;
            case "table":
                target[name] = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
                break;
            case "global":
                target[name] = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
                break;
        }
    }
    return imports;
}

it("wasm cold start", async () => {
    const response = await fetch(WASM_ROUTE);
    expect(response.ok).toBe(true);
    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(1_000_000);

    // Compiling from an ArrayBuffer rather than `compileStreaming` on purpose: the streaming path is
    // served by the browser's wasm code cache on repeat, which would measure the cache instead of the
    // compiler. This also keeps the network out of the number.
    const module = await WebAssembly.compile(bytes);
    expect(WebAssembly.Module.exports(module).some((e) => e.name === "__wbindgen_start")).toBe(true);

    const imports = stubImports(module);
    expect(await WebAssembly.instantiate(module, imports)).toBeTruthy();

    summary(() => {
        benchmark("WebAssembly.compile", function* () {
            yield async () => {
                do_not_optimize(await WebAssembly.compile(bytes));
            };
        });

        benchmark("WebAssembly.instantiate (precompiled)", function* () {
            yield async () => {
                do_not_optimize(await WebAssembly.instantiate(module, imports));
            };
        });
    });

    await runSuite("coldStart");
});
