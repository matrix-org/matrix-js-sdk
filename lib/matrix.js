"use strict";

/** The Matrix Event class */
module.exports.MatrixEvent = require("./models/event").MatrixEvent;
/** An in-memory store for the SDK */
module.exports.MatrixInMemoryStore = require("./store/memory");
/** The raw HTTP API */
module.exports.MatrixHttpApi = require("./http-api");
/** The managed client class */
module.exports.MatrixClient = require("./client");

// expose the underlying request object so different environments can use
// different request libs (e.g. request or browser-request)
var request;
/**
 * The function used to perform HTTP requests.
 * @param {Function} r The request function which accepts (opts, callback)
 */
module.exports.request = function(r) {
    request = r;
};

/**
 * Create a new Matrix Client.
 * @param {Object} credentials The Matrix credentials to use.
 * @param {Object} config The config options for the client
 * @param {Store} store The type of store to use.
 * @return {MatrixClient} A new Matrix Client
 */
module.exports.createClient = function(credentials, config, store) {
    return new module.exports.MatrixClient(credentials, config, store, request);
};

