var matrixcs = require("./lib/matrix");
matrixcs.request(require("browser-request"));

// if our browser (appears to) support indexeddb, use an indexeddb crypto store.
if (global.indexedDB) {
    matrixcs.setCryptoStoreFactory(
        function() {
            return new matrixcs.IndexedDBCryptoStore(
                global.indexedDB, "matrix-js-sdk:crypto"
            );
        }
    );
}

module.exports = matrixcs; // keep export for browserify package deps
global.matrixcs = matrixcs;
