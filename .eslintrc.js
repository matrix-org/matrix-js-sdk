module.exports = {
    parserOptions: {
        ecmaVersion: 6,
        sourceType: "module",
        ecmaFeatures: {
        }
    },
    rules: {
        "max-len": ["warn", {
            code: 90,
            ignoreComments: true,
        }],
        curly: ["error", "multi-line"],
        "require-jsdoc": ["warn"],
        "valid-jsdoc": ["warn"],
    }
}
