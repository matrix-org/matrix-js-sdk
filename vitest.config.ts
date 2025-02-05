/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            provider: "v8",
            include: ["spec/**/*"],
            reporter: "lcov",
        },
        reporters: [["vitest-sonar-reporter", { outputFile: "coverage/sonar-report.xml" }]],
        setupFiles: "spec/setupTests.ts",
    },
});
