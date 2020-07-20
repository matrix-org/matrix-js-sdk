module.exports = {
    extends: ["matrix-org", "matrix-org/legacy"],
    plugins: [
        "babel",
        "jest",
    ],
    env: {
        browser: true,
        node: true,
    },

    rules: {
        quotes: ["off"],
    },
    overrides: [{
        files: ["src/**/*.{ts, tsx}"],
        "extends": ["matrix-org/ts"],
    }],
}
