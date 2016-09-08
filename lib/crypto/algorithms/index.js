/*
Copyright 2016 OpenMarket Ltd

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

/**
 * @module crypto/algorithms
 */

var base = require("./base");

require("./olm");
require("./megolm");

/**
 * @see module:crypto/algorithms/base.ENCRYPTION_CLASSES
 */
module.exports.ENCRYPTION_CLASSES = base.ENCRYPTION_CLASSES;

/**
 * @see module:crypto/algorithms/base.DECRYPTION_CLASSES
 */
module.exports.DECRYPTION_CLASSES = base.DECRYPTION_CLASSES;

/**
 * @see module:crypto/algorithms/base.DecryptionError
 */
module.exports.DecryptionError = base.DecryptionError;
