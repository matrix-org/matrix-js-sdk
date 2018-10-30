var matrixcs = require("./lib/matrix");
const request = require('browser-request');
const queryString = require('qs');

matrixcs.request(function(opts, fn) {
    // We manually fix the query string for browser-request because
    // it doesn't correctly handle cases like ?via=one&via=two. Instead
    // we mimic `request`'s query string interface to make it all work
    // as expected.
    // browser-request will happily take the constructed string as the
    // query string without trying to modify it further.
    opts.qs = queryString.stringify(opts.qs || {}, opts.qsStringifyOptions);
    return request(opts, fn);
});

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
