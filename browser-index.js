var matrixcs = require("./lib/matrix");
matrixcs.request(require("request"));

// just *accessing* indexedDB throws an exception in firefox with
// indexeddb disabled.
var indexedDB;
try {
    indexedDB = global.indexedDB;
} catch(e) {}

// if our browser (appears to) support indexeddb, use an indexeddb crypto store.
if (indexedDB) {
    matrixcs.setCryptoStoreFactory(
        function() {
            return new matrixcs.IndexedDBCryptoStore(
                indexedDB, "matrix-js-sdk:crypto"
            );
        }
    );
}

module.exports = matrixcs; // keep export for browserify package deps
global.matrixcs = matrixcs;
