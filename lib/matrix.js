"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
var _exportNames = {
  request: true,
  getRequest: true,
  wrapRequest: true,
  setCryptoStoreFactory: true,
  createClient: true,
  ContentHelpers: true,
  createNewMatrixCall: true
};
exports.ContentHelpers = void 0;
exports.createClient = createClient;
Object.defineProperty(exports, "createNewMatrixCall", {
  enumerable: true,
  get: function () {
    return _call.createNewMatrixCall;
  }
});
exports.getRequest = getRequest;
exports.request = request;
exports.setCryptoStoreFactory = setCryptoStoreFactory;
exports.wrapRequest = wrapRequest;

var _memoryCryptoStore = require("./crypto/store/memory-crypto-store");

Object.keys(_memoryCryptoStore).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _memoryCryptoStore[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _memoryCryptoStore[key];
    }
  });
});

var _memory = require("./store/memory");

Object.keys(_memory).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _memory[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _memory[key];
    }
  });
});

var _scheduler = require("./scheduler");

Object.keys(_scheduler).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _scheduler[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _scheduler[key];
    }
  });
});

var _client = require("./client");

Object.keys(_client).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _client[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _client[key];
    }
  });
});

var _httpApi = require("./http-api");

Object.keys(_httpApi).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _httpApi[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _httpApi[key];
    }
  });
});

var _autodiscovery = require("./autodiscovery");

Object.keys(_autodiscovery).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _autodiscovery[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _autodiscovery[key];
    }
  });
});

var _syncAccumulator = require("./sync-accumulator");

Object.keys(_syncAccumulator).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _syncAccumulator[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _syncAccumulator[key];
    }
  });
});

var _errors = require("./errors");

Object.keys(_errors).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _errors[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _errors[key];
    }
  });
});

var _event = require("./models/event");

Object.keys(_event).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _event[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _event[key];
    }
  });
});

var _room = require("./models/room");

Object.keys(_room).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _room[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _room[key];
    }
  });
});

var _group = require("./models/group");

Object.keys(_group).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _group[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _group[key];
    }
  });
});

var _eventTimeline = require("./models/event-timeline");

Object.keys(_eventTimeline).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _eventTimeline[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _eventTimeline[key];
    }
  });
});

var _eventTimelineSet = require("./models/event-timeline-set");

Object.keys(_eventTimelineSet).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _eventTimelineSet[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _eventTimelineSet[key];
    }
  });
});

var _roomMember = require("./models/room-member");

Object.keys(_roomMember).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _roomMember[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _roomMember[key];
    }
  });
});

var _roomState = require("./models/room-state");

Object.keys(_roomState).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _roomState[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _roomState[key];
    }
  });
});

var _user = require("./models/user");

Object.keys(_user).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _user[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _user[key];
    }
  });
});

var _filter = require("./filter");

Object.keys(_filter).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _filter[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _filter[key];
    }
  });
});

var _timelineWindow = require("./timeline-window");

Object.keys(_timelineWindow).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _timelineWindow[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _timelineWindow[key];
    }
  });
});

var _interactiveAuth = require("./interactive-auth");

Object.keys(_interactiveAuth).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _interactiveAuth[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _interactiveAuth[key];
    }
  });
});

var _serviceTypes = require("./service-types");

Object.keys(_serviceTypes).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _serviceTypes[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _serviceTypes[key];
    }
  });
});

var _indexeddb = require("./store/indexeddb");

Object.keys(_indexeddb).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _indexeddb[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _indexeddb[key];
    }
  });
});

var _webstorage = require("./store/session/webstorage");

Object.keys(_webstorage).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _webstorage[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _webstorage[key];
    }
  });
});

var _indexeddbCryptoStore = require("./crypto/store/indexeddb-crypto-store");

Object.keys(_indexeddbCryptoStore).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _indexeddbCryptoStore[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _indexeddbCryptoStore[key];
    }
  });
});

var _contentRepo = require("./content-repo");

Object.keys(_contentRepo).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _contentRepo[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _contentRepo[key];
    }
  });
});

var _ContentHelpers = _interopRequireWildcard(require("./content-helpers"));

exports.ContentHelpers = _ContentHelpers;

var _call = require("./webrtc/call");

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

/*
Copyright 2015-2021 The Matrix.org Foundation C.I.C.

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
// expose the underlying request object so different environments can use
// different request libs (e.g. request or browser-request)
let requestInstance;
/**
 * The function used to perform HTTP requests. Only use this if you want to
 * use a different HTTP library, e.g. Angular's <code>$http</code>. This should
 * be set prior to calling {@link createClient}.
 * @param {requestFunction} r The request function to use.
 */

function request(r) {
  requestInstance = r;
}
/**
 * Return the currently-set request function.
 * @return {requestFunction} The current request function.
 */


function getRequest() {
  return requestInstance;
}
/**
 * Apply wrapping code around the request function. The wrapper function is
 * installed as the new request handler, and when invoked it is passed the
 * previous value, along with the options and callback arguments.
 * @param {requestWrapperFunction} wrapper The wrapping function.
 */


function wrapRequest(wrapper) {
  const origRequest = requestInstance;

  requestInstance = function (options, callback) {
    return wrapper(origRequest, options, callback);
  };
}

let cryptoStoreFactory = () => new _memoryCryptoStore.MemoryCryptoStore();
/**
 * Configure a different factory to be used for creating crypto stores
 *
 * @param {Function} fac  a function which will return a new
 *    {@link module:crypto.store.base~CryptoStore}.
 */


function setCryptoStoreFactory(fac) {
  cryptoStoreFactory = fac;
}

/**
 * Construct a Matrix Client. Similar to {@link module:client.MatrixClient}
 * except that the 'request', 'store' and 'scheduler' dependencies are satisfied.
 * @param {(Object|string)} opts The configuration options for this client. If
 * this is a string, it is assumed to be the base URL. These configuration
 * options will be passed directly to {@link module:client.MatrixClient}.
 * @param {Object} opts.store If not set, defaults to
 * {@link module:store/memory.MemoryStore}.
 * @param {Object} opts.scheduler If not set, defaults to
 * {@link module:scheduler~MatrixScheduler}.
 * @param {requestFunction} opts.request If not set, defaults to the function
 * supplied to {@link request} which defaults to the request module from NPM.
 *
 * @param {module:crypto.store.base~CryptoStore=} opts.cryptoStore
 *    crypto store implementation. Calls the factory supplied to
 *    {@link setCryptoStoreFactory} if unspecified; or if no factory has been
 *    specified, uses a default implementation (indexeddb in the browser,
 *    in-memory otherwise).
 *
 * @return {MatrixClient} A new matrix client.
 * @see {@link module:client.MatrixClient} for the full list of options for
 * <code>opts</code>.
 */
function createClient(opts) {
  if (typeof opts === "string") {
    opts = {
      "baseUrl": opts
    };
  }

  opts.request = opts.request || requestInstance;
  opts.store = opts.store || new _memory.MemoryStore({
    localStorage: global.localStorage
  });
  opts.scheduler = opts.scheduler || new _scheduler.MatrixScheduler();
  opts.cryptoStore = opts.cryptoStore || cryptoStoreFactory();
  return new _client.MatrixClient(opts);
}
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