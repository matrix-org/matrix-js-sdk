module.exports = {
    sourceMaps: true,
    presets: [
        [
            "@babel/preset-env",
            {
                targets: {
                    esmodules: true,
                },
                // Used "commonjs" for tests due to https://github.com/matrix-org/matrix-js-sdk/pull/4187#issuecomment-2117342908
                // and "false" to preserve ESM for the final build to make async
                // imports work correctly.
                modules: process.env.NODE_ENV === "test" ? "commonjs" : false,
            },
        ],
        "@babel/preset-typescript",
    ],
    plugins: [
        "@babel/plugin-proposal-numeric-separator",
        "@babel/plugin-proposal-class-properties",
        "@babel/plugin-proposal-object-rest-spread",
        "@babel/plugin-syntax-dynamic-import",
        "@babel/plugin-transform-runtime",
    ],
};
