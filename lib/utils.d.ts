/// <reference types="node" />
import type NodeCrypto from "crypto";
/**
 * Encode a dictionary of query parameters.
 * @param {Object} params A dict of key/values to encode e.g.
 * {"foo": "bar", "baz": "taz"}
 * @return {string} The encoded string e.g. foo=bar&baz=taz
 */
export declare function encodeParams(params: Record<string, string>): string;
export declare type QueryDict = Record<string, string | string[]>;
/**
 * Decode a query string in `application/x-www-form-urlencoded` format.
 * @param {string} query A query string to decode e.g.
 * foo=bar&via=server1&server2
 * @return {Object} The decoded object, if any keys occurred multiple times
 * then the value will be an array of strings, else it will be an array.
 * This behaviour matches Node's qs.parse but is built on URLSearchParams
 * for native web compatibility
 */
export declare function decodeParams(query: string): QueryDict;
/**
 * Encodes a URI according to a set of template variables. Variables will be
 * passed through encodeURIComponent.
 * @param {string} pathTemplate The path with template variables e.g. '/foo/$bar'.
 * @param {Object} variables The key/value pairs to replace the template
 * variables with. E.g. { "$bar": "baz" }.
 * @return {string} The result of replacing all template variables e.g. '/foo/baz'.
 */
export declare function encodeUri(pathTemplate: string, variables: Record<string, string>): string;
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
export declare function removeElement<T>(array: T[], fn: (t: T, i?: number, a?: T[]) => boolean, reverse?: boolean): any;
/**
 * Checks if the given thing is a function.
 * @param {*} value The thing to check.
 * @return {boolean} True if it is a function.
 */
export declare function isFunction(value: any): boolean;
/**
 * Checks that the given object has the specified keys.
 * @param {Object} obj The object to check.
 * @param {string[]} keys The list of keys that 'obj' must have.
 * @throws If the object is missing keys.
 */
export declare function checkObjectHasKeys(obj: object, keys: string[]): void;
/**
 * Checks that the given object has no extra keys other than the specified ones.
 * @param {Object} obj The object to check.
 * @param {string[]} allowedKeys The list of allowed key names.
 * @throws If there are extra keys.
 */
export declare function checkObjectHasNoAdditionalKeys(obj: object, allowedKeys: string[]): void;
/**
 * Deep copy the given object. The object MUST NOT have circular references and
 * MUST NOT have functions.
 * @param {Object} obj The object to deep copy.
 * @return {Object} A copy of the object without any references to the original.
 */
export declare function deepCopy<T>(obj: T): T;
/**
 * Compare two objects for equality. The objects MUST NOT have circular references.
 *
 * @param {Object} x The first object to compare.
 * @param {Object} y The second object to compare.
 *
 * @return {boolean} true if the two objects are equal
 */
export declare function deepCompare(x: any, y: any): boolean;
/**
 * Creates an array of object properties/values (entries) then
 * sorts the result by key, recursively. The input object must
 * ensure it does not have loops. If the input is not an object
 * then it will be returned as-is.
 * @param {*} obj The object to get entries of
 * @returns {Array} The entries, sorted by key.
 */
export declare function deepSortedObjectEntries(obj: any): [string, any][];
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
export declare function extend(...restParams: any[]): any;
/**
 * Inherit the prototype methods from one constructor into another. This is a
 * port of the Node.js implementation with an Object.create polyfill.
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
export declare function inherits(ctor: Function, superCtor: Function): void;
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
export declare function polyfillSuper(thisArg: any, SuperType: any, ...params: any[]): void;
/**
 * Returns whether the given value is a finite number without type-coercion
 *
 * @param {*} value the value to test
 * @return {boolean} whether or not value is a finite number without type-coercion
 */
export declare function isNumber(value: any): boolean;
/**
 * Removes zero width chars, diacritics and whitespace from the string
 * Also applies an unhomoglyph on the string, to prevent similar looking chars
 * @param {string} str the string to remove hidden characters from
 * @return {string} a string with the hidden characters removed
 */
export declare function removeHiddenChars(str: string): string;
/**
 * Removes the direction override characters from a string
 * @param {string} input
 * @returns string with chars removed
 */
export declare function removeDirectionOverrideChars(str: string): string;
export declare function normalize(str: string): string;
export declare function escapeRegExp(string: string): string;
export declare function globToRegexp(glob: string, extended?: any): string;
export declare function ensureNoTrailingSlash(url: string): string;
export declare function sleep<T>(ms: number, value?: T): Promise<T>;
export declare function isNullOrUndefined(val: any): boolean;
export interface IDeferred<T> {
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    promise: Promise<T>;
}
export declare function defer<T = void>(): IDeferred<T>;
export declare function promiseMapSeries<T>(promises: T[], fn: (t: T) => void): Promise<void>;
export declare function promiseTry<T>(fn: () => T | Promise<T>): Promise<T>;
export declare function chunkPromises<T>(fns: (() => Promise<T>)[], chunkSize: number): Promise<T[]>;
/**
 * Retries the function until it succeeds or is interrupted. The given function must return
 * a promise which throws/rejects on error, otherwise the retry will assume the request
 * succeeded. The promise chain returned will contain the successful promise. The given function
 * should always return a new promise.
 * @param {Function} promiseFn The function to call to get a fresh promise instance. Takes an
 * attempt count as an argument, for logging/debugging purposes.
 * @returns {Promise<T>} The promise for the retried operation.
 */
export declare function simpleRetryOperation<T>(promiseFn: (attempt: number) => Promise<T>): Promise<T>;
export declare function setCrypto(c: typeof NodeCrypto): void;
export declare function getCrypto(): typeof NodeCrypto;
/**
 * The default alphabet used by string averaging in this SDK. This matches
 * all usefully printable ASCII characters (0x20-0x7E, inclusive).
 */
export declare const DEFAULT_ALPHABET: string;
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
export declare function alphabetPad(s: string, n: number, alphabet?: string): string;
/**
 * Converts a baseN number to a string, where N is the alphabet's length.
 *
 * This is intended for use with string averaging.
 * @param {bigint} n The baseN number.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The baseN number encoded as a string from the alphabet.
 */
export declare function baseToString(n: bigint, alphabet?: string): string;
/**
 * Converts a string to a baseN number, where N is the alphabet's length.
 *
 * This is intended for use with string averaging.
 * @param {string} s The string to convert to a number.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {bigint} The baseN number.
 */
export declare function stringToBase(s: string, alphabet?: string): bigint;
/**
 * Averages two strings, returning the midpoint between them. This is accomplished by
 * converting both to baseN numbers (where N is the alphabet's length) then averaging
 * those before re-encoding as a string.
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The midpoint between the strings, as a string.
 */
export declare function averageBetweenStrings(a: string, b: string, alphabet?: string): string;
/**
 * Finds the next string using the alphabet provided. This is done by converting the
 * string to a baseN number, where N is the alphabet's length, then adding 1 before
 * converting back to a string.
 * @param {string} s The string to start at.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The string which follows the input string.
 */
export declare function nextString(s: string, alphabet?: string): string;
/**
 * Finds the previous string using the alphabet provided. This is done by converting the
 * string to a baseN number, where N is the alphabet's length, then subtracting 1 before
 * converting back to a string.
 * @param {string} s The string to start at.
 * @param {string} alphabet The alphabet to use as a single string.
 * @returns {string} The string which precedes the input string.
 */
export declare function prevString(s: string, alphabet?: string): string;
/**
 * Compares strings lexicographically as a sort-safe function.
 * @param {string} a The first (reference) string.
 * @param {string} b The second (compare) string.
 * @returns {number} Negative if the reference string is before the compare string;
 * positive if the reference string is after; and zero if equal.
 */
export declare function lexicographicCompare(a: string, b: string): number;
/**
 * Performant language-sensitive string comparison
 * @param a the first string to compare
 * @param b the second string to compare
 */
export declare function compare(a: string, b: string): number;
/**
 * This function is similar to Object.assign() but it assigns recursively and
 * allows you to ignore nullish values from the source
 *
 * @param {Object} target
 * @param {Object} source
 * @returns the target object
 */
export declare function recursivelyAssign(target: Object, source: Object, ignoreNullish?: boolean): any;
//# sourceMappingURL=utils.d.ts.map