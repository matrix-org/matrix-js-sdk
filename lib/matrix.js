"use strict";

/** The {@link module:models/event.MatrixEvent|MatrixEvent} class. */
module.exports.MatrixEvent = require("./models/event").MatrixEvent;
/** The {@link module:models/event.EventStatus|EventStatus} enum. */
module.exports.EventStatus = require("./models/event").EventStatus;
/** The {@link module:store/memory.MatrixInMemoryStore|MatrixInMemoryStore} class. */
module.exports.MatrixInMemoryStore = require("./store/memory").MatrixInMemoryStore;
/** The {@link module:store/localstorage.LocalStorageStore|LocalStorageStore} class. */
module.exports.LocalStorageStore = require("./store/localstorage");
/** The {@link module:http-api.MatrixHttpApi|MatrixHttpApi} class. */
module.exports.MatrixHttpApi = require("./http-api").MatrixHttpApi;
/** The {@link module:http-api.MatrixError|MatrixError} class. */
module.exports.MatrixError = require("./http-api").MatrixError;
/** The {@link module:client.MatrixClient|MatrixClient} class. */
module.exports.MatrixClient = require("./client").MatrixClient;
/** The {@link module:models/room~Room|Room} class. */
module.exports.Room = require("./models/room");
/** The {@link module:models/room-member~RoomMember|RoomMember} class. */
module.exports.RoomMember = require("./models/room-member");
/** The {@link module:models/room-state~RoomState|RoomState} class. */
module.exports.RoomState = require("./models/room-state");
/** The {@link module:models/user~User|User} class. */
module.exports.User = require("./models/user");
/** The {@link module:scheduler~MatrixScheduler|MatrixScheduler} class. */
module.exports.MatrixScheduler = require("./scheduler");

// expose the underlying request object so different environments can use
// different request libs (e.g. request or browser-request)
var request;
/**
 * The function used to perform HTTP requests. Only use this if you want to
 * use a different HTTP library, e.g. Angular's <code>$http</code>. This should
 * be set prior to calling {@link createClient}.
 * @param {requestFunction} r The request function to use.
 */
module.exports.request = function(r) {
    request = r;
};

/**
 * Construct a Matrix Client. Similar to {@link module:client~MatrixClient}
 * except that the 'request', 'store' and 'scheduler' dependencies are satisfied.
 * @param {(Object|string)} opts The configuration options for this client. If
 * this is a string, it is assumed to be the base URL. These configuration
 * options will be passed directly to {@link module:client~MatrixClient}.
 * @param {string} opts.baseUrl The base URL to the client-server HTTP API.
 * @param {string} opts.accessToken Optional. The access_token for this user.
 * @param {string} opts.userId Optional. The user ID for this user.
 * @param {Object} opts.store Set to {@link module:store/memory.MatrixInMemoryStore}.
 * @param {Object} opts.scheduler Set to {@link module:scheduler~MatrixScheduler}.
 * @return {MatrixClient} A new matrix client.
 */
module.exports.createClient = function(opts) {
    if (typeof opts === "string") {
        opts = {
            "baseUrl": opts
        };
    }
    opts.request = request;
    opts.store = new module.exports.MatrixInMemoryStore();
    opts.scheduler = new module.exports.MatrixScheduler();
    return new module.exports.MatrixClient(opts);
};

/**
 * The request function interface for performing HTTP requests. This matches the
 * API for the {@link https://github.com/request/request#requestoptions-callback|
 * request NPM module}. The SDK will attempt to call this function in order to
 * perform an HTTP request.
 * @callback requestFunction
 * @param {Object} opts The options for this HTTP request.
 * @param {string} opts.uri The complete URI.
 * @param {string} opts.method The HTTP method.
 * @param {Object} opts.qs The query parameters to append to the URI.
 * @param {Object} opts.body The JSON-serializable object.
 * @param {boolean} opts.json True if this is a JSON request.
 * @param {Object} opts._matrix_opts The underlying options set for
 * {@link MatrixHttpApi}.
 * @param {requestCallback} callback The request callback.
 */

 /**
  * The request callback interface for performing HTTP requests. This matches the
  * API for the {@link https://github.com/request/request#requestoptions-callback|
  * request NPM module}. The SDK will implement a callback which meets this
  * interface in order to handle the HTTP response.
  * @callback requestCallback
  * @param {Error} err The error if one occurred, else falsey.
  * @param {Object} response The HTTP response which consists of
  * <code>{statusCode: {Number}, headers: {Object}}</code>
  * @param {Object} body The parsed HTTP response body.
  */
