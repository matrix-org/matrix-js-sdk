/*
Copyright 2015, 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
"use strict";

/** The {@link module:models/event.MatrixEvent|MatrixEvent} class. */
module.exports.MatrixEvent = require("./models/event").MatrixEvent;
/** The {@link module:models/event.EventStatus|EventStatus} enum. */
module.exports.EventStatus = require("./models/event").EventStatus;
/** The {@link module:store/memory.MatrixInMemoryStore|MatrixInMemoryStore} class. */
module.exports.MatrixInMemoryStore = require("./store/memory").MatrixInMemoryStore;
/** The {@link module:store/webstorage~WebStorageStore|WebStorageStore} class.
 * <strong>Work in progress; unstable.</strong> */
module.exports.WebStorageStore = require("./store/webstorage");
/** The {@link module:http-api.MatrixHttpApi|MatrixHttpApi} class. */
module.exports.MatrixHttpApi = require("./http-api").MatrixHttpApi;
/** The {@link module:http-api.MatrixError|MatrixError} class. */
module.exports.MatrixError = require("./http-api").MatrixError;
/** The {@link module:client.MatrixClient|MatrixClient} class. */
module.exports.MatrixClient = require("./client").MatrixClient;
/** The {@link module:models/room|Room} class. */
module.exports.Room = require("./models/room");
/** The {@link module:models/event-timeline~EventTimeline} class. */
module.exports.EventTimeline = require("./models/event-timeline");
/** The {@link module:models/event-timeline-set~EventTimelineSet} class. */
module.exports.EventTimelineSet = require("./models/event-timeline-set");
/** The {@link module:models/room-member|RoomMember} class. */
module.exports.RoomMember = require("./models/room-member");
/** The {@link module:models/room-state~RoomState|RoomState} class. */
module.exports.RoomState = require("./models/room-state");
/** The {@link module:models/user~User|User} class. */
module.exports.User = require("./models/user");
/** The {@link module:scheduler~MatrixScheduler|MatrixScheduler} class. */
module.exports.MatrixScheduler = require("./scheduler");
/** The {@link module:store/session/webstorage~WebStorageSessionStore|
 * WebStorageSessionStore} class. <strong>Work in progress; unstable.</strong> */
module.exports.WebStorageSessionStore = require("./store/session/webstorage");
/** True if crypto libraries are being used on this client. */
module.exports.CRYPTO_ENABLED = require("./client").CRYPTO_ENABLED;
/** {@link module:content-repo|ContentRepo} utility functions. */
module.exports.ContentRepo = require("./content-repo");
/** The {@link module:filter~Filter|Filter} class. */
module.exports.Filter = require("./filter");
/** The {@link module:timeline-window~TimelineWindow} class. */
module.exports.TimelineWindow = require("./timeline-window").TimelineWindow;
/** The {@link module:interactive-auth} class. */
module.exports.InteractiveAuth = require("./interactive-auth");


/**
 * Create a new Matrix Call.
 * @function
 * @param {module:client.MatrixClient} client The MatrixClient instance to use.
 * @param {string} roomId The room the call is in.
 * @return {module:webrtc/call~MatrixCall} The Matrix call or null if the browser
 * does not support WebRTC.
 */
module.exports.createNewMatrixCall = require("./webrtc/call").createNewMatrixCall;

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
 * Return the currently-set request function.
 * @return {requestFunction} The current request function.
 */
module.exports.getRequest = function() {
    return request;
};

/**
 * Apply wrapping code around the request function. The wrapper function is
 * installed as the new request handler, and when invoked it is passed the
 * previous value, along with the options and callback arguments.
 * @param {requestWrapperFunction} wrapper The wrapping function.
 */
module.exports.wrapRequest = function(wrapper) {
    var origRequest = request;
    request = function(options, callback) {
        return wrapper(origRequest, options, callback);
    };
};

/**
 * Construct a Matrix Client. Similar to {@link module:client~MatrixClient}
 * except that the 'request', 'store' and 'scheduler' dependencies are satisfied.
 * @param {(Object|string)} opts The configuration options for this client. If
 * this is a string, it is assumed to be the base URL. These configuration
 * options will be passed directly to {@link module:client~MatrixClient}.
 * @param {Object} opts.store If not set, defaults to
 * {@link module:store/memory.MatrixInMemoryStore}.
 * @param {Object} opts.scheduler If not set, defaults to
 * {@link module:scheduler~MatrixScheduler}.
 * @param {requestFunction} opts.request If not set, defaults to the function
 * supplied to {@link request} which defaults to the request module from NPM.
 * @return {MatrixClient} A new matrix client.
 * @see {@link module:client~MatrixClient} for the full list of options for
 * <code>opts</code>.
 */
module.exports.createClient = function(opts) {
    if (typeof opts === "string") {
        opts = {
            "baseUrl": opts
        };
    }
    opts.request = opts.request || request;
    opts.store = opts.store || new module.exports.MatrixInMemoryStore({
      localStorage: global.localStorage
    });
    opts.scheduler = opts.scheduler || new module.exports.MatrixScheduler();
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
 * A wrapper for the request function interface.
 * @callback requestWrapperFunction
 * @param {requestFunction} origRequest The underlying request function being
 * wrapped
 * @param {Object} opts The options for this HTTP request, given in the same
 * form as {@link requestFunction}.
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
