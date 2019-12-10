module.exports = {
    collectCoverage: true,
    testEnvironment: "node",
    transform: {
        ".ts$": "ts-jest",
        ".js$": "babel-jest",
    },
    globals: {
        'ts-jest': {
            tsConfig: "tsconfig.json",
        },
    },
};
