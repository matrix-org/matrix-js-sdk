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

import unhomoglyph from "unhomoglyph";
import promiseRetry from "p-retry";

import type * as NodeCrypto from "crypto";
import { MatrixEvent } from ".";
import { M_TIMESTAMP } from "./@types/location";

/**
 * Encode a dictionary of query parameters.
 * Omits any undefined/null values.
 * @param {Object} params A dict of key/values to encode e.g.
 * {"foo": "bar", "baz": "taz"}
 * @return {string} The encoded string e.g. foo=bar&baz=taz
 */
export function encodeParams(params: Record<string, string | number | boolean>): string {
    const searchParams = new URLSearchParams();
    for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
            searchParams.set(key, String(val));
        }
    }
    return searchParams.toString();
}

export type QueryDict = Record<string, string | string[]>;

/**
 * Decode a query string in `application/x-www-form-urlencoded` format.
 * @param {string} query A query string to decode e.g.
 * foo=bar&via=server1&server2
 * @return {Object} The decoded object, if any keys occurred multiple times
 * then the value will be an array of strings, else it will be an array.
 * This behaviour matches Node's qs.parse but is built on URLSearchParams
 * for native web compatibility
 */
export function decodeParams(query: string): QueryDict {
    const o: QueryDict = {};
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
export function encodeUri(pathTemplate: string,
    variables: Record<string, string>): string {
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
 * The removeElement() method removes the first element in the array that
 * satisfies (returns true) the provided testing function.
 * @param {Array} array The array.
 * @param {Function} fn Function to execute on each value in the array, with the
 * function signature <code>fn(element, index, array)</code>. Return true to
 * remove this element and break.
 * @param {boolean} reverse True to search in reverse order.
 * @return {boolean} True if an element was removed.
 */
export function removeElement<T>(
    array: T[],
    fn: (t: T, i?: number, a?: T[]) => boolean,
    reverse?: boolean,
): boolean {
    let i: number;
    if (reverse) {
        for (i = array.length - 1; i >= 0; i--) {
            if (fn(array[i], i, array)) {
                array.splice(i, 1);
                return true;
            }
        }
    } else {
        for (i = 0; i < array.length; i++) {
            if (fn(array[i], i, array)) {
                array.splice(i, 1);
                return true;
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
export function isFunction(value: any) {
    return Object.prototype.toString.call(value) === "[object Function]";
}

/**
 * Checks that the given object has the specified keys.
 * @param {Object} obj The object to check.
 * @param {string[]} keys The list of keys that 'obj' must have.
 * @throws If the object is missing keys.
 */
// note using 'keys' here would shadow the 'keys' function defined above
export function checkObjectHasKeys(obj: object, keys: string[]) {
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
export function checkObjectHasNoAdditionalKeys(obj: object, allowedKeys: string[]): void {
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
export function deepCopy<T>(obj: T): T {
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
export function deepCompare(x: any, y: any): boolean {
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

// Dev note: This returns a tuple, but jsdoc doesn't like that. https://github.com/jsdoc/jsdoc/issues/1703
/**
 * Creates an array of object properties/values (entries) then
 * sorts the result by key, recursively. The input object must
 * ensure it does not have loops. If the input is not an object
 * then it will be returned as-is.
 * @param {*} obj The object to get entries of
 * @returns {Array} The entries, sorted by key.
 */
export function deepSortedObjectEntries(obj: any): [string, any][] {
    if (typeof(obj) !== "object") return obj;

    // Apparently these are object types...
    if (obj === null || obj === undefined || Array.isArray(obj)) return obj;

    const pairs: [string, any][] = [];
    for (const [k, v] of Object.entries(obj)) {
        pairs.push([k, deepSortedObjectEntries(v)]);
    }

    // lexicographicCompare is faster than localeCompare, so let's use that.
    pairs.sort((a, b) => lexicographicCompare(a[0], b[0]));

    return pairs;
}

/**
 * Inherit the prototype methods from one constructor into another. This is a
 * port of the Node.js implementation with an Object.create polyfill.
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
export function inherits(ctor: Function, superCtor: Function) {
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
    (ctor as any).super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            enumerable: false,
            writable: true,
            configurable: true,
        },
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
export function polyfillSuper(thisArg: any, SuperType: any, ...params: any[]) {
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
export function isNumber(value: any): boolean {
    return typeof value === 'number' && isFinite(value);
}

/**
 * Removes zero width chars, diacritics and whitespace from the string
 * Also applies an unhomoglyph on the string, to prevent similar looking chars
 * @param {string} str the string to remove hidden characters from
 * @return {string} a string with the hidden characters removed
 */
export function removeHiddenChars(str: string): string {
    if (typeof str === "string") {
        return unhomoglyph(str.normalize('NFD').replace(removeHiddenCharsRegex, ''));
    }
    return "";
}

/**
 * Removes the direction override characters from a string
 * @param {string} input
 * @returns string with chars removed
 */
export function removeDirectionOverrideChars(str: string): string {
    if (typeof str === "string") {
        return str.replace(/[\u202d-\u202e]/g, '');
    }
    return "";
}

export function normalize(str: string): string {
    // Note: we have to match the filter with the removeHiddenChars() because the
    // function strips spaces and other characters (M becomes RN for example, in lowercase).
    return removeHiddenChars(str.toLowerCase())
        // Strip all punctuation
        .replace(/[\\'!"#$%&()*+,\-./:;<=>?@[\]^_`{|}~\u2000-\u206f\u2e00-\u2e7f]/g, "")
        // We also doubly convert to lowercase to work around oddities of the library.
        .toLowerCase();
}

// Regex matching bunch of unicode control characters and otherwise misleading/invisible characters.
// Includes:
// various width spaces U+2000 - U+200D
// LTR and RTL marks U+200E and U+200F
// LTR/RTL and other directional formatting marks U+202A - U+202F
// Arabic Letter RTL mark U+061C
// Combining characters U+0300 - U+036F
// Zero width no-break space (BOM) U+FEFF
// eslint-disable-next-line no-misleading-character-class
const removeHiddenCharsRegex = /[\u2000-\u200F\u202A-\u202F\u0300-\u036F\uFEFF\u061C\s]/g;

export function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegexp(glob: string, extended?: any): string {
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

export function ensureNoTrailingSlash(url: string): string {
    if (url && url.endsWith("/")) {
        return url.slice(0, -1);
    } else {
        return url;
    }
}

// Returns a promise which resolves with a given value after the given number of ms
export function sleep<T>(ms: number, value?: T): Promise<T> {
    return new Promise((resolve => {
        setTimeout(resolve, ms, value);
    }));
}

export function isNullOrUndefined(val: any): boolean {
    return val === null || val === undefined;
}

export interface IDeferred<T> {
    resolve: (value: T | Promise<T>) => void;
    reject: (reason?: any) => void;
    promise: Promise<T>;
}

// Returns a Deferred
export function defer<T = void>(): IDeferred<T> {
    let resolve;
    let reject;

    const promise = new Promise<T>((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });

    return { resolve, reject, promise };
}

export async function promiseMapSeries<T>(
    promises: Array<T | Promise<T>>,
    fn: (t: T) => Promise<unknown> | void, // if async/promise we don't care about the type as we only await resolution
): Promise<void> {
    for (const o of promises) {
        await fn(await o);
    }
}

export function promiseTry<T>(fn: () => T | Promise<T>): Promise<T> {
    return Promise.resolve(fn());
}

// Creates and awaits all promises, running no more than `chunkSize` at the same time
export async function chunkPromises<T>(fns: (() => Promise<T>)[], chunkSize: number): Promise<T[]> {
    const results: T[] = [];
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
export function simpleRetryOperation<T>(promiseFn: (attempt: number) => Promise<T>): Promise<T> {
    return promiseRetry((attempt: number) => {
        return promiseFn(attempt);
    }, {
        forever: true,
        factor: 2,
        minTimeout: 3000, // ms
        maxTimeout: 15000, // ms
    });
}

// We need to be able to access the Node.js crypto library from within the
// Matrix SDK without needing to `require("crypto")`, which will fail in
// browsers.  So `index.ts` will call `setCrypto` to store it, and when we need
// it, we can call `getCrypto`.
let crypto: typeof NodeCrypto;

export function setCrypto(c: typeof NodeCrypto) {
    crypto = c;
}

export function getCrypto(): typeof NodeCrypto {
    return crypto;
}

// String averaging inspired by https://stackoverflow.com/a/2510816
// Dev note: We make the alphabet a string because it's easier to write syntactically
// than arrays. Thankfully, strings implement the useful parts of the Array interface
// anyhow.

/**
 * The default alphabet used by string averaging in this SDK. This matches
 * all usefully printable ASCII characters (0x20-0x7E, inclusive).
 */
export const DEFAULT_ALPHABET = (() => {
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
export function alphabetPad(s: string, n: number, alphabet = DEFAULT_ALPHABET): string {
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
export function baseToString(n: bigint, alphabet = DEFAULT_ALPHABET): string {
    // Developer note: the stringToBase() function offsets the character set by 1 so that repeated
    // characters (ie: "aaaaaa" in a..z) don't come out as zero. We have to reverse this here as
    // otherwise we'll be wrong in our conversion. Undoing a +1 before an exponent isn't very fun
    // though, so we rely on a lengthy amount of `x - 1` and integer division rules to reach a
    // sane state. This also means we have to do rollover detection: see below.

    const len = BigInt(alphabet.length);
    if (n <= len) {
        return alphabet[Number(n) - 1] ?? "";
    }

    let d = n / len;
    let r = Number(n % len) - 1;

    // Rollover detection: if the remainder is negative, it means that the string needs
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
export function stringToBase(s: string, alphabet = DEFAULT_ALPHABET): bigint {
    const len = BigInt(alphabet.length);

    // In our conversion to baseN we do a couple performance optimizations to avoid using
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
        const charIndex = s.charCodeAt(i) - alphabet.charCodeAt(0);

        // We add 1 to the char index to offset the whole numbering scheme. We unpack this in
        // the baseToString() function.
        result += BigInt(1 + charIndex) * (len ** j);
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
export function averageBetweenStrings(a: string, b: string, alphabet = DEFAULT_ALPHABET): string {
    const padN = Math.max(a.length, b.length);
    const baseA = stringToBase(alphabetPad(a, padN, alphabet), alphabet);
    const baseB = stringToBase(alphabetPad(b, padN, alphabet), alphabet);
    const avg = (baseA + baseB) / BigInt(2);

    // Detect integer division conflicts. This happens when two numbers are divided too close so
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
export function nextString(s: string, alphabet = DEFAULT_ALPHABET): string {
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
export function prevString(s: string, alphabet = DEFAULT_ALPHABET): string {
    return baseToString(stringToBase(s, alphabet) - BigInt(1), alphabet);
}

/**
 * Compares strings lexicographically as a sort-safe function.
 * @param {string} a The first (reference) string.
 * @param {string} b The second (compare) string.
 * @returns {number} Negative if the reference string is before the compare string;
 * positive if the reference string is after; and zero if equal.
 */
export function lexicographicCompare(a: string, b: string): number {
    // Dev note: this exists because I'm sad that you can use math operators on strings, so I've
    // hidden the operation in this function.
    if (a < b) {
        return -1;
    } else if (a > b) {
        return 1;
    } else {
        return 0;
    }
}

const collator = new Intl.Collator();
/**
 * Performant language-sensitive string comparison
 * @param a the first string to compare
 * @param b the second string to compare
 */
export function compare(a: string, b: string): number {
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
export function recursivelyAssign(target: Object, source: Object, ignoreNullish = false): any {
    for (const [sourceKey, sourceValue] of Object.entries(source)) {
        if (target[sourceKey] instanceof Object && sourceValue) {
            recursivelyAssign(target[sourceKey], sourceValue);
            continue;
        }
        if ((sourceValue !== null && sourceValue !== undefined) || !ignoreNullish) {
            target[sourceKey] = sourceValue;
            continue;
        }
    }
    return target;
}

function getContentTimestampWithFallback(event: MatrixEvent): number {
    return M_TIMESTAMP.findIn<number>(event.getContent()) ?? -1;
}

/**
 * Sort events by their content m.ts property
 * Latest timestamp first
 */
export function sortEventsByLatestContentTimestamp(left: MatrixEvent, right: MatrixEvent): number {
    return getContentTimestampWithFallback(right) - getContentTimestampWithFallback(left);
}
