import { KnipConfig } from "knip";

// Specify this as knip loads config files which may conditionally load plugins
process.env.GITHUB_ACTIONS = "1";

export default {
    entry: [
        "src/index.ts",
        "src/types.ts",
        "src/browser-index.ts",
        "src/indexeddb-worker.ts",
        "src/crypto-api/index.ts",
        "src/rendezvous/index.ts",
        "src/testing.ts",
        "src/matrix.ts",
        "src/utils.ts", // not really an entrypoint but we have deprecated `defer` there
        "scripts/**",
        "spec/**",
        // XXX: these should be re-exported by one of the supported exports
        "src/matrixrtc/index.ts",
        "src/sliding-sync.ts",
        "src/webrtc/groupCall.ts",
        "src/webrtc/stats/media/mediaTrackStats.ts",
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
    ],
    ignoreBinaries: [
        // Used when available by reusable workflow `.github/workflows/release-make.yml`
        "dist",
        // Optional for coverage:diff development script
        "diff-cover",
    ],
    ignoreExportsUsedInFile: true,
    includeEntryExports: false,
    exclude: ["enumMembers"],
    treatConfigHintsAsErrors: true,
} satisfies KnipConfig;
