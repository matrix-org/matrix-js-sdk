import { KnipConfig } from "knip";

export default {
    entry: [
        "src/index.ts",
        "src/types.ts",
        "src/browser-index.ts",
        "src/indexeddb-worker.ts",
        "scripts/**",
        "spec/**",
        "release.sh",
        // For now, we include all source files as entrypoints as we have been bad about gutwrenched imports
        "src/**",
    ],
    project: ["**/*.{js,ts}"],
    ignore: ["examples/**"],
    ignoreDependencies: [
        // Required for `action-validator`
        "@action-validator/*",
        // Used for git pre-commit hooks
        "husky",
        // Used in script which only runs in environment with `@octokit/rest` installed
        "@octokit/rest",
        // Used by jest
        "jest-environment-jsdom",
        "babel-jest",
        "ts-node",
        // Used by `@babel/plugin-transform-runtime`
        "@babel/runtime",
    ],
    ignoreBinaries: [
        // Used when available by reusable workflow `.github/workflows/release-make.yml`
        "dist",
    ],
    ignoreExportsUsedInFile: true,
} satisfies KnipConfig;
