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
 * the array.
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
            results.push(results);
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
 * Checks if the given thing is a function.
 * @param {*} value The thing to check.
 * @return {boolean} True if it is a function.
 */
module.exports.isFunction = function(value) {
    return Object.prototype.toString.call(value) == "[object Function]";
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
