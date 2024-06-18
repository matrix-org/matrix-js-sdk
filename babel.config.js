module.exports = {
    sourceMaps: true,
    presets: [
        [
            "@babel/preset-env",
            {
                targets: {
                    esmodules: true,
                },
                // We want to output ES modules for the final build (mostly to ensure that
                // async imports work correctly). However, jest doesn't support ES modules very
                // well yet (see https://github.com/jestjs/jest/issues/9430), so we use commonjs
                // when testing.
                modules: process.env.NODE_ENV === "test" ? "commonjs" : false,
            },
        ],
        "@babel/preset-typescript",
    ],
    plugins: [
        "@babel/plugin-transform-numeric-separator",
        "@babel/plugin-transform-class-properties",
        "@babel/plugin-transform-object-rest-spread",
        "@babel/plugin-syntax-dynamic-import",
        "@babel/plugin-transform-runtime",
    ],
};
