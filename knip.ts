import { KnipConfig } from "knip";

export default {
    entry: [
        "src/index.ts",
        "src/types.ts",
        "src/browser-index.ts",
        "src/indexeddb-worker.ts",
        "src/crypto-api/index.ts",
        "src/testing.ts",
        "src/matrix.ts",
        "scripts/**",
        "spec/**",
        // XXX: these look entirely unused
        "src/crypto/aes.ts",
        "src/crypto/crypto.ts",
        "src/crypto/recoverykey.ts",
        // XXX: these should be re-exported by one of the supported exports
        "src/matrixrtc/index.ts",
        "src/sliding-sync.ts",
        "src/webrtc/groupCall.ts",
        "src/webrtc/stats/media/mediaTrackStats.ts",
        "src/rendezvous/RendezvousChannel.ts",
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
    includeEntryExports: false,
    exclude: ["enumMembers"],
} satisfies KnipConfig;
