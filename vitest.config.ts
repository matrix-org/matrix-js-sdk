/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { defineConfig, ViteUserConfig } from "vitest/config";
import { env } from "process";

const reporters: ViteUserConfig["test"]["reporters"] = [["default"]];

// if we're running under GHA, enable the GHA & Sonar reporters
if (env["GITHUB_ACTIONS"] !== undefined) {
    reporters.push(["github-actions", { silent: false }]);
    reporters.push([
        "vitest-sonar-reporter",
        {
            outputFile: process.env.SHARD
                ? `coverage/sonar-report-${process.env.SHARD}.xml`
                : "coverage/sonar-report.xml",
        },
    ]);

    // if we're running against the develop branch, also enable the slow test reporter
    if (env["GITHUB_REF"] == "refs/heads/develop") {
        reporters.push("<rootDir>/spec/slowReporter.cjs");
    }
}

export default defineConfig({
    test: {
        coverage: {
            provider: "v8",
            include: ["src/**/*"],
            reporter: "lcov",
        },
        environment: "node",
        reporters,
        setupFiles: "spec/setupTests.ts",
        globals: true,
        pool: "threads",
    },
});
