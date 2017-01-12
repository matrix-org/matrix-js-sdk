module.exports = {
    parserOptions: {
        ecmaVersion: 6,
        sourceType: "module",
        ecmaFeatures: {
        }
    },
    env: {
        browser: true,
        node: true,
    },
    extends: ["eslint:recommended", "google"],
    rules: {
        // rules we've always adhered to
        "max-len": ["error", {
            code: 90,
            ignoreComments: true,
        }],
        curly: ["error", "multi-line"],

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
        "comma-dangle": ["warn"],
        "brace-style": ["warn"],
        "prefer-rest-params": ["warn"],
        "prefer-spread": ["warn"],
        "one-var": ["warn"],
        "padded-blocks": ["warn"],
        "no-extend-native": ["warn"],
        "camelcase": ["warn"],
    }
}
