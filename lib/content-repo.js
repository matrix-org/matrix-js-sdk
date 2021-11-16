"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getHttpUriForMxc = getHttpUriForMxc;

var utils = _interopRequireWildcard(require("./utils"));

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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

/**
 * @module content-repo
 */

/**
 * Get the HTTP URL for an MXC URI.
 * @param {string} baseUrl The base homeserver url which has a content repo.
 * @param {string} mxc The mxc:// URI.
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {Boolean} allowDirectLinks If true, return any non-mxc URLs
 * directly. Fetching such URLs will leak information about the user to
 * anyone they share a room with. If false, will return the emptry string
 * for such URLs.
 * @return {string} The complete URL to the content.
 */
function getHttpUriForMxc(baseUrl, mxc, width, height, resizeMethod, allowDirectLinks = false) {
  if (typeof mxc !== "string" || !mxc) {
    return '';
  }

  if (mxc.indexOf("mxc://") !== 0) {
    if (allowDirectLinks) {
      return mxc;
    } else {
      return '';
    }
  }

  let serverAndMediaId = mxc.slice(6); // strips mxc://

  let prefix = "/_matrix/media/r0/download/";
  const params = {};

  if (width) {
    params["width"] = Math.round(width);
  }

  if (height) {
    params["height"] = Math.round(height);
  }

  if (resizeMethod) {
    params["method"] = resizeMethod;
  }

  if (Object.keys(params).length > 0) {
    // these are thumbnailing params so they probably want the
    // thumbnailing API...
    prefix = "/_matrix/media/r0/thumbnail/";
  }

  const fragmentOffset = serverAndMediaId.indexOf("#");
  let fragment = "";

  if (fragmentOffset >= 0) {
    fragment = serverAndMediaId.substr(fragmentOffset);
    serverAndMediaId = serverAndMediaId.substr(0, fragmentOffset);
  }

  const urlParams = Object.keys(params).length === 0 ? "" : "?" + utils.encodeParams(params);
  return baseUrl + prefix + serverAndMediaId + urlParams + fragment;
}