"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.IllegalMethod = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _Base = require("./Base");

/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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
 * Verification method that is illegal to have (cannot possibly
 * do verification with this method).
 * @module crypto/verification/IllegalMethod
 */

/**
 * @class crypto/verification/IllegalMethod/IllegalMethod
 * @extends {module:crypto/verification/Base}
 */
class IllegalMethod extends _Base.VerificationBase {
  constructor(...args) {
    super(...args);
    (0, _defineProperty2.default)(this, "doVerification", async () => {
      throw new Error("Verification is not possible with this method");
    });
  }

  static factory(channel, baseApis, userId, deviceId, startEvent, request) {
    return new IllegalMethod(channel, baseApis, userId, deviceId, startEvent, request);
  } // eslint-disable-next-line @typescript-eslint/naming-convention


  static get NAME() {
    // Typically the name will be something else, but to complete
    // the contract we offer a default one here.
    return "org.matrix.illegal_method";
  }

}

exports.IllegalMethod = IllegalMethod;