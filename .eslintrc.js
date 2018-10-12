module.exports = {
    parser: "babel-eslint",
    parserOptions: {
        ecmaVersion: 6,
        sourceType: "module",
        ecmaFeatures: {
        }
    },
    env: {
        browser: true,
        node: true,

        // babel's transform-runtime converts references to ES6 globals such as
        // Promise and Map to core-js polyfills, so we can use ES6 globals.
        es6: true,
    },
    extends: ["eslint:recommended", "google"],
    rules: {
        // rules we've always adhered to or now do
        "max-len": ["error", {
            code: 90,
            ignoreComments: true,
        }],
        curly: ["error", "multi-line"],
        "prefer-const": ["error"],
        "comma-dangle": ["error", {
            arrays: "always-multiline",
            objects: "always-multiline",
            imports: "always-multiline",
            exports: "always-multiline",
            functions: "always-multiline",
        }],

        // loosen jsdoc requirements a little
        "require-jsdoc": ["error", {
            require: {
                FunctionDeclaration: false,
            }
        }],
        "valid-jsdoc": ["error", {
            requireParamDescription: false,
            requireReturn: false,
            requireReturnDescription: false,
        }],

        // rules we do not want from eslint-recommended
        "no-console": ["off"],
        "no-constant-condition": ["off"],
        "no-empty": ["error", { "allowEmptyCatch": true }],

        // rules we do not want from the google styleguide
        "object-curly-spacing": ["off"],
        "spaced-comment": ["off"],

        // in principle we prefer single quotes, but life is too short
        quotes: ["off"],

        // rules we'd ideally like to adhere to, but the current
        // code does not (in most cases because it's still ES5)
        // we set these to warnings, and assert that the number
        // of warnings doesn't exceed a given threshold
        "no-var": ["warn"],
        "brace-style": ["warn", "1tbs", {"allowSingleLine": true}],
        "prefer-rest-params": ["warn"],
        "prefer-spread": ["warn"],
        "one-var": ["warn"],
        "padded-blocks": ["warn"],
        "no-extend-native": ["warn"],
        "camelcase": ["warn"],
    }
}
