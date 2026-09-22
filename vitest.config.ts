/*
Copyright 2026 Element Creations Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { defineConfig, type ViteUserConfig } from "vitest/config";
import { type Reporter } from "vitest/reporters";
import { env } from "node:process";

const reporters: NonNullable<ViteUserConfig["test"]>["reporters"] = [["default"]];

const slowTestReporter: Reporter = {
    onTestRunEnd(testModules, unhandledErrors, reason) {
        const tests = testModules
            .flatMap((m) => Array.from(m.children.allTests()))
            .filter((test) => test.diagnostic()?.slow);
        tests.sort((x, y) => x.diagnostic()!.duration - y.diagnostic()!.duration);
        tests.reverse();

        if (tests.length > 0) {
            console.warn("Slowest 10 tests:");
        }
        for (const t of tests.slice(0, 10)) {
            console.warn(`${t.module.moduleId} > ${t.fullName}: ${t.diagnostic()?.duration.toFixed(0)}ms`);
        }
    },
};

// if we're running under GHA, enable the GHA & Sonar reporters
if (env["GITHUB_ACTIONS"] !== undefined) {
    reporters.push(["github-actions", { silent: false }]);

    // if we're running against the develop branch, also enable the slow test reporter
    if (env["GITHUB_REF"] == "refs/heads/develop") {
        reporters.push(slowTestReporter);
    }
}

export default defineConfig({
    test: {
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["**/crypto-test-data/**"],
            reporter: "lcov",
        },
        environment: "node",
        reporters,
        setupFiles: "spec/setupTests.ts",
        globals: true,
        pool: "threads",
    },
});
