module.exports = {
    sourceMaps: true,
    presets: [
        [
            "@babel/preset-env",
            {
                targets: {
                    esmodules: true,
                },
                modules: false,
            },
        ],
        [
            "@babel/preset-typescript",
            {
                rewriteImportExtensions: true,
            },
        ],
    ],
    plugins: [
        ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
        "@babel/plugin-transform-numeric-separator",
        "@babel/plugin-transform-class-properties",
        "@babel/plugin-transform-object-rest-spread",
        "@babel/plugin-syntax-dynamic-import",
        "@babel/plugin-transform-runtime",
        [
            "search-and-replace",
            {
                // Since rewriteImportExtensions doesn't work on dynamic imports (yet), we need to manually replace
                // the dynamic rust-crypto import.
                // (see https://github.com/babel/babel/issues/16750)
                rules:
                    process.env.NODE_ENV !== "test"
                        ? [
                              {
                                  search: "./rust-crypto/index.ts",
                                  replace: "./rust-crypto/index.js",
                              },
                          ]
                        : [],
            },
        ],
    ],
};
