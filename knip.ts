import { KnipConfig } from "knip";

export default {
    entry: ["src/index.ts", "src/browser-index.ts", "src/indexeddb-worker.ts", "scripts/**", "spec/**", "release.sh"],
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
        // Used by release.sh
        "allchange",
    ],
    ignoreBinaries: [],
    ignoreExportsUsedInFile: true,
} satisfies KnipConfig;
