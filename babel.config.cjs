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
        [
            "@babel/plugin-transform-typescript",
            {
                allowDeclareFields: true,
            },
        ],
        ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
        "@babel/plugin-transform-numeric-separator",
        "@babel/plugin-transform-class-properties",
        "@babel/plugin-transform-object-rest-spread",
        "@babel/plugin-transform-runtime",
    ],
};
