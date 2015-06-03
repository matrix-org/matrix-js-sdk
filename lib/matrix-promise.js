// Wraps all matrix.js API calls in Q promises. To use this, simply
// require("matrix-promise") instead of require("matrix").
//
// API calls usually accept callback functions. However, all API calls
// also return the result from request(opts, callback). It seems pointless
// to return from this since it is always "undefined". However, the "request"
// module is also injected into the SDK. This allows us to wrap the
// "request" module to return a promise, which is then passed all the
// way back up to the public facing API call.
//
// This wrapper is designed for Node.js development, but a similar
// technique can be trivially applied on the browser (e.g. for AngularJS)
"use strict";

var matrixcs = require("./matrix");
var request = require("request");
var q = require("q");

matrixcs.request(function(opts, callback) {
    var defer = q.defer();
    request(opts, function(err, response, body) {
        // TODO possibly expose a responseHandler API
        // to avoid duplicating the 400 check with the core lib.
        if (err) {
            defer.reject(err);
            return;
        }
        if (response.statusCode >= 400) {
            defer.reject(body);
        }
        else {
            defer.resolve(body);
        }
    });
    return defer.promise;
});

/**
 * Export a modified matrix library with Promise support.
 */
module.exports = matrixcs;

