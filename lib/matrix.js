"use strict";

/** The {@link module:models/event.MatrixEvent|MatrixEvent} class. */
module.exports.MatrixEvent = require("./models/event").MatrixEvent;
/** The {@link module:store/memory.MatrixInMemoryStore|MatrixInMemoryStore} class. */
module.exports.MatrixInMemoryStore = require("./store/memory");
/** The {@link module:http-api.MatrixHttpApi|MatrixHttpApi} class. */
module.exports.MatrixHttpApi = require("./http-api").MatrixHttpApi;
/** The {@link module:http-api.MatrixError|MatrixError} class. */
module.exports.MatrixError = require("./http-api").MatrixError;
/** The {@link module:client.MatrixClient|MatrixClient} class. */
module.exports.MatrixClient = require("./client").MatrixClient;

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
 * Construct a Matrix Client. Identical to {@link module:client.MatrixClient}
 * except the 'request' option is already specified.
 * @param {(Object|string)} opts The configuration options for this client. If
 * this is a string, it is assumed to be the base URL.
 * @param {string} opts.baseUrl The base URL to the client-server HTTP API.
 * @param {boolean} opts.usePromises True to use promises rather than callbacks.
 * @param {string} opts.accessToken The access_token for this user.
 * @param {string} opts.userId The user ID for this user.
 * @param {Object} opts.store Optional. The data store to use. Defaults to
 * {@link module:store/memory.MatrixInMemoryStore}.
 * @return {MatrixClient} A new matrix client.
 */
module.exports.createClient = function(opts) {
    if (typeof opts === "string") {
        opts = {
            "baseUrl": opts
        };
    }
    opts.request = request;
    return new module.exports.MatrixClient(opts);
};

