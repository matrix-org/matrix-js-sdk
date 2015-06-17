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
    var qs = "";
    for (var key in params) {
        if (!params.hasOwnProperty(key)) { continue; }
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
    for (var key in variables) {
        if (!variables.hasOwnProperty(key)) { continue; }
        pathTemplate = pathTemplate.replace(
            key, encodeURIComponent(variables[key])
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
    var results = new Array(array.length);
    for (var i = 0; i < array.length; i++) {
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
    var results = [];
    for (var i = 0; i < array.length; i++) {
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
    var keys = [];
    for (var key in obj) {
        if (!obj.hasOwnProperty(key)) { continue; }
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
    var values = [];
    for (var key in obj) {
        if (!obj.hasOwnProperty(key)) { continue; }
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
    for (var i = 0; i < array.length; i++) {
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
    var i;
    if (reverse) {
        for (i = array.length - 1; i >= 0; i--) {
            if (fn(array[i], i, array)) {
                return array[i];
            }
        }
    }
    else {
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
 */
module.exports.removeElement = function(array, fn, reverse) {
    var i;
    if (reverse) {
        for (i = array.length - 1; i >= 0; i--) {
            if (fn(array[i], i, array)) {
                array.splice(i, 1);
                return; }
        }
    }
    else {
        for (i = 0; i < array.length; i++) {
            if (fn(array[i], i, array)) {
                array.splice(i, 1);
                return;
            }
        }
    }
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
    return Boolean(value && value.constructor === Array);
};

/**
 * Checks that the given object has the specified keys.
 * @param {Object} obj The object to check.
 * @param {string[]} keys The list of keys that 'obj' must have.
 * @throws If the object is missing keys.
 */
module.exports.checkObjectHasKeys = function(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
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
    for (var key in obj) {
        if (!obj.hasOwnProperty(key)) { continue; }
        if (allowedKeys.indexOf(key) === -1) {
            throw new Error("Unknown key: " + key);
        }
    }
};

/**
 * Assigns all the properties in src to dst. If these properties are Objects,
 * then both src and dst will refer to the same thing.
 * @param {Object} src The object to copy properties from.
 * @param {Object} dst The object to write properties to.
 */
module.exports.shallowCopy = function(src, dst) {
    for (var i in src) {
        if (src.hasOwnProperty(i)) {
            dst[i] = src[i];
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
        var hasOwn = Object.prototype.hasOwnProperty;

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
          var obj = new Temp();
          Temp.prototype = null; // Let's not keep a stray reference to O...

          // 4. If the argument Properties is present and not undefined, add
          //    own properties to obj as if by calling the standard built-in
          //    function Object.defineProperties with arguments obj and
          //    Properties.
          if (arguments.length > 1) {
            // Object.defineProperties does ToObject on its first argument.
            var Properties = Object(arguments[1]);
            for (var prop in Properties) {
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
            configurable: true
        }
    });
};
