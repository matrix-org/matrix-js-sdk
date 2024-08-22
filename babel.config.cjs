const fs = require("fs");
const path = require("path");

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
        // Fix up imports & exports so that Node.js doesn't choke on them
        ...(process.env.NODE_ENV === "test" ? [] : [function appendJsExtensionToImports() {
           function fixImportOrExport(target, state) {
                if (!target.node.source) {
                    return;
                }

                const source = target.node.source.value;

                if (source && source.startsWith(".") && !source.endsWith(".js")) {
                    const fullPath = path.join(path.dirname(state.file.opts.filename), source);
                    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                        target.node.source.value += "/index.js";
                    } else {
                        target.node.source.value += ".js";
                    }
                }
            }

            return {
              visitor: {
                ImportDeclaration(target, state) {
                    fixImportOrExport(target, state);
                },
                ExportDeclaration(target, state) {
                    fixImportOrExport(target, state);
                },
              },
            };
        }])
    ],
};
