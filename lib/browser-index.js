"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
var _exportNames = {};
exports.default = void 0;

var matrixcs = _interopRequireWildcard(require("./matrix"));

Object.keys(matrixcs).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === matrixcs[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return matrixcs[key];
    }
  });
});

var _browserRequest = _interopRequireDefault(require("browser-request"));

var _qs = _interopRequireDefault(require("qs"));

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

/*
Copyright 2019 The Matrix.org Foundation C.I.C.

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
matrixcs.request(function (opts, fn) {
  // We manually fix the query string for browser-request because
  // it doesn't correctly handle cases like ?via=one&via=two. Instead
  // we mimic `request`'s query string interface to make it all work
  // as expected.
  // browser-request will happily take the constructed string as the
  // query string without trying to modify it further.
  opts.qs = _qs.default.stringify(opts.qs || {}, opts.qsStringifyOptions);
  return (0, _browserRequest.default)(opts, fn);
}); // just *accessing* indexedDB throws an exception in firefox with
// indexeddb disabled.

let indexedDB;

try {
  indexedDB = global.indexedDB;
} catch (e) {} // if our browser (appears to) support indexeddb, use an indexeddb crypto store.


if (indexedDB) {
  matrixcs.setCryptoStoreFactory(function () {
    return new matrixcs.IndexedDBCryptoStore(indexedDB, "matrix-js-sdk:crypto");
  });
} // We export 3 things to make browserify happy as well as downstream projects.
// It's awkward, but required.


var _default = matrixcs; // keep export for browserify package deps

exports.default = _default;
global.matrixcs = matrixcs;