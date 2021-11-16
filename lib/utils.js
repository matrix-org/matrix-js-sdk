"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DEFAULT_ALPHABET = void 0;
exports.alphabetPad = alphabetPad;
exports.averageBetweenStrings = averageBetweenStrings;
exports.baseToString = baseToString;
exports.checkObjectHasKeys = checkObjectHasKeys;
exports.checkObjectHasNoAdditionalKeys = checkObjectHasNoAdditionalKeys;
exports.chunkPromises = chunkPromises;
exports.compare = compare;
exports.decodeParams = decodeParams;
exports.deepCompare = deepCompare;
exports.deepCopy = deepCopy;
exports.deepSortedObjectEntries = deepSortedObjectEntries;
exports.defer = defer;
exports.encodeParams = encodeParams;
exports.encodeUri = encodeUri;
exports.ensureNoTrailingSlash = ensureNoTrailingSlash;
exports.escapeRegExp = escapeRegExp;
exports.extend = extend;
exports.getCrypto = getCrypto;
exports.globToRegexp = globToRegexp;
exports.inherits = inherits;
exports.isFunction = isFunction;
exports.isNullOrUndefined = isNullOrUndefined;
exports.isNumber = isNumber;
exports.lexicographicCompare = lexicographicCompare;
exports.nextString = nextString;
exports.normalize = normalize;
exports.polyfillSuper = polyfillSuper;
exports.prevString = prevString;
exports.promiseMapSeries = promiseMapSeries;
exports.promiseTry = promiseTry;
exports.recursivelyAssign = recursivelyAssign;
exports.removeDirectionOverrideChars = removeDirectionOverrideChars;
exports.removeElement = removeElement;
exports.removeHiddenChars = removeHiddenChars;
exports.setCrypto = setCrypto;
exports.simpleRetryOperation = simpleRetryOperation;
exports.sleep = sleep;
exports.stringToBase = stringToBase;

var _unhomoglyph = _interopRequireDefault(require("unhomoglyph"));

var _pRetry = _interopRequireDefault(require("p-retry"));

/*
Copyright 2015, 2016 OpenMarket Ltd
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

/**
 * This is an internal module.
 * @module utils
 */

/**
 * Encode a dictionary of query parameters.
 * @param {Object} params A dict of key/values to encode e.g.
 * {"foo": "bar", "baz": "taz"}
 * @return {string} The encoded string e.g. foo=bar&baz=taz
 */
function encodeParams(params) {
  return new URLSearchParams(params).toString();
}

/**
 * Decode a query string in `application/x-www-form-urlencoded` format.
 * @param {string} query A query string to decode e.g.
 * foo=bar&via=server1&server2
 * @return {Object} The decoded object, if any keys occurred multiple times
 * then the value will be an array of strings, else it will be an array.
 * This behaviour matches Node's qs.parse but is built on URLSearchParams
 * for native web compatibility
 */
function decodeParams(query) {
  const o = {};
  const params = new URLSearchParams(query);

  for (const key of params.keys()) {
    const val = params.getAll(key);
    o[key] = val.length === 1 ? val[0] : val;
  }

  return o;
}
/**
 * Encodes a URI according to a set of template variables. Variables will be
 * passed through encodeURIComponent.
 * @param {string} pathTemplate The path with template variables e.g. '/foo/$bar'.
 * @param {Object} variables The key/value pairs to replace the template
 * variables with. E.g. { "$bar": "baz" }.
 * @return {string} The result of replacing all template variables e.g. '/foo/baz'.
 */


function encodeUri(pathTemplate, variables) {
  for (const key in variables) {
    if (!variables.hasOwnProperty(key)) {
      continue;
    }

    pathTemplate = pathTemplate.replace(key, encodeURIComponent(variables[key]));
  }

  return pathTemplate;
}
/**
 * The removeElement() method removes the first element in the array that
 * satisfies (returns true) the provided testing function.
 * @param {Array} array The array.
 * @param {Function} fn Function to execute on each value in the array, with the
 * function signature <code>fn(element, index, array)</code>. Return true to
 * remove this element and break.
 * @param {boolean} reverse True to search in reverse order.
 * @return {boolean} True if an element was removed.
 */


function removeElement(array, fn, reverse) {
  let i;
  let removed;

  if (reverse) {
    for (i = array.length - 1; i >= 0; i--) {
      if (fn(array[i], i, array)) {
        removed = array[i];
        array.splice(i, 1);
        return removed;
      }
    }
  } else {
    for (i = 0; i < array.length; i++) {
      if (fn(array[i], i, array)) {
        removed = array[i];
        array.splice(i, 1);
        return removed;
      }
    }
  }

  return false;
}
/**
 * Checks if the given thing is a function.
 * @param {*} value The thing to check.
 * @return {boolean} True if it is a function.
 */


function isFunction(value) {
  return Object.prototype.toString.call(value) === "[object Function]";
}
/**
 * Checks that the given object has the specified keys.
 * @param {Object} obj The object to check.
 * @param {string[]} keys The list of keys that 'obj' must have.
 * @throws If the object is missing keys.
 */
// note using 'keys' here would shadow the 'keys' function defined above


function checkObjectHasKeys(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (!obj.hasOwnProperty(keys[i])) {
      throw new Error("Missing required key: " + keys[i]);
    }
  }
}
/**
 * Checks that the given object has no extra keys other than the specified ones.
 * @param {Object} obj The object to check.
 * @param {string[]} allowedKeys The list of allowed key names.
 * @throws If there are extra keys.
 */


function checkObjectHasNoAdditionalKeys(obj, allowedKeys) {
  for (const key in obj) {
    if (!obj.hasOwnProperty(key)) {
      continue;
    }

    if (allowedKeys.indexOf(key) === -1) {
      throw new Error("Unknown key: " + key);
    }
  }
}
/**
 * Deep copy the given object. The object MUST NOT have circular references and
 * MUST NOT have functions.
 * @param {Object} obj The object to deep copy.
 * @return {Object} A copy of the object without any references to the original.
 */


function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
/**
 * Compare two objects for equality. The objects MUST NOT have circular references.
 *
 * @param {Object} x The first object to compare.
 * @param {Object} y The second object to compare.
 *
 * @return {boolean} true if the two objects are equal
 */


function deepCompare(x, y) {
  // Inspired by
  // http://stackoverflow.com/questions/1068834/object-comparison-in-javascript#1144249
  // Compare primitives and functions.
  // Also check if both arguments link to the same object.
  if (x === y) {
    return true;
  }

  if (typeof x !== typeof y) {
    return false;
  } // special-case NaN (since NaN !== NaN)


  if (typeof x === 'number' && isNaN(x) && isNaN(y)) {
    return true;
  } // special-case null (since typeof null == 'object', but null.constructor
  // throws)


  if (x === null || y === null) {
    return x === y;
  } // everything else is either an unequal primitive, or an object


  if (!(x instanceof Object)) {
    return false;
  } // check they are the same type of object


  if (x.constructor !== y.constructor || x.prototype !== y.prototype) {
    return false;
  } // special-casing for some special types of object


  if (x instanceof RegExp || x instanceof Date) {
    return x.toString() === y.toString();
  } // the object algorithm works for Array, but it's sub-optimal.


  if (x instanceof Array) {
    if (x.length !== y.length) {
      return false;
    }

    for (let i = 0; i < x.length; i++) {
      if (!deepCompare(x[i], y[i])) {
        return false;
      }
    }
  } else {
    // disable jshint "The body of a for in should be wrapped in an if
    // statement"

    /* jshint -W089 */
    // check that all of y's direct keys are in x
    let p;

    for (p in y) {
      if (y.hasOwnProperty(p) !== x.hasOwnProperty(p)) {
        return false;
      }
    } // finally, compare each of x's keys with y


    for (p in y) {
      // eslint-disable-line guard-for-in
      if (y.hasOwnProperty(p) !== x.hasOwnProperty(p)) {
        return false;
      }

      if (!deepCompare(x[p], y[p])) {
        return false;
      }
    }
  }
  /* jshint +W089 */


  return true;
} // Dev note: This returns a tuple, but jsdoc doesn't like that. https://github.com/jsdoc/jsdoc/issues/1703

/**
 * Creates an array of object properties/values (entries) then
 * sorts the result by key, recursively. The input object must
 * ensure it does not have loops. If the input is not an object
 * then it will be returned as-is.
 * @param {*} obj The object to get entries of
 * @returns {Array} The entries, sorted by key.
 */


function deepSortedObjectEntries(obj) {
  if (typeof obj !== "object") return obj; // Apparently these are object types...

  if (obj === null || obj === undefined || Array.isArray(obj)) return obj;
  const pairs = [];

  for (const [k, v] of Object.entries(obj)) {
    pairs.push([k, deepSortedObjectEntries(v)]);
  } // lexicographicCompare is faster than localeCompare, so let's use that.


  pairs.sort((a, b) => lexicographicCompare(a[0], b[0]));
  return pairs;
}
/**
 * Copy properties from one object to another.
 *
 * All enumerable properties, included inherited ones, are copied.
 *
 * This is approximately equivalent to ES6's Object.assign, except
 * that the latter doesn't copy inherited properties.
 *
 * @param {Object} target  The object that will receive new properties
 * @param {...Object} source  Objects from which to copy properties
 *
 * @return {Object} target
 */


function extend(...restParams) {
  const target = restParams[0] || {};

  for (let i = 1; i < restParams.length; i++) {
    const source = restParams[i];
    if (!source) continue;

    for (const propName in source) {
      // eslint-disable-line guard-for-in
      target[propName] = source[propName];
    }
  }

  return target;
}
/**
 * Inherit the prototype methods from one constructor into another. This is a
 * port of the Node.js implementation with an Object.create polyfill.
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */


function inherits(ctor, superCtor) {
  // Add util.inherits from Node.js
  // Source:
  // https://github.com/joyent/node/blob/master/lib/util.js
  // Copyright Joyent, Inc. and other Node contributors.
  //
  // Permission is hereby granted, free of charge, to any person obtaining a
  // copy of this software and associated documentation files (the
  // "Software"), to deal in the Software without restriction, including
  // without limitation the rights to use, copy, modify, merge, publish,
  // distribute, sublicense, and/or sell copies of the Software, and to permit
  // persons to whom the Software is furnished to do so, subject to the
  // following conditions:
  //
  // The above copyright notice and this permission notice shall be included
  // in all copies or substantial portions of the Software.
  //
  // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
  // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
  // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
  // USE OR OTHER DEALINGS IN THE SOFTWARE.
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: {
      value: ctor,
      enumerable: false,
      writable: true,
      configurable: true
    }
  });
}
/**
 * Polyfills inheritance for prototypes by allowing different kinds of
 * super types. Typically prototypes would use `SuperType.call(this, params)`
 * though this doesn't always work in some environments - this function
 * falls back to using `Object.assign()` to clone a constructed copy
 * of the super type onto `thisArg`.
 * @param {any} thisArg The child instance. Modified in place.
 * @param {any} SuperType The type to act as a super instance
 * @param {any} params Arguments to supply to the super type's constructor
 */


function polyfillSuper(thisArg, SuperType, ...params) {
  try {
    SuperType.call(thisArg, ...params);
  } catch (e) {
    // fall back to Object.assign to just clone the thing
    const fakeSuper = new SuperType(...params);
    Object.assign(thisArg, fakeSuper);
  }
}
/**
 * Returns whether the given value is a finite number without type-coercion
 *
 * @param {*} value the value to test
 * @return {boolean} whether or not value is a finite number without type-coercion
 */


function isNumber(value) {
  return typeof value === 'number' && isFinite(value);
}
/**
 * Removes zero width chars, diacritics and whitespace from the string
 * Also applies an unhomoglyph on the string, to prevent similar looking chars
 * @param {string} str the string to remove hidden characters from
 * @return {string} a string with the hidden characters removed
 */


function removeHiddenChars(str) {
  if (typeof str === "string") {
    return (0, _unhomoglyph.default)(str.normalize('NFD').replace(removeHiddenCharsRegex, ''));
  }

  return "";
}
/**
 * Removes the direction override characters from a string
 * @param {string} input
 * @returns string with chars removed
 */


function removeDirectionOverrideChars(str) {
  if (typeof str === "string") {
    return str.replace(/[\u202d-\u202e]/g, '');
  }

  return "";
}

function normalize(str) {
  // Note: we have to match the filter with the removeHiddenChars() because the
  // function strips spaces and other characters (M becomes RN for example, in lowercase).
  return removeHiddenChars(str.toLowerCase()) // Strip all punctuation
  .replace(/[\\'!"#$%&()*+,\-./:;<=>?@[\]^_`{|}~\u2000-\u206f\u2e00-\u2e7f]/g, "") // We also doubly convert to lowercase to work around oddities of the library.
  .toLowerCase();
} // Regex matching bunch of unicode control characters and otherwise misleading/invisible characters.
// Includes:
// various width spaces U+2000 - U+200D
// LTR and RTL marks U+200E and U+200F
// LTR/RTL and other directional formatting marks U+202A - U+202F
// Arabic Letter RTL mark U+061C
// Combining characters U+0300 - U+036F
// Zero width no-break space (BOM) U+FEFF
// eslint-disable-next-line no-misleading-character-class


const removeHiddenCharsRegex = /[\u2000-\u200F\u202A-\u202F\u0300-\u036F\uFEFF\u061C\s]/g;

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegexp(glob, extended) {
  extended = typeof extended === 'boolean' ? extended : true; // From
  // https://github.com/matrix-org/synapse/blob/abbee6b29be80a77e05730707602f3bbfc3f38cb/synapse/push/__init__.py#L132
  // Because micromatch is about 130KB with dependencies,
  // and minimatch is not much better.

  let pat = escapeRegExp(glob);
  pat = pat.replace(/\\\*/g, '.*');
  pat = pat.replace(/\?/g, '.');

  if (extended) {
    pat = pat.replace(/\\\[(!|)(.*)\\]/g, function (match, p1, p2, offset, string) {
      const first = p1 && '^' || '';
      const second = p2.replace(/\\-/, '-');
      return '[' + first + second + ']';
    });
  }

  return pat;
}

function ensureNoTrailingSlash(url) {
  if (url && url.endsWith("/")) {
    return url.substr(0, url.length - 1);
  } else {
    return url;
  }
} // Returns a promise which resolves with a given value after the given number of ms


function sleep(ms, value) {
  return new Promise(resolve => {
    setTimeout(resolve, ms, value);
  });
}

function isNullOrUndefined(val) {
  return val === null || val === undefined;
}

// Returns a Deferred
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return {
    resolve,
    reject,
    promise
  };
}

async function promiseMapSeries(promises, fn) {
  for (const o of promises) {
    await fn(await o);
  }
}

function promiseTry(fn) {
  return new Promise(resolve => resolve(fn()));
} // Creates and awaits all promises, running no more than `chunkSize` at the same time


async function chunkPromises(fns, chunkSize) {
  const results = [];

  for (let i = 0; i < fns.length; i += chunkSize) {
    results.push(...(await Promise.all(fns.slice(i, i + chunkSize).map(fn => fn()))));
  }

  return results;
}
/**
 * Retries the function until it succeeds or is interrupted. The given function must return
 * a promise which throws/rejects on error, otherwise the retry will assume the request
 * succeeded. The promise chain returned will contain the successful promise. The given function
 * should always return a new promise.
 * @param {Function} promiseFn The function to call to get a fresh promise instance. Takes an
 * attempt count as an argument, for logging/debugging purposes.
 * @returns {Promise<T>} The promise for the retried operation.
 */


function simpleRetryOperation(promiseFn) {
  return (0, _pRetry.default)(attempt => {
    return promiseFn(attempt);
  }, {
    forever: true,
    factor: 2,
    minTimeout: 3000,
    // ms
    maxTimeout: 15000 // ms

  });
} // We need to be able to access the Node.js crypto library from within the
// Matrix SDK without needing to `require("crypto")`, which will fail in
// browsers.  So `index.ts` will call `setCrypto` to store it, and when we need
// it, we can call `getCrypto`.


let crypto;

function setCrypto(c) {
  crypto = c;
}

function getCrypto() {
  return crypto;
} // String averaging inspired by https://stackoverflow.com/a/2510816
// Dev note: We make the alphabet a string because it's easier to write syntactically
// than arrays. Thankfully, strings implement the useful parts of the Array interface
// anyhow.

/**
 * The default alphabet used by string averaging in this SDK. This matches
 * all usefully printable ASCII characters (0x20-0x7E, inclusive).
 */


const DEFAULT_ALPHABET = (() => {
  let str = "";

  for (let c = 0x20; c <= 0x7E; c++) {
    str += String.fromCharCode(c);
  }

  return str;
})();
/**
 * Pads a string using the given alphabet as a base. The returned string will be
 * padded at the end with the first character in the alphabet.
 *
 * This is intended for use with string averaging.
 * @param {string} s The string to pad.
 * @param {number} n The length to pad to.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The padded string.
 */


exports.DEFAULT_ALPHABET = DEFAULT_ALPHABET;

function alphabetPad(s, n, alphabet = DEFAULT_ALPHABET) {
  return s.padEnd(n, alphabet[0]);
}
/**
 * Converts a baseN number to a string, where N is the alphabet's length.
 *
 * This is intended for use with string averaging.
 * @param {bigint} n The baseN number.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The baseN number encoded as a string from the alphabet.
 */


function baseToString(n, alphabet = DEFAULT_ALPHABET) {
  // Developer note: the stringToBase() function offsets the character set by 1 so that repeated
  // characters (ie: "aaaaaa" in a..z) don't come out as zero. We have to reverse this here as
  // otherwise we'll be wrong in our conversion. Undoing a +1 before an exponent isn't very fun
  // though, so we rely on a lengthy amount of `x - 1` and integer division rules to reach a
  // sane state. This also means we have to do rollover detection: see below.
  const len = BigInt(alphabet.length);

  if (n <= len) {
    var _alphabet;

    return (_alphabet = alphabet[Number(n) - 1]) !== null && _alphabet !== void 0 ? _alphabet : "";
  }

  let d = n / len;
  let r = Number(n % len) - 1; // Rollover detection: if the remainder is negative, it means that the string needs
  // to roll over by 1 character downwards (ie: in a..z, the previous to "aaa" would be
  // "zz").

  if (r < 0) {
    d -= BigInt(Math.abs(r)); // abs() is just to be clear what we're doing. Could also `+= r`.

    r = Number(len) - 1;
  }

  return baseToString(d, alphabet) + alphabet[r];
}
/**
 * Converts a string to a baseN number, where N is the alphabet's length.
 *
 * This is intended for use with string averaging.
 * @param {string} s The string to convert to a number.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {bigint} The baseN number.
 */


function stringToBase(s, alphabet = DEFAULT_ALPHABET) {
  const len = BigInt(alphabet.length); // In our conversion to baseN we do a couple performance optimizations to avoid using
  // excess CPU and such. To create baseN numbers, the input string needs to be reversed
  // so the exponents stack up appropriately, as the last character in the unreversed
  // string has less impact than the first character (in "abc" the A is a lot more important
  // for lexicographic sorts). We also do a trick with the character codes to optimize the
  // alphabet lookup, avoiding an index scan of `alphabet.indexOf(reversedStr[i])` - we know
  // that the alphabet and (theoretically) the input string are constrained on character sets
  // and thus can do simple subtraction to end up with the same result.
  // Developer caution: we carefully cast to BigInt here to avoid losing precision. We cannot
  // rely on Math.pow() (for example) to be capable of handling our insane numbers.

  let result = BigInt(0);

  for (let i = s.length - 1, j = BigInt(0); i >= 0; i--, j++) {
    const charIndex = s.charCodeAt(i) - alphabet.charCodeAt(0); // We add 1 to the char index to offset the whole numbering scheme. We unpack this in
    // the baseToString() function.

    result += BigInt(1 + charIndex) * len ** j;
  }

  return result;
}
/**
 * Averages two strings, returning the midpoint between them. This is accomplished by
 * converting both to baseN numbers (where N is the alphabet's length) then averaging
 * those before re-encoding as a string.
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The midpoint between the strings, as a string.
 */


function averageBetweenStrings(a, b, alphabet = DEFAULT_ALPHABET) {
  const padN = Math.max(a.length, b.length);
  const baseA = stringToBase(alphabetPad(a, padN, alphabet), alphabet);
  const baseB = stringToBase(alphabetPad(b, padN, alphabet), alphabet);
  const avg = (baseA + baseB) / BigInt(2); // Detect integer division conflicts. This happens when two numbers are divided too close so
  // we lose a .5 precision. We need to add a padding character in these cases.

  if (avg === baseA || avg == baseB) {
    return baseToString(avg, alphabet) + alphabet[0];
  }

  return baseToString(avg, alphabet);
}
/**
 * Finds the next string using the alphabet provided. This is done by converting the
 * string to a baseN number, where N is the alphabet's length, then adding 1 before
 * converting back to a string.
 * @param {string} s The string to start at.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The string which follows the input string.
 */


function nextString(s, alphabet = DEFAULT_ALPHABET) {
  return baseToString(stringToBase(s, alphabet) + BigInt(1), alphabet);
}
/**
 * Finds the previous string using the alphabet provided. This is done by converting the
 * string to a baseN number, where N is the alphabet's length, then subtracting 1 before
 * converting back to a string.
 * @param {string} s The string to start at.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The string which precedes the input string.
 */


function prevString(s, alphabet = DEFAULT_ALPHABET) {
  return baseToString(stringToBase(s, alphabet) - BigInt(1), alphabet);
}
/**
 * Compares strings lexicographically as a sort-safe function.
 * @param {string} a The first (reference) string.
 * @param {string} b The second (compare) string.
 * @returns {number} Negative if the reference string is before the compare string;
 * positive if the reference string is after; and zero if equal.
 */


function lexicographicCompare(a, b) {
  // Dev note: this exists because I'm sad that you can use math operators on strings, so I've
  // hidden the operation in this function.
  return a < b ? -1 : a === b ? 0 : 1;
}

const collator = new Intl.Collator();
/**
 * Performant language-sensitive string comparison
 * @param a the first string to compare
 * @param b the second string to compare
 */

function compare(a, b) {
  return collator.compare(a, b);
}
/**
 * This function is similar to Object.assign() but it assigns recursively and
 * allows you to ignore nullish values from the source
 *
 * @param {Object} target
 * @param {Object} source
 * @returns the target object
 */


function recursivelyAssign(target, source, ignoreNullish = false) {
  for (const [sourceKey, sourceValue] of Object.entries(source)) {
    if (target[sourceKey] instanceof Object && sourceValue) {
      recursivelyAssign(target[sourceKey], sourceValue);
      continue;
    }

    if (sourceValue !== null && sourceValue !== undefined || !ignoreNullish) {
      target[sourceKey] = sourceValue;
      continue;
    }
  }

  return target;
}