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
module.exports.encodeParams = function(params) {
    let qs = "";
    for (const key in params) {
        if (!params.hasOwnProperty(key)) {
            continue;
        }
        qs += "&" + encodeURIComponent(key) + "=" +
                encodeURIComponent(params[key]);
    }
    return qs.substring(1);
};

/**
 * Encodes a URI according to a set of template variables. Variables will be
 * passed through encodeURIComponent.
 * @param {string} pathTemplate The path with template variables e.g. '/foo/$bar'.
 * @param {Object} variables The key/value pairs to replace the template
 * variables with. E.g. { "$bar": "baz" }.
 * @return {string} The result of replacing all template variables e.g. '/foo/baz'.
 */
module.exports.encodeUri = function(pathTemplate, variables) {
    for (const key in variables) {
        if (!variables.hasOwnProperty(key)) {
            continue;
        }
        pathTemplate = pathTemplate.replace(
            key, encodeURIComponent(variables[key]),
        );
    }
    return pathTemplate;
};

/**
 * Applies a map function to the given array.
 * @param {Array} array The array to apply the function to.
 * @param {Function} fn The function that will be invoked for each element in
 * the array with the signature <code>fn(element){...}</code>
 * @return {Array} A new array with the results of the function.
 */
module.exports.map = function(array, fn) {
    const results = new Array(array.length);
    for (let i = 0; i < array.length; i++) {
        results[i] = fn(array[i]);
    }
    return results;
};

/**
 * Applies a filter function to the given array.
 * @param {Array} array The array to apply the function to.
 * @param {Function} fn The function that will be invoked for each element in
 * the array. It should return true to keep the element. The function signature
 * looks like <code>fn(element, index, array){...}</code>.
 * @return {Array} A new array with the results of the function.
 */
module.exports.filter = function(array, fn) {
    const results = [];
    for (let i = 0; i < array.length; i++) {
        if (fn(array[i], i, array)) {
            results.push(array[i]);
        }
    }
    return results;
};

/**
 * Get the keys for an object. Same as <code>Object.keys()</code>.
 * @param {Object} obj The object to get the keys for.
 * @return {string[]} The keys of the object.
 */
module.exports.keys = function(obj) {
    const keys = [];
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) {
            continue;
        }
        keys.push(key);
    }
    return keys;
};

/**
 * Get the values for an object.
 * @param {Object} obj The object to get the values for.
 * @return {Array<*>} The values of the object.
 */
module.exports.values = function(obj) {
    const values = [];
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) {
            continue;
        }
        values.push(obj[key]);
    }
    return values;
};

/**
 * Invoke a function for each item in the array.
 * @param {Array} array The array.
 * @param {Function} fn The function to invoke for each element. Has the
 * function signature <code>fn(element, index)</code>.
 */
module.exports.forEach = function(array, fn) {
    for (let i = 0; i < array.length; i++) {
        fn(array[i], i);
    }
};

/**
 * The findElement() method returns a value in the array, if an element in the array
 * satisfies (returns true) the provided testing function. Otherwise undefined
 * is returned.
 * @param {Array} array The array.
 * @param {Function} fn Function to execute on each value in the array, with the
 * function signature <code>fn(element, index, array)</code>
 * @param {boolean} reverse True to search in reverse order.
 * @return {*} The first value in the array which returns <code>true</code> for
 * the given function.
 */
module.exports.findElement = function(array, fn, reverse) {
    let i;
    if (reverse) {
        for (i = array.length - 1; i >= 0; i--) {
            if (fn(array[i], i, array)) {
                return array[i];
            }
        }
    } else {
        for (i = 0; i < array.length; i++) {
            if (fn(array[i], i, array)) {
                return array[i];
            }
        }
    }
};

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
module.exports.removeElement = function(array, fn, reverse) {
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
};

/**
 * Checks if the given thing is a function.
 * @param {*} value The thing to check.
 * @return {boolean} True if it is a function.
 */
module.exports.isFunction = function(value) {
    return Object.prototype.toString.call(value) == "[object Function]";
};

/**
 * Checks if the given thing is an array.
 * @param {*} value The thing to check.
 * @return {boolean} True if it is an array.
 */
module.exports.isArray = function(value) {
    return Array.isArray ? Array.isArray(value) :
        Boolean(value && value.constructor === Array);
};

/**
 * Checks that the given object has the specified keys.
 * @param {Object} obj The object to check.
 * @param {string[]} keys The list of keys that 'obj' must have.
 * @throws If the object is missing keys.
 */
module.exports.checkObjectHasKeys = function(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
        if (!obj.hasOwnProperty(keys[i])) {
            throw new Error("Missing required key: " + keys[i]);
        }
    }
};

/**
 * Checks that the given object has no extra keys other than the specified ones.
 * @param {Object} obj The object to check.
 * @param {string[]} allowedKeys The list of allowed key names.
 * @throws If there are extra keys.
 */
module.exports.checkObjectHasNoAdditionalKeys = function(obj, allowedKeys) {
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) {
            continue;
        }
        if (allowedKeys.indexOf(key) === -1) {
            throw new Error("Unknown key: " + key);
        }
    }
};

/**
 * Deep copy the given object. The object MUST NOT have circular references and
 * MUST NOT have functions.
 * @param {Object} obj The object to deep copy.
 * @return {Object} A copy of the object without any references to the original.
 */
module.exports.deepCopy = function(obj) {
    return JSON.parse(JSON.stringify(obj));
};

/**
 * Compare two objects for equality. The objects MUST NOT have circular references.
 *
 * @param {Object} x The first object to compare.
 * @param {Object} y The second object to compare.
 *
 * @return {boolean} true if the two objects are equal
 */
const deepCompare = module.exports.deepCompare = function(x, y) {
    // Inspired by
    // http://stackoverflow.com/questions/1068834/object-comparison-in-javascript#1144249

    // Compare primitives and functions.
    // Also check if both arguments link to the same object.
    if (x === y) {
        return true;
    }

    if (typeof x !== typeof y) {
        return false;
    }

    // special-case NaN (since NaN !== NaN)
    if (typeof x === 'number' && isNaN(x) && isNaN(y)) {
         return true;
    }

    // special-case null (since typeof null == 'object', but null.constructor
    // throws)
    if (x === null || y === null) {
        return x === y;
    }

    // everything else is either an unequal primitive, or an object
    if (!(x instanceof Object)) {
        return false;
    }

    // check they are the same type of object
    if (x.constructor !== y.constructor || x.prototype !== y.prototype) {
        return false;
    }

    // special-casing for some special types of object
    if (x instanceof RegExp || x instanceof Date) {
        return x.toString() === y.toString();
    }

    // the object algorithm works for Array, but it's sub-optimal.
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
        }

        // finally, compare each of x's keys with y
        for (p in y) {
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
};

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
module.exports.extend = function() {
    const target = arguments[0] || {};
    for (let i = 1; i < arguments.length; i++) {
        const source = arguments[i];
        for (const propName in source) { // eslint-disable-line guard-for-in
            target[propName] = source[propName];
        }
    }
    return target;
};

/**
 * Run polyfills to add Array.map and Array.filter if they are missing.
 */
module.exports.runPolyfills = function() {
    //                Array.prototype.filter
    // ========================================================
    // SOURCE:
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter
    if (!Array.prototype.filter) {
      Array.prototype.filter = function(fun/*, thisArg*/) {
        if (this === void 0 || this === null) {
          throw new TypeError();
        }

        const t = Object(this);
        const len = t.length >>> 0;
        if (typeof fun !== 'function') {
          throw new TypeError();
        }

        const res = [];
        const thisArg = arguments.length >= 2 ? arguments[1] : void 0;
        for (let i = 0; i < len; i++) {
          if (i in t) {
            const val = t[i];

            // NOTE: Technically this should Object.defineProperty at
            //       the next index, as push can be affected by
            //       properties on Object.prototype and Array.prototype.
            //       But that method's new, and collisions should be
            //       rare, so use the more-compatible alternative.
            if (fun.call(thisArg, val, i, t)) {
              res.push(val);
            }
          }
        }

        return res;
      };
    }

    //                Array.prototype.map
    // ========================================================
    // SOURCE:
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map
    // Production steps of ECMA-262, Edition 5, 15.4.4.19
    // Reference: http://es5.github.io/#x15.4.4.19
    if (!Array.prototype.map) {
      Array.prototype.map = function(callback, thisArg) {
        let T, k;

        if (this === null || this === undefined) {
          throw new TypeError(' this is null or not defined');
        }

        // 1. Let O be the result of calling ToObject passing the |this|
        //    value as the argument.
        const O = Object(this);

        // 2. Let lenValue be the result of calling the Get internal
        //    method of O with the argument "length".
        // 3. Let len be ToUint32(lenValue).
        const len = O.length >>> 0;

        // 4. If IsCallable(callback) is false, throw a TypeError exception.
        // See: http://es5.github.com/#x9.11
        if (typeof callback !== 'function') {
          throw new TypeError(callback + ' is not a function');
        }

        // 5. If thisArg was supplied, let T be thisArg; else let T be undefined.
        if (arguments.length > 1) {
          T = thisArg;
        }

        // 6. Let A be a new array created as if by the expression new Array(len)
        //    where Array is the standard built-in constructor with that name and
        //    len is the value of len.
        const A = new Array(len);

        // 7. Let k be 0
        k = 0;

        // 8. Repeat, while k < len
        while (k < len) {
          var kValue, mappedValue;

          // a. Let Pk be ToString(k).
          //   This is implicit for LHS operands of the in operator
          // b. Let kPresent be the result of calling the HasProperty internal
          //    method of O with argument Pk.
          //   This step can be combined with c
          // c. If kPresent is true, then
          if (k in O) {
            // i. Let kValue be the result of calling the Get internal
            //    method of O with argument Pk.
            kValue = O[k];

            // ii. Let mappedValue be the result of calling the Call internal
            //     method of callback with T as the this value and argument
            //     list containing kValue, k, and O.
            mappedValue = callback.call(T, kValue, k, O);

            // iii. Call the DefineOwnProperty internal method of A with arguments
            // Pk, Property Descriptor
            // { Value: mappedValue,
            //   Writable: true,
            //   Enumerable: true,
            //   Configurable: true },
            // and false.

            // In browsers that support Object.defineProperty, use the following:
            // Object.defineProperty(A, k, {
            //   value: mappedValue,
            //   writable: true,
            //   enumerable: true,
            //   configurable: true
            // });

            // For best browser support, use the following:
            A[k] = mappedValue;
          }
          // d. Increase k by 1.
          k++;
        }

        // 9. return A
        return A;
      };
    }

    //                Array.prototype.forEach
    // ========================================================
    // SOURCE:
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach
    // Production steps of ECMA-262, Edition 5, 15.4.4.18
    // Reference: http://es5.github.io/#x15.4.4.18
    if (!Array.prototype.forEach) {
      Array.prototype.forEach = function(callback, thisArg) {
        let T, k;

        if (this === null || this === undefined) {
          throw new TypeError(' this is null or not defined');
        }

        // 1. Let O be the result of calling ToObject passing the |this| value as the
        // argument.
        const O = Object(this);

        // 2. Let lenValue be the result of calling the Get internal method of O with the
        // argument "length".
        // 3. Let len be ToUint32(lenValue).
        const len = O.length >>> 0;

        // 4. If IsCallable(callback) is false, throw a TypeError exception.
        // See: http://es5.github.com/#x9.11
        if (typeof callback !== "function") {
          throw new TypeError(callback + ' is not a function');
        }

        // 5. If thisArg was supplied, let T be thisArg; else let T be undefined.
        if (arguments.length > 1) {
          T = thisArg;
        }

        // 6. Let k be 0
        k = 0;

        // 7. Repeat, while k < len
        while (k < len) {
          var kValue;

          // a. Let Pk be ToString(k).
          //   This is implicit for LHS operands of the in operator
          // b. Let kPresent be the result of calling the HasProperty internal
          //    method of O with
          //    argument Pk.
          //   This step can be combined with c
          // c. If kPresent is true, then
          if (k in O) {
            // i. Let kValue be the result of calling the Get internal method of O with
            // argument Pk
            kValue = O[k];

            // ii. Call the Call internal method of callback with T as the this value and
            // argument list containing kValue, k, and O.
            callback.call(T, kValue, k, O);
          }
          // d. Increase k by 1.
          k++;
        }
        // 8. return undefined
      };
    }
};

/**
 * Inherit the prototype methods from one constructor into another. This is a
 * port of the Node.js implementation with an Object.create polyfill.
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
module.exports.inherits = function(ctor, superCtor) {
    // Add Object.create polyfill for IE8
    // Source:
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript
    // /Reference/Global_Objects/Object/create#Polyfill
    if (typeof Object.create != 'function') {
      // Production steps of ECMA-262, Edition 5, 15.2.3.5
      // Reference: http://es5.github.io/#x15.2.3.5
      Object.create = (function() {
        // To save on memory, use a shared constructor
        function Temp() {}

        // make a safe reference to Object.prototype.hasOwnProperty
        const hasOwn = Object.prototype.hasOwnProperty;

        return function(O) {
          // 1. If Type(O) is not Object or Null throw a TypeError exception.
          if (typeof O != 'object') {
            throw new TypeError('Object prototype may only be an Object or null');
          }

          // 2. Let obj be the result of creating a new object as if by the
          //    expression new Object() where Object is the standard built-in
          //    constructor with that name
          // 3. Set the [[Prototype]] internal property of obj to O.
          Temp.prototype = O;
          const obj = new Temp();
          Temp.prototype = null; // Let's not keep a stray reference to O...

          // 4. If the argument Properties is present and not undefined, add
          //    own properties to obj as if by calling the standard built-in
          //    function Object.defineProperties with arguments obj and
          //    Properties.
          if (arguments.length > 1) {
            // Object.defineProperties does ToObject on its first argument.
            const Properties = Object(arguments[1]);
            for (const prop in Properties) {
              if (hasOwn.call(Properties, prop)) {
                obj[prop] = Properties[prop];
              }
            }
          }

          // 5. Return obj
          return obj;
        };
      })();
    }
    // END polyfill

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
            configurable: true,
        },
    });
};

/**
 * Returns whether the given value is a finite number without type-coercion
 *
 * @param {*} value the value to test
 * @return {boolean} whether or not value is a finite number without type-coercion
 */
module.exports.isNumber = function(value) {
    return typeof value === 'number' && isFinite(value);
};

/**
 * Removes zero width chars, diacritics and whitespace from the string
 * @param {string} str the string to remove hidden characters from
 * @return {string} a string with the hidden characters removed
 */
module.exports.removeHiddenChars = function(str) {
    return str.normalize('NFD').replace(removeHiddenCharsRegex, '');
};
const removeHiddenCharsRegex = /[\u200B-\u200D\u0300-\u036f\uFEFF\s]/g;

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
module.exports.escapeRegExp = escapeRegExp;

module.exports.globToRegexp = function(glob, extended) {
    extended = typeof(extended) === 'boolean' ? extended : true;
    // From
    // https://github.com/matrix-org/synapse/blob/abbee6b29be80a77e05730707602f3bbfc3f38cb/synapse/push/__init__.py#L132
    // Because micromatch is about 130KB with dependencies,
    // and minimatch is not much better.
    let pat = escapeRegExp(glob);
    pat = pat.replace(/\\\*/g, '.*');
    pat = pat.replace(/\?/g, '.');
    if (extended) {
        pat = pat.replace(/\\\[(!|)(.*)\\]/g, function(match, p1, p2, offset, string) {
            const first = p1 && '^' || '';
            const second = p2.replace(/\\\-/, '-');
            return '[' + first + second + ']';
        });
    }
    return pat;
};
