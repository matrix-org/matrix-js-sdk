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

import unhomoglyph from 'unhomoglyph';

/**
 * Encode a dictionary of query parameters.
 * @param {Object} params A dict of key/values to encode e.g.
 * {"foo": "bar", "baz": "taz"}
 * @return {string} The encoded string e.g. foo=bar&baz=taz
 */
export function encodeParams(params) {
    let qs = "";
    for (const key in params) {
        if (!params.hasOwnProperty(key)) {
            continue;
        }
        qs += "&" + encodeURIComponent(key) + "=" +
                encodeURIComponent(params[key]);
    }
    return qs.substring(1);
}

/**
 * Encodes a URI according to a set of template variables. Variables will be
 * passed through encodeURIComponent.
 * @param {string} pathTemplate The path with template variables e.g. '/foo/$bar'.
 * @param {Object} variables The key/value pairs to replace the template
 * variables with. E.g. { "$bar": "baz" }.
 * @return {string} The result of replacing all template variables e.g. '/foo/baz'.
 */
export function encodeUri(pathTemplate, variables) {
    for (const key in variables) {
        if (!variables.hasOwnProperty(key)) {
            continue;
        }
        pathTemplate = pathTemplate.replace(
            key, encodeURIComponent(variables[key]),
        );
    }
    return pathTemplate;
}

/**
 * Applies a map function to the given array.
 * @param {Array} array The array to apply the function to.
 * @param {Function} fn The function that will be invoked for each element in
 * the array with the signature <code>fn(element){...}</code>
 * @return {Array} A new array with the results of the function.
 */
export function map(array, fn) {
    const results = new Array(array.length);
    for (let i = 0; i < array.length; i++) {
        results[i] = fn(array[i]);
    }
    return results;
}

/**
 * Applies a filter function to the given array.
 * @param {Array} array The array to apply the function to.
 * @param {Function} fn The function that will be invoked for each element in
 * the array. It should return true to keep the element. The function signature
 * looks like <code>fn(element, index, array){...}</code>.
 * @return {Array} A new array with the results of the function.
 */
export function filter(array, fn) {
    const results = [];
    for (let i = 0; i < array.length; i++) {
        if (fn(array[i], i, array)) {
            results.push(array[i]);
        }
    }
    return results;
}

/**
 * Get the keys for an object. Same as <code>Object.keys()</code>.
 * @param {Object} obj The object to get the keys for.
 * @return {string[]} The keys of the object.
 */
export function keys(obj) {
    const keys = [];
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) {
            continue;
        }
        keys.push(key);
    }
    return keys;
}

/**
 * Get the values for an object.
 * @param {Object} obj The object to get the values for.
 * @return {Array<*>} The values of the object.
 */
export function values(obj) {
    const values = [];
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) {
            continue;
        }
        values.push(obj[key]);
    }
    return values;
}

/**
 * Invoke a function for each item in the array.
 * @param {Array} array The array.
 * @param {Function} fn The function to invoke for each element. Has the
 * function signature <code>fn(element, index)</code>.
 */
export function forEach(array, fn) {
    for (let i = 0; i < array.length; i++) {
        fn(array[i], i);
    }
}

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
export function findElement(array, fn, reverse) {
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
export function removeElement(array, fn, reverse) {
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
export function isFunction(value) {
    return Object.prototype.toString.call(value) == "[object Function]";
}

/**
 * Checks if the given thing is an array.
 * @param {*} value The thing to check.
 * @return {boolean} True if it is an array.
 */
export function isArray(value) {
    return Array.isArray ? Array.isArray(value) :
        Boolean(value && value.constructor === Array);
}

/**
 * Checks that the given object has the specified keys.
 * @param {Object} obj The object to check.
 * @param {string[]} keys The list of keys that 'obj' must have.
 * @throws If the object is missing keys.
 */
export function checkObjectHasKeys(obj, keys) {
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
export function checkObjectHasNoAdditionalKeys(obj, allowedKeys) {
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
export function deepCopy(obj) {
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
export function deepCompare(x, y) {
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
        for (p in y) { // eslint-disable-line guard-for-in
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
export function extend() {
    const target = arguments[0] || {};
    for (let i = 1; i < arguments.length; i++) {
        const source = arguments[i];
        for (const propName in source) { // eslint-disable-line guard-for-in
            target[propName] = source[propName];
        }
    }
    return target;
}

/**
 * Returns whether the given value is a finite number without type-coercion
 *
 * @param {*} value the value to test
 * @return {boolean} whether or not value is a finite number without type-coercion
 */
export function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
}

/**
 * Removes zero width chars, diacritics and whitespace from the string
 * Also applies an unhomoglyph on the string, to prevent similar looking chars
 * @param {string} str the string to remove hidden characters from
 * @return {string} a string with the hidden characters removed
 */
export function removeHiddenChars(str) {
    return unhomoglyph(str.normalize('NFD').replace(removeHiddenCharsRegex, ''));
}

// Regex matching bunch of unicode control characters and otherwise misleading/invisible characters.
// Includes:
// various width spaces U+2000 - U+200D
// LTR and RTL marks U+200E and U+200F
// LTR/RTL and other directional formatting marks U+202A - U+202F
// Combining characters U+0300 - U+036F
// Zero width no-break space (BOM) U+FEFF
const removeHiddenCharsRegex = /[\u2000-\u200F\u202A-\u202F\u0300-\u036f\uFEFF\s]/g;

export function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegexp(glob, extended) {
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
            const second = p2.replace(/\\-/, '-');
            return '[' + first + second + ']';
        });
    }
    return pat;
}

export function ensureNoTrailingSlash(url) {
    if (url && url.endsWith("/")) {
        return url.substr(0, url.length - 1);
    } else {
        return url;
    }
}

// Returns a promise which resolves with a given value after the given number of ms
export function sleep(ms, value) {
    return new Promise((resolve => {
        setTimeout(resolve, ms, value);
    }));
}

export function isNullOrUndefined(val) {
    return val === null || val === undefined;
}

// Returns a Deferred
export function defer() {
    let resolve;
    let reject;

    const promise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });

    return {resolve, reject, promise};
}

export async function promiseMapSeries(promises, fn) {
    for (const o of await promises) {
        await fn(await o);
    }
}

export function promiseTry(fn) {
    return new Promise((resolve) => resolve(fn()));
}
