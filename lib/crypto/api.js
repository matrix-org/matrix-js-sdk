"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CrossSigningKey = void 0;

/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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
// TODO: Merge this with crypto.js once converted
let CrossSigningKey;
exports.CrossSigningKey = CrossSigningKey;

(function (CrossSigningKey) {
  CrossSigningKey["Master"] = "master";
  CrossSigningKey["SelfSigning"] = "self_signing";
  CrossSigningKey["UserSigning"] = "user_signing";
})(CrossSigningKey || (exports.CrossSigningKey = CrossSigningKey = {}));