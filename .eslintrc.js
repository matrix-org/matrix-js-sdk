module.exports = {
    plugins: [
        "matrix-org",
    ],
    extends: [
        "plugin:matrix-org/babel",
    ],
    env: {
        browser: true,
        node: true,
    },
    // NOTE: These rules are frozen and new rules should not be added here.
    // New changes belong in https://github.com/matrix-org/eslint-plugin-matrix-org/
    rules: {
        "no-var": ["warn"],
        "prefer-rest-params": ["warn"],
        "prefer-spread": ["warn"],
        "one-var": ["warn"],
        "padded-blocks": ["warn"],
        "no-extend-native": ["warn"],
        "camelcase": ["warn"],
        "no-multi-spaces": ["error", { "ignoreEOLComments": true }],
        "space-before-function-paren": ["error", {
            "anonymous": "never",
            "named": "never",
            "asyncArrow": "always",
        }],
        "arrow-parens": "off",
        "prefer-promise-reject-errors": "off",
        "quotes": "off",
        "indent": "off",
        "no-constant-condition": "off",
        "no-async-promise-executor": "off",
        // We use a `logger` intermediary module
        "no-console": "error",

        // restrict EventEmitters to force callers to use TypedEventEmitter
        "no-restricted-imports": ["error", "events"],
    },
    overrides: [{
        files: [
            "**/*.ts",
        ],
        extends: [
            "plugin:matrix-org/typescript",
        ],
        rules: {
            // TypeScript has its own version of this
            "@babel/no-invalid-this": "off",

            // We're okay being explicit at the moment
            "@typescript-eslint/no-empty-interface": "off",
            // We disable this while we're transitioning
            "@typescript-eslint/no-explicit-any": "off",
            // We'd rather not do this but we do
            "@typescript-eslint/ban-ts-comment": "off",
            // We're okay with assertion errors when we ask for them
            "@typescript-eslint/no-non-null-assertion": "off",

            "quotes": "off",
            // We use a `logger` intermediary module
            "no-console": "error",
        },
    }],
};
