#!/usr/bin/env node

const fsProm = require("fs/promises");

const PKGJSON = "package.json";

async function main() {
    const pkgJson = JSON.parse(await fsProm.readFile(PKGJSON, "utf8"));
    for (const field of ["main", "typings"]) {
        if (pkgJson["matrix_lib_" + field] !== undefined) {
            pkgJson[field] = pkgJson["matrix_lib_" + field];
        }
    }

    // matrix-js-sdk is built into ECMAScript modules. Make sure we declare it as such.
    // See https://nodejs.org/api/packages.html#type.
    pkgJson["type"] = "module";

    await fsProm.writeFile(PKGJSON, JSON.stringify(pkgJson, null, 2));
}

main();
