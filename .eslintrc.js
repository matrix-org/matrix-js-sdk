module.exports = {
    plugins: [
        "matrix-org",
        "import",
    ],
    extends: [
        "plugin:matrix-org/babel",
        "plugin:import/typescript",
    ],
    env: {
        browser: true,
        node: true,
    },
    settings: {
        "import/resolver": {
            typescript: true,
            node: true,
        },
    },
    // NOTE: These rules are frozen and new rules should not be added here.
    // New changes belong in https://github.com/matrix-org/eslint-plugin-matrix-org/
    rules: {
        "no-var": ["error"],
        "prefer-rest-params": ["error"],
        "prefer-spread": ["error"],
        "one-var": ["error"],
        "padded-blocks": ["error"],
        "no-extend-native": ["error"],
        "camelcase": ["error"],
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
        "no-restricted-imports": ["error", {
            name: "events",
            message: "Please use TypedEventEmitter instead"
        }],

        "import/no-restricted-paths": ["error", {
            "zones": [{
                "target": "./src/",
                "from": "./src/index.ts",
                "message": "The package index is dynamic between src and lib depending on " +
                    "whether release or development, target the specific module or matrix.ts instead",
            }],
        }],
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

            // The non-TypeScript rule produces false positives
            "func-call-spacing": "off",
            "@typescript-eslint/func-call-spacing": ["error"],

            "quotes": "off",
            // We use a `logger` intermediary module
            "no-console": "error",
        },
    }],
};
