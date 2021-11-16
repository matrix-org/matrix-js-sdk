"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
var _exportNames = {
  EventType: true,
  PushRuleKind: true,
  ISendEventResponse: true,
  SearchOrderBy: true,
  RoomSummary: true
};
Object.defineProperty(exports, "EventType", {
  enumerable: true,
  get: function () {
    return _event.EventType;
  }
});
Object.defineProperty(exports, "ISendEventResponse", {
  enumerable: true,
  get: function () {
    return _requests.ISendEventResponse;
  }
});
Object.defineProperty(exports, "PushRuleKind", {
  enumerable: true,
  get: function () {
    return _PushRules.PushRuleKind;
  }
});
Object.defineProperty(exports, "RoomSummary", {
  enumerable: true,
  get: function () {
    return _roomSummary.RoomSummary;
  }
});
Object.defineProperty(exports, "SearchOrderBy", {
  enumerable: true,
  get: function () {
    return _search.SearchOrderBy;
  }
});
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

var utils = _interopRequireWildcard(require("./utils"));

var _logger = require("./logger");

var _request = _interopRequireDefault(require("request"));

var _event = require("./@types/event");

var _PushRules = require("./@types/PushRules");

var _requests = require("./@types/requests");

var _search = require("./@types/search");

var _roomSummary = require("./models/room-summary");

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
matrixcs.request(_request.default);

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto');

  utils.setCrypto(crypto);
} catch (err) {
  _logger.logger.log('nodejs was compiled without crypto support');
}

var _default = matrixcs;
exports.default = _default;